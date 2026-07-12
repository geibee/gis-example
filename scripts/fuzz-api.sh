#!/usr/bin/env bash
# fuzz-api.sh — Schemathesis による API ファズ (openapi.yaml が入力の SSoT)
#
# 起動済みの API に対して、契約から生成したリクエストで 5xx・契約違反・
# 未文書ステータスを検査する。固定 seed で反復可能。
#
# 発見の信号品質が安定するまでは非ブロッキング (FUZZ_BLOCKING=0, 既定) で運用し、
# 既知の失敗クラス (不正 UUID での 500 など) を潰し切ったら FUZZ_BLOCKING=1 に昇格する。
#
# Env:
#   FUZZ_BASE_URL      検査対象 API (default: http://localhost:8080)
#   FUZZ_MAX_EXAMPLES  オペレーションあたりの生成数 (default: 30)
#   FUZZ_BLOCKING      1 なら失敗で exit 1 (default: 0 = 報告のみ)
#   FUZZ_AUTH_TOKEN    Bearer トークン。全 API が認証必須のため、未設定だと
#                      ほぼ全リクエストが 401 で終わりハンドラ本体に到達しない
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE="${FUZZ_BASE_URL:-http://localhost:8080}"
MAX_EXAMPLES="${FUZZ_MAX_EXAMPLES:-30}"
BLOCKING="${FUZZ_BLOCKING:-0}"

command -v schemathesis >/dev/null 2>&1 \
  || { echo "[fuzz] FAIL: schemathesis が見つかりません (pip install schemathesis)" >&2; exit 1; }
curl -sf --max-time 3 "$BASE/health" >/dev/null \
  || { echo "[fuzz] FAIL: API が起動していません: $BASE" >&2; exit 1; }

AUTH_ARGS=()
if [[ -n "${FUZZ_AUTH_TOKEN:-}" ]]; then
  AUTH_ARGS=(--header "Authorization: Bearer $FUZZ_AUTH_TOKEN")
else
  echo "[fuzz] WARN: FUZZ_AUTH_TOKEN 未設定のため匿名で実行します (ほぼ全て 401 になります)"
fi

set +e
schemathesis run apps/api/openapi.yaml \
  --url "$BASE" \
  --seed 42 \
  --max-examples "$MAX_EXAMPLES" \
  --checks all \
  --exclude-checks positive_data_acceptance \
  "${AUTH_ARGS[@]}"
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  if [[ "$BLOCKING" == "1" ]]; then
    echo "[fuzz] FAIL: Schemathesis が失敗を検出しました (FUZZ_BLOCKING=1)" >&2
    exit 1
  fi
  echo "[fuzz] WARN: Schemathesis が失敗を検出しました (非ブロッキング運用中。ログを確認して契約か実装を修正すること)"
  exit 0
fi
echo "[fuzz] PASS"
