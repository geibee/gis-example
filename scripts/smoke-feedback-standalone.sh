#!/usr/bin/env bash
# standalone composeでOIDC/API/worker/MinIO/brokerの実経路を検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

command -v curl >/dev/null 2>&1 || { echo "curlが必要です" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jqが必要です" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "dockerが必要です" >&2; exit 1; }

manage_compose=${FEEDBACK_SMOKE_MANAGE_COMPOSE:-1}
project=${FEEDBACK_SMOKE_PROJECT:-feedback-system-smoke}
temporary_root=$(mktemp -d -t feedback-standalone-smoke.XXXXXX)
smoke_succeeded=0

compose() {
  docker compose -p "$project" --env-file deploy/.env.example -f deploy/compose.yaml "$@"
}

cleanup() {
  if [[ "$smoke_succeeded" != "1" ]]; then
    compose ps >&2 || true
    compose logs --no-color --tail=80 feedback-service feedback-notification-worker \
      feedback-export-worker feedback-retention-worker feedback-conformance-consumer >&2 || true
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
  curl "${args[@]}" "$@" "http://localhost:8090/feedback/v1$path"
}

header_value() {
  local name=$1 file=$2
  awk -v expected="${name,,}:" 'tolower($1) == expected {$1=""; sub(/^ /, ""); print}' "$file" | tr -d '\r' | tail -1
}

manifest='{"schemaVersion":"1","applicationKey":"inventory","displayName":"Inventory","manifestVersion":"smoke-v1","routes":[{"pageKey":"inventory.home","template":"/inventory","label":"在庫"}]}'
api_request PUT /applications/inventory/manifest "$temporary_root/manifest.json" "$temporary_root/manifest.headers" "$manifest"

scope_query='?applicationKey=inventory&externalWorkspaceKey=east'
api_request GET "/notification-settings$scope_query" "$temporary_root/notification.json" "$temporary_root/notification.headers" ""
notification_etag=$(header_value ETag "$temporary_root/notification.headers")
notification='{"webhookEnabled":true,"webhookEndpoint":"http://feedback-conformance-consumer:8080/fixture-webhook","includeBody":false,"includeEvidence":false}'
api_request PATCH "/notification-settings$scope_query" "$temporary_root/notification-patched.json" \
  "$temporary_root/notification-patched.headers" "$notification" -H "If-Match: $notification_etag"

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

compose stop feedback-service >/dev/null
curl --fail --silent --show-error --output /dev/null http://localhost:5175/

smoke_succeeded=1
echo "[feedback-standalone-smoke] PASS"
