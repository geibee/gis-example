#!/usr/bin/env bash
# standalone composeでOIDC/API/worker/MinIO/brokerの実経路を検証する。
# Kotlin rollback runtimeを含む抽出物でGoを検証する場合は、同一DB/Object Storageへのrollbackも演習する。
# Go-only抽出物はfeedback-migrateが空DBへclean V1を適用してから全serviceを起動する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

command -v curl >/dev/null 2>&1 || { echo "curlが必要です" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jqが必要です" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "dockerが必要です" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sumが必要です" >&2; exit 1; }
command -v cmp >/dev/null 2>&1 || { echo "cmpが必要です" >&2; exit 1; }

evidence_output=""
usage() {
  echo "usage: scripts/smoke-feedback-standalone.sh [--evidence-output <new-directory>]" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence-output) [[ $# -ge 2 ]] || usage; evidence_output=$2; shift 2 ;;
    *) usage ;;
  esac
done
if [[ -n "$evidence_output" ]]; then
  [[ ! -e "$evidence_output" && -d "$(dirname "$evidence_output")" ]] || {
    echo "証跡出力先は存在しないdirectoryを指定してください: $evidence_output" >&2
    exit 1
  }
  evidence_output="$(cd "$(dirname "$evidence_output")" && pwd)/$(basename "$evidence_output")"
fi

manage_compose=${FEEDBACK_SMOKE_MANAGE_COMPOSE:-1}
has_kotlin_runtime=0
default_runtime=go
if [[ -d apps/feedback-service ]]; then
  has_kotlin_runtime=1
  default_runtime=kotlin
fi
runtime=${FEEDBACK_SMOKE_RUNTIME:-$default_runtime}
case "$runtime" in
  kotlin)
    [[ "$has_kotlin_runtime" == "1" ]] || {
      echo "Go-only抽出物ではKotlin runtimeを選択できません" >&2
      exit 1
    }
    runtime_dockerfile=apps/feedback-service/Dockerfile
    ;;
  go) runtime_dockerfile=apps/feedback-service-go/Dockerfile ;;
  *) echo "FEEDBACK_SMOKE_RUNTIMEはkotlinまたはgoで指定してください" >&2; exit 1 ;;
esac
if [[ -n "${FEEDBACK_SMOKE_ROLLBACK:-}" ]]; then
  rollback_rehearsal=$FEEDBACK_SMOKE_ROLLBACK
elif [[ "$runtime" == "go" && "$manage_compose" == "1" && "$has_kotlin_runtime" == "1" ]]; then
  rollback_rehearsal=1
else
  rollback_rehearsal=0
fi
[[ "$rollback_rehearsal" == "0" || "$rollback_rehearsal" == "1" ]] || {
  echo "FEEDBACK_SMOKE_ROLLBACKは0または1で指定してください" >&2
  exit 1
}
if [[ "$rollback_rehearsal" == "1" && ( "$runtime" != "go" || "$manage_compose" != "1" ) ]]; then
  echo "rollback演習はFEEDBACK_SMOKE_RUNTIME=goかつcompose管理ありで実行してください" >&2
  exit 1
fi
if [[ "$rollback_rehearsal" == "1" && "$has_kotlin_runtime" != "1" ]]; then
  echo "Go-only抽出物ではKotlin rollback演習を実行できません" >&2
  exit 1
fi
project=${FEEDBACK_SMOKE_PROJECT:-feedback-system-smoke}
temporary_root=$(mktemp -d -t feedback-standalone-smoke.XXXXXX)
smoke_succeeded=0

compose() {
  FEEDBACK_SERVICE_DOCKERFILE="$runtime_dockerfile" \
    docker compose -p "$project" --env-file deploy/.env.example -f deploy/compose.yaml "$@"
}

kotlin_compose() {
  FEEDBACK_SERVICE_DOCKERFILE=apps/feedback-service/Dockerfile \
    docker compose -p "$project" --env-file deploy/.env.example -f deploy/compose.yaml "$@"
}

