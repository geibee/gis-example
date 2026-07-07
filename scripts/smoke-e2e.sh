#!/usr/bin/env bash
# smoke-e2e.sh — スタック全体に対するスモーク E2E (nightly の Level 3 ゲート)
#
# 実データフロー「取込 → レイヤ登録 → 条件検索プレビュー → 分析ジョブ実体化 → タイル配信」
# を API 経由で検証する。ピクセルは検証しない (タイルのバイト列と件数で判定する)。
#
#   bash scripts/smoke-e2e.sh                    # docker compose を起動して検証 (CI / nightly)
#   SMOKE_MANAGE_COMPOSE=0 bash scripts/smoke-e2e.sh
#                                                # 起動済みスタックに対して検証 (ローカル開発)
# Env:
#   SMOKE_BASE_URL        API のベース URL (default: http://localhost:8080)
#   SMOKE_MANAGE_COMPOSE  1 なら compose の up/down を本スクリプトが行う (default: 1)
#   SMOKE_STARTUP_TIMEOUT /health 待ちの秒数 (default: 420。初回はイメージビルド+シード投入が走る)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE="${SMOKE_BASE_URL:-http://localhost:8080}"
MANAGE_COMPOSE="${SMOKE_MANAGE_COMPOSE:-1}"
STARTUP_TIMEOUT="${SMOKE_STARTUP_TIMEOUT:-420}"

log() { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

json_get() { # stdin の JSON から python 式で値を取り出す (例: json_get "j['id']")
  python3 -c "import json,sys; j=json.load(sys.stdin); print($1)"
}

if [[ "$MANAGE_COMPOSE" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker が見つかりません (fail-closed)"
  log "docker compose up --build ..."
  docker compose -f infra/docker-compose.yml up -d --build
  cleanup() {
    log "docker compose down ..."
    docker compose -f infra/docker-compose.yml logs --tail 100 api worker-gis > /tmp/smoke-compose.log 2>&1 || true
    docker compose -f infra/docker-compose.yml down -v || true
  }
  trap cleanup EXIT
fi

log "API 起動待ち (最大 ${STARTUP_TIMEOUT}s): $BASE/health"
for _ in $(seq 1 $((STARTUP_TIMEOUT / 5))); do
  curl -sf --max-time 3 "$BASE/health" >/dev/null 2>&1 && break
  sleep 5
done
curl -sf --max-time 3 "$BASE/health" >/dev/null || fail "API が起動しません"

PROJECT_ID=$(curl -sf "$BASE/api/projects" | json_get "j[0]['id']")
log "プロジェクト: $PROJECT_ID"

# ---------------------------------------------------------------- 1. 取込
log "1. GeoJSON 取込 (worker の GDAL パイプライン)"
IMPORT_ID=$(curl -sf -F "projectId=$PROJECT_ID" -F "format=geojson" -F "sourceSrid=4326" \
  -F "file=@samples/geojson/parcels.geojson" "$BASE/api/import-jobs" | json_get "j['id']")

LAYER_ID=""
for _ in $(seq 1 24); do
  STATUS_JSON=$(curl -sf "$BASE/api/import-jobs/$IMPORT_ID")
  STATUS=$(echo "$STATUS_JSON" | json_get "j['status']")
  if [[ "$STATUS" == "succeeded" ]]; then
    LAYER_ID=$(echo "$STATUS_JSON" | json_get "j['layerId']")
    break
  fi
  [[ "$STATUS" == "failed" ]] && fail "取込ジョブが失敗: $(echo "$STATUS_JSON" | json_get "j['errorMessage']")"
  sleep 5
done
[[ -n "$LAYER_ID" ]] || fail "取込ジョブが 120s 以内に完了しません"
log "  レイヤ作成: $LAYER_ID"

# ---------------------------------------------------------------- 2. 条件検索プレビュー
log "2. 条件検索プレビュー"
QUERY=$(cat <<EOF
{
  "projectId": "$PROJECT_ID",
  "targetLayerIds": ["$LAYER_ID"],
  "conditions": [
    { "type": "attribute", "field": "landuse", "operator": "LIKE", "value": "residential" }
  ],
  "limit": 10
}
EOF
)
PREVIEW_COUNT=$(curl -sf -X POST -H 'Content-Type: application/json' -d "$QUERY" \
  "$BASE/api/features/condition-search" | json_get "len(j)")
[[ "$PREVIEW_COUNT" -ge 1 ]] || fail "プレビューが 0 件 (landuse LIKE residential)"
log "  プレビュー: ${PREVIEW_COUNT} 件"

# ---------------------------------------------------------------- 3. 分析ジョブ実体化
log "3. condition_search 分析ジョブ"
ANALYSIS_ID=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"projectId\": \"$PROJECT_ID\", \"name\": \"smoke\", \"operation\": \"condition_search\", \"conditionQuery\": $QUERY}" \
  "$BASE/api/analysis-jobs" | json_get "j['id']")

RESULT_LAYER_ID=""
for _ in $(seq 1 24); do
  JOB_JSON=$(curl -sf "$BASE/api/analysis-jobs/$ANALYSIS_ID")
  STATUS=$(echo "$JOB_JSON" | json_get "j['status']")
  if [[ "$STATUS" == "succeeded" ]]; then
    RESULT_COUNT=$(echo "$JOB_JSON" | json_get "j['resultCount']")
    RESULT_LAYER_ID=$(echo "$JOB_JSON" | json_get "j['resultLayerId']")
    break
  fi
  [[ "$STATUS" == "failed" ]] && fail "分析ジョブが失敗: $(echo "$JOB_JSON" | json_get "j['errorMessage']")"
  sleep 5
done
[[ -n "$RESULT_LAYER_ID" ]] || fail "分析ジョブが 120s 以内に完了しません"
[[ "$RESULT_COUNT" == "$PREVIEW_COUNT" ]] \
  || fail "プレビュー (${PREVIEW_COUNT} 件) と分析結果 (${RESULT_COUNT} 件) が一致しません"
log "  実体化: ${RESULT_COUNT} 件 (プレビューと一致) layer=$RESULT_LAYER_ID"

# ---------------------------------------------------------------- 4. タイル配信
log "4. 結果レイヤのタイル配信"
curl -sf "$BASE/api/tilejson/$RESULT_LAYER_ID" | json_get "j['tiles'][0]" >/dev/null \
  || fail "tilejson が取得できません"

# 結果レイヤの bbox 中心を覆う z15 タイル座標を計算して非空を確認する
read -r TILE_X TILE_Y <<<"$(curl -sf "$BASE/api/layers" | python3 -c "
import json, math, sys
layers = json.load(sys.stdin)
layer = next(l for l in layers if l['id'] == '$RESULT_LAYER_ID')
west, south, east, north = layer['bbox4326']
lon, lat = (west + east) / 2, (south + north) / 2
n = 2 ** 15
x = int((lon + 180.0) / 360.0 * n)
lat_rad = math.radians(lat)
y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
print(x, y)
")"
TILE_BYTES=$(curl -sf -o /dev/null -w "%{size_download}" "$BASE/api/tiles/$RESULT_LAYER_ID/15/$TILE_X/$TILE_Y")
[[ "$TILE_BYTES" -gt 0 ]] || fail "結果レイヤの z15 タイルが空です (15/$TILE_X/$TILE_Y)"
log "  MVT 非空: 15/$TILE_X/$TILE_Y (${TILE_BYTES} bytes)"

log "PASS: 取込 → プレビュー → 分析実体化 → タイル配信のスモーク E2E 完了"
