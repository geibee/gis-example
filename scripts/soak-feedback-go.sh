#!/usr/bin/env bash
# Go-only抽出物でlease/cursor/idempotencyを継続検証し、PostgreSQL再起動からの回復を記録する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

duration_text=24h
interval_seconds=30
fault_every=20
output=""

usage() {
  echo "usage: scripts/soak-feedback-go.sh --output <new-summary.json> [--duration <Ns|Nm|Nh>] [--interval-seconds <N>] [--fault-every <N>]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) [[ $# -ge 2 ]] || usage; output=$2; shift 2 ;;
    --duration) [[ $# -ge 2 ]] || usage; duration_text=$2; shift 2 ;;
    --interval-seconds) [[ $# -ge 2 ]] || usage; interval_seconds=$2; shift 2 ;;
    --fault-every) [[ $# -ge 2 ]] || usage; fault_every=$2; shift 2 ;;
    *) usage ;;
  esac
done

fail() { echo "[feedback-go-soak] FAIL: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "dockerが見つかりません"
command -v go >/dev/null 2>&1 || fail "Goが見つかりません"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sumが見つかりません"
[[ -n "$output" ]] || usage
[[ ! -e "$output" ]] || fail "出力先は新規fileを指定してください: $output"
[[ -d "$(dirname "$output")" ]] || fail "出力先の親directoryがありません: $(dirname "$output")"
[[ ! -d apps/feedback-service ]] || fail "--go-onlyで生成した抽出repositoryから実行してください"
[[ -f apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql ]] ||
  fail "--go-onlyで生成した抽出repositoryから実行してください"
[[ "$interval_seconds" =~ ^[0-9]+$ ]] || fail "--interval-secondsは0以上の整数です"
[[ "$fault_every" =~ ^[1-9][0-9]*$ ]] || fail "--fault-everyは正の整数です"

[[ "$duration_text" =~ ^([1-9][0-9]*)([smh])$ ]] ||
  fail "--durationは正の整数とs、m、hの組合せです"
duration_amount=${BASH_REMATCH[1]}
case "${BASH_REMATCH[2]}" in
  s) duration_seconds=$duration_amount ;;
  m) duration_seconds=$((duration_amount * 60)) ;;
  h) duration_seconds=$((duration_amount * 3600)) ;;
esac

export GOTOOLCHAIN=go1.26.5
[[ "$(go env GOVERSION)" == "go1.26.5" ]] || fail "Go 1.26.5が必要です"

evidence_prefix=${output%.json}
[[ "$evidence_prefix" != "$output" ]] || evidence_prefix=$output
iterations_file="${evidence_prefix}.jsonl"
test_log="${evidence_prefix}.test.log"
for evidence_file in "$iterations_file" "$test_log"; do
  [[ ! -e "$evidence_file" ]] || fail "証跡fileは新規pathが必要です: $evidence_file"
done

container="feedback-go-soak-$$-$RANDOM"
database_password="feedback-soak-$RANDOM-$RANDOM-$(date +%s)"
started_epoch=$(date +%s)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
iterations=0
completed_iterations=0
faults=0
anomalies=0
completed=0
post_fault_verification_required=0
failure_stage=initializing

finalize() {
  local exit_code=$?
  local ended_epoch ended_at actual_seconds result log_sha iterations_sha failure_stage_json
  ended_epoch=$(date +%s)
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  actual_seconds=$((ended_epoch - started_epoch))
  result=failed
  [[ "$exit_code" == "0" && "$completed" == "1" && "$anomalies" == "0" ]] && result=passed
  log_sha=null
  iterations_sha=null
  [[ -f "$test_log" ]] && log_sha="\"$(sha256sum "$test_log" | awk '{print $1}')\""
  [[ -f "$iterations_file" ]] && iterations_sha="\"$(sha256sum "$iterations_file" | awk '{print $1}')\""
  failure_stage_json="\"$failure_stage\""
  [[ "$result" == "passed" ]] && failure_stage_json=null
  printf '{\n  "schemaVersion": 1,\n  "result": "%s",\n  "startedAt": "%s",\n  "endedAt": "%s",\n  "requestedDurationSeconds": %d,\n  "actualDurationSeconds": %d,\n  "intervalSeconds": %d,\n  "faultEvery": %d,\n  "attemptedIterations": %d,\n  "completedIterations": %d,\n  "databaseRestarts": %d,\n  "anomalies": %d,\n  "failureStage": %s,\n  "testLogSha256": %s,\n  "iterationsSha256": %s\n}\n' \
    "$result" "$started_at" "$ended_at" "$duration_seconds" "$actual_seconds" \
    "$interval_seconds" "$fault_every" "$iterations" "$completed_iterations" "$faults" "$anomalies" \
    "$failure_stage_json" "$log_sha" "$iterations_sha" >"$output"
  if [[ "$container" == feedback-go-soak-* ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [[ "$result" == "passed" ]]; then
    echo "[feedback-go-soak] PASS: $output"
  else
    echo "[feedback-go-soak] FAIL: 証跡を保存しました: $output" >&2
  fi
}
trap finalize EXIT

failure_stage=database-start
docker run -d --name "$container" -p 127.0.0.1::5432 \
  -e POSTGRES_DB=feedback -e POSTGRES_USER=feedback -e "POSTGRES_PASSWORD=$database_password" \
  postgres:16-alpine >/dev/null

wait_database() {
  local attempt
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if docker exec "$container" pg_isready -U feedback -d feedback >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}
failure_stage=database-readiness
wait_database || fail "専用PostgreSQLがreadyになりません"
refresh_database_environment() {
  local published database_port database_url
  published=$(docker port "$container" 5432/tcp | tail -1)
  database_port=${published##*:}
  [[ "$database_port" =~ ^[0-9]+$ ]] || return 1
  database_url="jdbc:postgresql://127.0.0.1:$database_port/feedback"
  database_environment=(
    env
    "FEEDBACK_DATABASE_URL=$database_url"
    FEEDBACK_DATABASE_USER=feedback
    "FEEDBACK_DATABASE_PASSWORD=$database_password"
  )
  integration_environment=(
    env
    "FEEDBACK_GO_INTEGRATION_DATABASE_URL=$database_url"
    FEEDBACK_GO_INTEGRATION_DATABASE_USER=feedback
    "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD=$database_password"
  )
}
refresh_database_environment || fail "PostgreSQLの公開portを取得できません"

run_migrator() {
  (
    cd apps/feedback-service-go
    "${database_environment[@]}" go run ./cmd/feedback migrate
  )
}

wait_migrator() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if run_migrator >>"$test_log" 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

failure_stage=initial-migration
wait_migrator || fail "host経由でmigration DBへ接続できません"

query_anomalies() {
  docker exec "$container" psql -U feedback -d feedback -At -F '|' -v ON_ERROR_STOP=1 -c "SELECT
    count(*) FILTER (WHERE status = 'processing' AND claimed_at < now() - interval '3 minutes'),
    (SELECT count(*) FROM feedback.backup_runs WHERE status = 'running' AND claimed_at < now() - interval '11 minutes'),
    (SELECT count(*) FROM feedback.export_jobs WHERE status = 'running' AND created_at < now() - interval '11 minutes'),
    (SELECT count(*) FROM feedback.backup_runs WHERE status = 'completed' AND
      (to_change_sequence IS NULL OR to_audit_sequence IS NULL OR
       to_change_sequence < from_change_sequence OR to_audit_sequence < from_audit_sequence))
  FROM feedback.connector_delivery_queue" | tail -1
}

deadline=$((started_epoch + duration_seconds))
while :; do
  iteration_started=$(date +%s)
  iterations=$((iterations + 1))
  post_fault_verification_required=0
  echo "=== iteration $iterations $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$test_log"
  failure_stage=connector-integration-test
  (
    cd apps/feedback-service-go
    FEEDBACK_TEST_RUN_ID=w3-connector "${integration_environment[@]}" \
      go test -count=1 -run '^TestNotificationConnectorLeaseAndRetryWithPostgreSQL$' ./internal/postgres
  ) >>"$test_log" 2>&1
  failure_stage=export-backup-integration-test
  (
    cd apps/feedback-service-go
    FEEDBACK_TEST_RUN_ID=w3-export-backup "${integration_environment[@]}" \
      go test -count=1 -run '^TestExportAndBackupWithPostgreSQL$' ./internal/postgres
  ) >>"$test_log" 2>&1

  failure_stage=invariant-query
  invariant_state=$(query_anomalies)
  IFS='|' read -r stale_connector stale_backup stale_export invalid_cursor <<<"$invariant_state"
  iteration_anomalies=$((stale_connector + stale_backup + stale_export + invalid_cursor))
  anomalies=$((anomalies + iteration_anomalies))
  iteration_seconds=$(( $(date +%s) - iteration_started ))
  printf '{"iteration":%d,"recordedAt":"%s","seconds":%d,"staleConnectorLeases":%d,"staleBackupLeases":%d,"staleExportJobs":%d,"invalidCompletedBackupCursors":%d}\n' \
    "$iterations" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$iteration_seconds" \
    "$stale_connector" "$stale_backup" "$stale_export" "$invalid_cursor" >>"$iterations_file"
  [[ "$iteration_anomalies" == "0" ]] || fail "iteration $iterationsで不変条件違反を検出しました"
  completed_iterations=$iterations

  current_epoch=$(date +%s)
  if (( iterations % fault_every == 0 && (current_epoch < deadline || faults == 0) )); then
    failure_stage=database-restart
    docker restart --time 1 "$container" >/dev/null
    faults=$((faults + 1))
    wait_database || fail "PostgreSQL再起動後にreadyへ回復しません"
    refresh_database_environment || fail "PostgreSQL再起動後の公開portを取得できません"
    failure_stage=post-restart-migration
    wait_migrator || fail "PostgreSQL再起動後にhost接続が回復しません"
    post_fault_verification_required=1
  fi

  if (( $(date +%s) >= deadline && post_fault_verification_required == 0 )); then
    break
  fi
  failure_stage=interval-wait
  (( interval_seconds == 0 )) || sleep "$interval_seconds"
done

failure_stage=completed
completed=1
