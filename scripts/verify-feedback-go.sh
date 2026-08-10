#!/usr/bin/env bash
# Feedback Service Go版の再現可能なcodegen・unit・race・任意のDB統合ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-go-verify] $*"; }
fail() { echo "[feedback-go-verify] FAIL: $*" >&2; exit 1; }

command -v go >/dev/null 2>&1 || fail "Goが見つかりません"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sumが見つかりません"
command -v rg >/dev/null 2>&1 || fail "ripgrepが見つかりません"
command -v comm >/dev/null 2>&1 || fail "commが見つかりません"
[[ -f apps/feedback-service-go/go.mod ]] || fail "Go moduleがありません"
[[ -f apps/feedback-service-go/internal/contract/openapi.gen.go ]] || fail "OpenAPI生成物がありません"
rg -q '^FROM docker\.io/library/golang:1\.26\.5-alpine@sha256:[0-9a-f]{64} AS build$' \
  apps/feedback-service-go/Dockerfile || fail "Go builder imageがGo 1.26.5のdigest固定ではありません"
rg -q '^FROM gcr\.io/distroless/static-debian12:nonroot@sha256:[0-9a-f]{64}$' \
  apps/feedback-service-go/Dockerfile || fail "Go runtime imageがnonroot distrolessのdigest固定ではありません"
[[ "$(rg -c '^FROM ' apps/feedback-service-go/Dockerfile)" == "2" ]] || \
  fail "Go Dockerfileのbuild/runtime stage数が2ではありません"

go_environment_variables() {
  rg -o --no-filename 'FEEDBACK_[A-Z][A-Z0-9_]+' apps/feedback-service-go \
    --glob '*.go' --glob '!**/*_test.go' | LC_ALL=C sort -u
}
documented_environment_variables() {
  rg -o --no-filename 'FEEDBACK_[A-Z][A-Z0-9_]+' docs/environment-variables.md | LC_ALL=C sort -u
}
undocumented_go_variables=$(comm -23 \
  <(go_environment_variables) <(documented_environment_variables))
[[ -z "$undocumented_go_variables" ]] || \
  fail "Go runtimeの環境変数がdocs/environment-variables.mdにありません: $undocumented_go_variables"
[[ ! -d apps/feedback-service ]] || fail "廃止済みKotlin Feedback Serviceが混入しています"

runtime_ddl_files=$(rg -l \
  'CREATE[[:space:]]+(TABLE|SCHEMA|INDEX)|ALTER[[:space:]]+TABLE|DROP[[:space:]]+(TABLE|SCHEMA)' \
  apps/feedback-service-go/internal apps/feedback-service-go/cmd \
  --glob '*.go' --glob '!**/*_test.go' | LC_ALL=C sort)
expected_runtime_ddl_files=$'apps/feedback-service-go/internal/postgres/fresh_baseline.go\napps/feedback-service-go/internal/postgres/legacy_journal.go'
[[ "$runtime_ddl_files" == "$expected_runtime_ddl_files" ]] || \
  fail "one-shot migrator以外にruntime DDLがあります: $runtime_ddl_files"

export GOTOOLCHAIN=go1.26.5
actual_go=$(go env GOVERSION)
[[ "$actual_go" == "go1.26.5" ]] || fail "Go 1.26.5が必要です (検出: $actual_go)"
gofmt_bin="$(go env GOROOT)/bin/gofmt"
[[ -x "$gofmt_bin" ]] || fail "Go 1.26.5のgofmtが見つかりません"

