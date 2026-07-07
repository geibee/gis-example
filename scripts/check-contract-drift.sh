#!/usr/bin/env bash
# 生成コードドリフト検査: apps/web/src/contracts/generated.ts が
# apps/api/openapi.yaml から再生成した結果と一致するかを検証する (fail-closed)。
# ずれていたら `npm --workspace apps/web run generate:contracts` を実行してコミットする
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/apps/web"

GENERATED="src/contracts/generated.ts"
[[ -f "$GENERATED" ]] || { echo "[contract-drift] FAIL: $GENERATED がありません (generate:contracts を実行してコミットすること)" >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript ../api/openapi.yaml -o "$tmp" >/dev/null

if ! diff -u "$GENERATED" "$tmp"; then
  echo "[contract-drift] FAIL: generated.ts が openapi.yaml と同期していません。" >&2
  echo "  npm --workspace apps/web run generate:contracts を実行してコミットしてください" >&2
  exit 1
fi
echo "[contract-drift] PASS: generated.ts は openapi.yaml と同期しています"