cleanup() {
  if [[ "$smoke_succeeded" != "1" ]]; then
    compose ps >&2 || true
    compose logs --no-color --tail=80 feedback-service feedback-bootstrap-east \
      feedback-bootstrap-west feedback-notification-worker \
      feedback-export-worker feedback-retention-worker feedback-webhook-connector \
      feedback-connector-register feedback-conformance-consumer >&2 || true
  fi
  if [[ "$manage_compose" == "1" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ -d "$temporary_root" && "$(basename "$temporary_root")" == feedback-standalone-smoke.?????? ]]; then
    rm -rf -- "$temporary_root"
  fi
}
trap cleanup EXIT

if [[ "$manage_compose" == "1" ]]; then
  [[ -z "$(compose ps -q)" ]] || { echo "同名のstandalone smoke composeが既に起動しています" >&2; exit 1; }
  if [[ "$runtime" == "go" ]]; then
    if [[ "$has_kotlin_runtime" == "1" ]]; then
      # rollback期間の抽出物はKotlin/FlywayでV6 markerまで適用してからGoへhandoffする。
      kotlin_compose up -d --build feedback-service
      for _ in {1..180}; do
        curl --fail --silent --show-error http://localhost:8090/health/ready >/dev/null 2>&1 && break
        sleep 1
      done
      curl --fail --silent --show-error http://localhost:8090/health/ready >/dev/null
      kotlin_compose stop feedback-service >/dev/null
    else
      # final Go-only抽出物はone-shot migratorが同梱clean V1を空DBへ適用する。
      compose up -d feedback-postgres
      compose --profile go-migration run --rm --build feedback-migrate
      # 二度目はno-opで、Flyway V1履歴とV6 markerが各1件のまま変わらない。
      compose --profile go-migration run --rm --no-deps feedback-migrate
      fresh_migration_state=$(compose exec -T feedback-postgres psql -U feedback -d feedback -At -F '|' -c \
        "SELECT (SELECT count(*) FROM feedback.flyway_schema_history WHERE version = '1' AND success),
                (SELECT count(*) FROM feedback.go_schema_migrations WHERE version = 6 AND kind = 'baseline'
                  AND state = 'succeeded'
                  AND schema_fingerprint_sha256 = 'de8ba8a564a39b533e92b37ebffd32bc1a6fbfb66addaad4f56dbd78cb934259'),
                (SELECT count(*) FROM feedback.go_schema_migrations)")
      [[ "$fresh_migration_state" == "1|1|1" ]] || {
        echo "Go-only fresh migration履歴が不正です: $fresh_migration_state" >&2
        exit 1
      }
    fi
  fi
  compose up -d --build
fi

wait_ready() {
  local url=$1
  for _ in {1..180}; do
    curl --fail --silent --show-error "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "timeout: $url" >&2
  return 1
}

wait_ready http://localhost:8090/health/ready
wait_ready http://localhost:5174/
wait_ready http://localhost:5175/

token=""
for _ in {1..120}; do
  token_response=$(curl --silent --show-error --request POST \
    --data-urlencode grant_type=password \
    --data-urlencode client_id=feedback-admin \
    --data-urlencode username=feedback-admin \
    --data-urlencode password=feedback-local-only \
    http://localhost:8180/realms/feedback/protocol/openid-connect/token || true)
  token=$(jq -r '.access_token // empty' <<<"$token_response")
  [[ -n "$token" ]] && break
  sleep 1
done
[[ -n "$token" ]] || { echo "local OIDC tokenを取得できません" >&2; exit 1; }

api_headers=(-H "Authorization: Bearer $token")
api_request() {
  local method=$1 path=$2 output=$3 headers=$4 body=${5-}
  shift 5 || true
  local args=(--fail-with-body --silent --show-error --request "$method" --dump-header "$headers" --output "$output")
  args+=("${api_headers[@]}")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" --data "$body")
  fi
  if ! curl "${args[@]}" "$@" "http://localhost:8090/feedback/v1$path"; then
    if [[ -s "$output" ]]; then
      echo "standalone smoke API failure: $method $path" >&2
      jq . "$output" >&2 2>/dev/null || sed -n '1,40p' "$output" >&2
    fi
    return 1
  fi
}

header_value() {
  local name=$1 file=$2
  awk -v expected="${name,,}:" 'tolower($1) == expected {$1=""; sub(/^ /, ""); print}' "$file" | tr -d '\r' | tail -1
}

write_object_manifest() {
  local directory=$1 output=$2
  (
    cd "$directory"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  ) >"$output"
}

manifest='{"schemaVersion":"1","applicationKey":"inventory","displayName":"Inventory","manifestVersion":"smoke-v1","routes":[{"pageKey":"inventory.home","template":"/inventory","label":"在庫"}]}'
api_request PUT /applications/inventory/manifest "$temporary_root/manifest.json" "$temporary_root/manifest.headers" "$manifest"

scope_query='?applicationKey=inventory&externalWorkspaceKey=east'
for _ in {1..60}; do
  if api_request GET "/connector-types$scope_query" "$temporary_root/connectors.json" \
      "$temporary_root/connectors.headers" "" &&
      jq -e '.[] | select(.key == "webhook")' "$temporary_root/connectors.json" >/dev/null; then
    break
  fi
  sleep 1
done
jq -e '.[] | select(.key == "webhook")' "$temporary_root/connectors.json" >/dev/null
connector='{"connectorType":"webhook","name":"standalone Webhook","destinationRef":"fixture-webhook","enabled":true,"includeBody":false}'
api_request POST "/notification-connectors$scope_query" "$temporary_root/connector.json" \
  "$temporary_root/connector.headers" "$connector"

api_request GET "/retention-policy$scope_query" "$temporary_root/retention.json" "$temporary_root/retention.headers" ""
retention_etag=$(header_value ETag "$temporary_root/retention.headers")
api_request PATCH "/retention-policy$scope_query" "$temporary_root/retention-patched.json" \
  "$temporary_root/retention-patched.headers" '{"evidenceRetentionDays":1,"exportRetentionDays":1}' \
  -H "If-Match: $retention_etag"

session='{"applicationKey":"inventory","environmentKey":"local","externalWorkspaceKey":"east","manifestVersion":"smoke-v1","title":"standalone smoke","outOfScopePosting":"warn","scopes":[{"pageKey":"inventory.home","routeTemplate":"/inventory","reviewable":true}],"perspectives":[{"code":"usability","label":"使いやすさ","status":"active"}]}'
api_request POST /sessions "$temporary_root/session.json" "$temporary_root/session.headers" "$session" \
  -H 'Idempotency-Key: standalone-smoke-session'
session_id=$(jq -er '.id' "$temporary_root/session.json")
session_etag=$(header_value ETag "$temporary_root/session.headers")
api_request PATCH "/sessions/$session_id" "$temporary_root/session-open.json" "$temporary_root/session-open.headers" \
  '{"status":"open"}' -H "If-Match: $session_etag" -H 'Content-Type: application/merge-patch+json'

thread='{"location":{"schemaVersion":"1","pageKey":"inventory.home","routeTemplate":"/inventory","pathParameters":{},"queryParameters":{}},"target":{"schemaVersion":"1","kind":"screen-position","relativeX":0.25,"relativeY":0.75},"perspectiveCode":"usability","body":"standalone投稿","evidence":{"contentType":"image/png","dataBase64":"iVBORw0KGgoA","viewportWidth":100,"viewportHeight":100,"pixelRatio":1.0,"capturedAt":"2026-08-09T00:00:00Z"}}'
api_request POST "/sessions/$session_id/threads" "$temporary_root/thread.json" "$temporary_root/thread.headers" "$thread" \
  -H 'Idempotency-Key: standalone-smoke-thread'
thread_id=$(jq -er '.id' "$temporary_root/thread.json")
api_request GET "/threads/$thread_id/evidence" "$temporary_root/evidence.bin" "$temporary_root/evidence.headers" "" \
  -H 'Range: bytes=0-3'
[[ "$(wc -c <"$temporary_root/evidence.bin")" == "4" ]]

api_request POST "/threads/$thread_id/messages" "$temporary_root/message.json" "$temporary_root/message.headers" \
  '{"body":"standalone返信","participantName":null}' -H 'Idempotency-Key: standalone-smoke-message'
message_id=$(jq -er '.id' "$temporary_root/message.json")
message_etag=$(header_value ETag "$temporary_root/message.headers")
api_request PATCH "/messages/$message_id" "$temporary_root/message-edited.json" "$temporary_root/message-edited.headers" \
  '{"body":"standalone編集","participantName":null}' -H "If-Match: $message_etag" \
  -H 'Content-Type: application/merge-patch+json'
api_request GET "/threads/$thread_id" "$temporary_root/thread-latest.json" "$temporary_root/thread-latest.headers" ""
thread_etag=$(header_value ETag "$temporary_root/thread-latest.headers")
api_request PATCH "/threads/$thread_id/status" "$temporary_root/thread-resolved.json" "$temporary_root/thread-resolved.headers" \
  '{"status":"resolved"}' -H "If-Match: $thread_etag" -H 'Content-Type: application/merge-patch+json'
[[ "$(jq -r '.status' "$temporary_root/thread-resolved.json")" == "resolved" ]]

export_body=$(jq -cn --arg session "$session_id" '{applicationKey:"inventory",environmentKey:"local",externalWorkspaceKey:"east",sessionId:$session,format:"csv",locale:"ja-JP",timezone:"Asia/Tokyo"}')
api_request POST /exports "$temporary_root/export.json" "$temporary_root/export.headers" "$export_body" \
  -H 'Idempotency-Key: standalone-smoke-export'
export_id=$(jq -er '.id' "$temporary_root/export.json")
for _ in {1..60}; do
  api_request GET "/exports/$export_id" "$temporary_root/export-status.json" "$temporary_root/export-status.headers" ""
  [[ "$(jq -r '.status' "$temporary_root/export-status.json")" == "completed" ]] && break
  sleep 1
done
[[ "$(jq -r '.status' "$temporary_root/export-status.json")" == "completed" ]]
api_request GET "/exports/$export_id/download" "$temporary_root/export.csv" "$temporary_root/export-download.headers" ""
grep -q 'standalone' "$temporary_root/export.csv"

for _ in {1..30}; do
  webhook_count=$(curl --fail --silent --show-error http://localhost:5175/fixture-webhook/status | jq -r '.count')
  (( webhook_count > 0 )) && break
  sleep 1
done
(( webhook_count > 0 ))

curl --fail --silent --show-error --output /dev/null --cookie-jar "$temporary_root/session.cookies" \
  --request POST http://localhost:5175/fixture-auth/session
curl --fail --silent --show-error --cookie "$temporary_root/session.cookies" -H 'Content-Type: application/json' \
  --data '{"applicationKey":"inventory","environmentKey":"local","externalWorkspaceKey":"east","actor_sub":"browser-forgery","feedback_permissions":["feedback.admin"]}' \
  http://localhost:5175/fixture-auth/feedback-token >"$temporary_root/exchange.json"
exchange_token=$(jq -er '.accessToken' "$temporary_root/exchange.json")
curl --fail --silent --show-error --output /dev/null -H "Authorization: Bearer $exchange_token" \
  http://localhost:8090/feedback/v1/capabilities
[[ "$(curl -k --silent --output /dev/null --write-out '%{http_code}' -H 'Content-Type: application/json' \
  --data '{}' https://localhost:8443/v1/exchanges)" == "401" ]]

compose exec -T feedback-postgres psql -v ON_ERROR_STOP=1 -U feedback -d feedback <<SQL >/dev/null
UPDATE feedback.review_evidence SET expires_at = now() - interval '1 second' WHERE thread_id = '$thread_id'::uuid;
UPDATE feedback.export_jobs SET expires_at = now() - interval '1 second' WHERE id = '$export_id'::uuid;
SQL

for _ in {1..30}; do
  evidence_status=$(curl --silent --output /dev/null --write-out '%{http_code}' "${api_headers[@]}" \
    "http://localhost:8090/feedback/v1/threads/$thread_id/evidence")
  export_status=$(curl --silent --output /dev/null --write-out '%{http_code}' "${api_headers[@]}" \
    "http://localhost:8090/feedback/v1/exports/$export_id/download")
  [[ "$evidence_status" == "404" && "$export_status" == "404" ]] && break
  sleep 1
done
[[ "$evidence_status" == "404" && "$export_status" == "404" ]]
purge_state=$(compose exec -T feedback-postgres psql -At -U feedback -d feedback -c \
  "SELECT (SELECT count(*) FROM feedback.review_evidence WHERE thread_id = '$thread_id'::uuid) || ':' || (SELECT count(*) FROM feedback.export_jobs WHERE id = '$export_id'::uuid AND object_key IS NULL)")
[[ "$purge_state" == "0:1" ]]

go_memory="$temporary_root/go-runtime-memory.json"
if [[ "$runtime" == "go" ]]; then
  # APIと各workerが実処理を完了した後の値を取り、起動直後だけの過小なRSSを合格証跡にしない。
  bash scripts/measure-feedback-runtime-memory.sh --implementation go --output "$go_memory" \
    --container "api=$(compose ps -q feedback-service)" \
    --container "notification=$(compose ps -q feedback-notification-worker)" \
    --container "export-backup=$(compose ps -q feedback-export-worker)" \
    --container "retention=$(compose ps -q feedback-retention-worker)" \
    --container "connector=$(compose ps -q feedback-webhook-connector)"
  jq -c '{implementation,maximumBytes,passed,samples:[.samples[]|{role,bytes}]}' "$go_memory"
fi

if [[ "$rollback_rehearsal" == "1" ]]; then
  # 同じV6 DB/Object Storageを維持し、roleごとにGoを停止してからKotlinを開始する。
  rollback_session_id=$session_id

  compose stop feedback-notification-worker >/dev/null
  kotlin_compose up -d --build --no-deps --force-recreate feedback-notification-worker
  rollback_webhook_before=$(curl --fail --silent --show-error \
    http://localhost:5175/fixture-webhook/status | jq -r '.count')
  rollback_thread=$(jq -c '.body = "Kotlin rollback notification"' <<<"$thread")
  api_request POST "/sessions/$rollback_session_id/threads" "$temporary_root/rollback-thread.json" \
    "$temporary_root/rollback-thread.headers" "$rollback_thread" \
    -H 'Idempotency-Key: standalone-smoke-rollback-thread'
  rollback_thread_id=$(jq -er '.id' "$temporary_root/rollback-thread.json")
  for _ in {1..30}; do
    rollback_webhook_after=$(curl --fail --silent --show-error \
      http://localhost:5175/fixture-webhook/status | jq -r '.count')
    (( rollback_webhook_after > rollback_webhook_before )) && break
    sleep 1
  done
  (( rollback_webhook_after > rollback_webhook_before ))

  compose stop feedback-export-worker >/dev/null
  kotlin_compose up -d --build --no-deps --force-recreate feedback-export-worker
  rollback_export_body=$(jq -cn --arg session "$rollback_session_id" \
    '{applicationKey:"inventory",environmentKey:"local",externalWorkspaceKey:"east",sessionId:$session,format:"csv",locale:"ja-JP",timezone:"Asia/Tokyo"}')
  api_request POST /exports "$temporary_root/rollback-export.json" \
    "$temporary_root/rollback-export.headers" "$rollback_export_body" \
    -H 'Idempotency-Key: standalone-smoke-rollback-export'
  rollback_export_id=$(jq -er '.id' "$temporary_root/rollback-export.json")
  for _ in {1..60}; do
    api_request GET "/exports/$rollback_export_id" "$temporary_root/rollback-export-status.json" \
      "$temporary_root/rollback-export-status.headers" ""
    [[ "$(jq -r '.status' "$temporary_root/rollback-export-status.json")" == "completed" ]] && break
    sleep 1
  done
  [[ "$(jq -r '.status' "$temporary_root/rollback-export-status.json")" == "completed" ]]
  api_request GET "/exports/$rollback_export_id/download" "$temporary_root/rollback-export.csv" \
    "$temporary_root/rollback-export-download.headers" ""
  grep -q 'Kotlin rollback' "$temporary_root/rollback-export.csv"

  compose stop feedback-retention-worker >/dev/null
  kotlin_compose up -d --build --no-deps --force-recreate feedback-retention-worker
  api_request GET "/threads/$rollback_thread_id/evidence" "$temporary_root/rollback-evidence.bin" \
    "$temporary_root/rollback-evidence.headers" ""
  [[ -s "$temporary_root/rollback-evidence.bin" ]]

  compose stop feedback-service >/dev/null
  kotlin_compose up -d --build --no-deps --force-recreate feedback-service
  wait_ready http://localhost:8090/health/ready
  api_request GET "/sessions/$session_id" "$temporary_root/rollback-existing-session.json" \
    "$temporary_root/rollback-existing-session.headers" ""
  [[ "$(jq -r '.id' "$temporary_root/rollback-existing-session.json")" == "$session_id" ]]
  rollback_api_webhook_before=$(curl --fail --silent --show-error \
    http://localhost:5175/fixture-webhook/status | jq -r '.count')
  api_request POST "/threads/$rollback_thread_id/messages" "$temporary_root/rollback-api-message.json" \
    "$temporary_root/rollback-api-message.headers" '{"body":"Kotlin API rollback write","participantName":null}' \
    -H 'Idempotency-Key: standalone-smoke-rollback-api-message'
  [[ "$(jq -r '.body' "$temporary_root/rollback-api-message.json")" == "Kotlin API rollback write" ]]
  for _ in {1..30}; do
    rollback_api_webhook_after=$(curl --fail --silent --show-error \
      http://localhost:5175/fixture-webhook/status | jq -r '.count')
    (( rollback_api_webhook_after > rollback_api_webhook_before )) && break
    sleep 1
  done
  (( rollback_api_webhook_after > rollback_api_webhook_before ))

  kotlin_memory="$temporary_root/kotlin-runtime-memory.json"
  bash scripts/measure-feedback-runtime-memory.sh --implementation kotlin --maximum-bytes 0 --output "$kotlin_memory" \
    --container "api=$(kotlin_compose ps -q feedback-service)" \
    --container "notification=$(kotlin_compose ps -q feedback-notification-worker)" \
    --container "export-backup=$(kotlin_compose ps -q feedback-export-worker)" \
    --container "retention=$(kotlin_compose ps -q feedback-retention-worker)"
  memory_comparison="$temporary_root/runtime-memory-comparison.json"
  jq -n --slurpfile go "$go_memory" --slurpfile kotlin "$kotlin_memory" '
    def by_role($samples): reduce $samples[] as $sample ({}; .[$sample.role] = $sample.bytes);
    (by_role($go[0].samples)) as $g |
    (by_role($kotlin[0].samples)) as $k |
    ["api", "notification", "export-backup", "retention"] as $roles |
    {
      schemaVersion: 1,
      maximumGoRatio: 0.5,
      samples: [$roles[] as $role | {
        role: $role,
        goBytes: $g[$role],
        kotlinBytes: $k[$role],
        goRatio: ($g[$role] / $k[$role]),
        passed: ($g[$role] <= ($k[$role] * 0.5))
      }]
    } | .passed = all(.samples[]; .passed)
  ' >"$memory_comparison"
  jq -e '.passed == true' "$memory_comparison" >/dev/null
  jq -c . "$memory_comparison"

  # sourceへのwriteを止めてからDBと2 bucketを隔離先へ復元し、schema/dataと全object SHA-256を比較する。
  kotlin_compose stop feedback-service feedback-notification-worker feedback-export-worker \
    feedback-retention-worker >/dev/null
  restore_database=feedback_restore_smoke
  restore_exists=$(kotlin_compose exec -T feedback-postgres psql -U feedback -d postgres -Atc \
    "SELECT 1 FROM pg_database WHERE datname = '$restore_database'")
  [[ -z "$restore_exists" ]] || { echo "restore演習用DBが既に存在します" >&2; exit 1; }
  kotlin_compose exec -T feedback-postgres pg_dump --format=custom --no-owner --no-privileges \
    --schema=feedback -U feedback -d feedback >"$temporary_root/feedback.dump"
  kotlin_compose exec -T feedback-postgres createdb -U feedback "$restore_database"
  kotlin_compose exec -T feedback-postgres pg_restore --exit-on-error --no-owner --no-privileges \
    -U feedback -d "$restore_database" <"$temporary_root/feedback.dump"
  compose --profile go-migration run --rm --no-deps --build \
    --env "FEEDBACK_DATABASE_URL=jdbc:postgresql://feedback-postgres:5432/$restore_database" \
    feedback-migrate >/dev/null
  kotlin_compose exec -T feedback-postgres pg_dump --data-only --no-owner --no-privileges --inserts \
    --schema=feedback -U feedback -d feedback |
    sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' >"$temporary_root/source-database.sql"
  kotlin_compose exec -T feedback-postgres pg_dump --data-only --no-owner --no-privileges --inserts \
    --schema=feedback -U feedback -d "$restore_database" |
    sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' >"$temporary_root/restored-database.sql"
  source_database_sha256=$(sha256sum "$temporary_root/source-database.sql" | awk '{print $1}')
  database_restore_sha256=$(sha256sum "$temporary_root/restored-database.sql" | awk '{print $1}')
  [[ "$source_database_sha256" == "$database_restore_sha256" ]] || {
    echo "restore後のDB data checksumが一致しません: source=$source_database_sha256 restore=$database_restore_sha256" >&2
    exit 1
  }
  kotlin_compose exec -T feedback-postgres dropdb -U feedback "$restore_database"

  mkdir -p "$temporary_root/object-backup/evidence" "$temporary_root/object-backup/exports" \
    "$temporary_root/object-restore/evidence" "$temporary_root/object-restore/exports"
  # container内でMinIO資格情報を展開するためsingle quoteを維持する。
  # shellcheck disable=SC2016
  kotlin_compose run --rm --no-deps --user "$(id -u):$(id -g)" \
    --volume "$temporary_root/object-backup:/backup" \
    --volume "$temporary_root/object-restore:/restore" \
    --entrypoint /bin/sh minio-init -ec '
      export MC_CONFIG_DIR=/tmp/mc
      mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
      mc mb local/feedback-restore-evidence >/dev/null
      mc mb local/feedback-restore-exports >/dev/null
      mc mirror local/feedback-evidence /backup/evidence >/dev/null
      mc mirror local/feedback-exports /backup/exports >/dev/null
      mc mirror --overwrite --checksum SHA256 /backup/evidence local/feedback-restore-evidence >/dev/null
      mc mirror --overwrite --checksum SHA256 /backup/exports local/feedback-restore-exports >/dev/null
      mc mirror local/feedback-restore-evidence /restore/evidence >/dev/null
      mc mirror local/feedback-restore-exports /restore/exports >/dev/null
      mc rb --force local/feedback-restore-evidence >/dev/null
      mc rb --force local/feedback-restore-exports >/dev/null
    '
  write_object_manifest "$temporary_root/object-backup" "$temporary_root/source-objects.sha256"
  write_object_manifest "$temporary_root/object-restore" "$temporary_root/restored-objects.sha256"
  cmp --silent "$temporary_root/source-objects.sha256" "$temporary_root/restored-objects.sha256"
  object_restore_sha256=$(sha256sum "$temporary_root/restored-objects.sha256" | awk '{print $1}')
  echo "[feedback-standalone-smoke] DB/Object Storage restore PASS db=$database_restore_sha256 objects=$object_restore_sha256"

  kotlin_compose start feedback-service feedback-retention-worker >/dev/null
  wait_ready http://localhost:8090/health/ready

  kotlin_compose exec -T feedback-postgres psql -v ON_ERROR_STOP=1 -U feedback -d feedback <<SQL >/dev/null
UPDATE feedback.review_evidence SET expires_at = now() - interval '1 second'
WHERE thread_id = '$rollback_thread_id'::uuid;
SQL
  for _ in {1..30}; do
    rollback_evidence_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
      "${api_headers[@]}" "http://localhost:8090/feedback/v1/threads/$rollback_thread_id/evidence")
    [[ "$rollback_evidence_status" == "404" ]] && break
    sleep 1
  done
  [[ "$rollback_evidence_status" == "404" ]]

  rollback_state=$(kotlin_compose exec -T feedback-postgres psql -At -U feedback -d feedback -c \
    "SELECT (SELECT count(*) FROM feedback.review_sessions WHERE id = '$rollback_session_id'::uuid) || ':' || (SELECT count(*) FROM feedback.feedback_threads WHERE id = '$rollback_thread_id'::uuid) || ':' || (SELECT count(*) FROM feedback.review_evidence WHERE thread_id = '$rollback_thread_id'::uuid) || ':' || (SELECT count(*) FROM feedback.export_jobs WHERE id = '$rollback_export_id'::uuid AND status = 'completed')")
  [[ "$rollback_state" == "1:1:0:1" ]]
  echo "[feedback-standalone-smoke] Go -> Kotlin API/worker rollback PASS"
fi

compose stop feedback-service >/dev/null
curl --fail --silent --show-error --output /dev/null http://localhost:5175/

if [[ -n "$evidence_output" ]]; then
  mkdir "$evidence_output"
  for artifact in "${go_memory:-}" "${kotlin_memory:-}" "${memory_comparison:-}"; do
    [[ -n "$artifact" && -f "$artifact" ]] && cp "$artifact" "$evidence_output/"
  done
  jq -n \
    --arg runtime "$runtime" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg databaseRestoreSha256 "${database_restore_sha256:-}" \
    --arg objectRestoreSha256 "${object_restore_sha256:-}" \
    --argjson rollbackRehearsal "$rollback_rehearsal" \
    '{schemaVersion:1,runtime:$runtime,completedAt:$completedAt,
      rollbackRehearsal:($rollbackRehearsal == 1),
      databaseRestoreSha256:(if $databaseRestoreSha256 == "" then null else $databaseRestoreSha256 end),
      objectRestoreSha256:(if $objectRestoreSha256 == "" then null else $objectRestoreSha256 end)}' \
    >"$evidence_output/standalone-summary.json"
  (
    cd "$evidence_output"
    find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum
  ) >"$evidence_output/SHA256SUMS"
  (cd "$evidence_output" && sha256sum --check SHA256SUMS >/dev/null)
  echo "[feedback-standalone-smoke] 証跡を保存しました: $evidence_output"
fi

smoke_succeeded=1
echo "[feedback-standalone-smoke] PASS"