mapfile -t unformatted < <("$gofmt_bin" -l apps/feedback-service-go)
[[ ${#unformatted[@]} -eq 0 ]] || fail "gofmt未適用: ${unformatted[*]}"

pushd apps/feedback-service-go >/dev/null

generated=internal/contract/openapi.gen.go
before_generated=$(sha256sum "$generated" | awk '{print $1}')
go generate ./internal/contract
after_generated=$(sha256sum "$generated" | awk '{print $1}')
[[ "$before_generated" == "$after_generated" ]] || fail "OpenAPI生成物がcontract/configと同期していません"

before_module=$(sha256sum go.mod go.sum)
go mod tidy
after_module=$(sha256sum go.mod go.sum)
[[ "$before_module" == "$after_module" ]] || fail "go.mod/go.sumがtidyされていません"

go vet ./...
# integration接続情報が親processにあっても、通常test/raceでは実体testを起動しない。
# destructive testは後段で専用run IDを付けて1件ずつ実行する。
unit_test_env=(env -u FEEDBACK_GO_INTEGRATION_DATABASE_URL -u FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL)
"${unit_test_env[@]}" go test ./...
"${unit_test_env[@]}" go test -race ./...
CGO_ENABLED=0 go build -buildvcs=false ./...

if [[ "${VERIFY_INTEGRATION:-0}" == "1" ]]; then
  [[ -n "${FEEDBACK_GO_INTEGRATION_DATABASE_URL:-}" ]] || fail "FEEDBACK_GO_INTEGRATION_DATABASE_URLが必要です"
  [[ -n "${FEEDBACK_GO_INTEGRATION_DATABASE_USER:-}" ]] || fail "FEEDBACK_GO_INTEGRATION_DATABASE_USERが必要です"
  [[ -n "${FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD:-}" ]] || fail "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORDが必要です"
  [[ -n "${FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL:-}" ]] || fail "FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URLが必要です"
  [[ -n "${FEEDBACK_GO_INTEGRATION_S3_BUCKET:-}" ]] || fail "FEEDBACK_GO_INTEGRATION_S3_BUCKETが必要です"
  [[ -n "${FEEDBACK_GO_INTEGRATION_LEGACY_DATABASE_URL:-}" ]] ||
    fail "FEEDBACK_GO_INTEGRATION_LEGACY_DATABASE_URLが必要です"
  [[ "${FEEDBACK_TEST_RUN_ID:-}" =~ ^[a-z0-9][a-z0-9-]{0,20}$ ]] ||
    fail "FEEDBACK_TEST_RUN_IDは21文字以下の小文字英数字・hyphenで指定してください"
  go test -count=1 -run '^TestRuntimeFoundationAgainstPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w4-pool-exhaustion \
    go test -count=1 -run '^TestDatabasePoolExhaustionTimesOutAndRecovers$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w2-session \
    go test -count=1 -run '^TestSessionCRUDWithPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w2-discussion \
    go test -count=1 -run '^TestDiscussionConcurrencyWithPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w2-evidence \
    go test -count=1 -run '^TestEvidenceMetadataAndQuotaWithPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w2-evidence \
    go test -count=1 -run '^TestS3ObjectLifecycleWithMinIO$' ./internal/objectstore
  FEEDBACK_TEST_RUN_ID=w2-http \
    go test -count=1 -run '^TestRuntimeHTTPFoundationAgainstPostgreSQL$' ./internal/httpapi
  FEEDBACK_TEST_RUN_ID=w3-export-backup \
    go test -count=1 -run '^TestExportAndBackupWithPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w3-connector \
    go test -count=1 -run '^TestNotificationConnectorLeaseAndRetryWithPostgreSQL$' ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w3-export-backup \
    FEEDBACK_GO_INTEGRATION_S3_BUCKET=feedback-go-w3-export-backup \
    go test -count=1 -run '^TestBackupArchiveWithMinIO$' ./internal/backup
  FEEDBACK_TEST_RUN_ID=w3-admin-legacy \
    FEEDBACK_GO_INTEGRATION_DATABASE_URL="$FEEDBACK_GO_INTEGRATION_LEGACY_DATABASE_URL" \
    go test -count=1 \
      -run '^(TestLegacyJournalHandoffFingerprintWithPostgreSQL|TestMembershipAndLegacyMigrationWithPostgreSQL)$' \
      ./internal/postgres
  FEEDBACK_TEST_RUN_ID=w4-retention \
    go test -count=1 -run '^TestRetentionPolicyAndWorkerWithPostgreSQL$' ./internal/postgres
fi

popd >/dev/null
log "PASS"
