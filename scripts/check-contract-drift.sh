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

# 生成型が実際に使われていること (未使用のまま手書き型へ回帰するドリフト) も検知する。
# - src/contracts/index.ts が generated.ts を re-export していること
# - contracts (別名集約) が src の他モジュールから import されていること
if ! grep -q 'from "./generated"' src/contracts/index.ts 2>/dev/null; then
  echo "[contract-drift] FAIL: src/contracts/index.ts が generated.ts を re-export していません" >&2
  exit 1
fi
if ! grep -rq --include='*.ts' --include='*.tsx' \
     -e 'from "\./contracts' -e 'from "\.\./contracts' -e 'from "\.\./\.\./contracts' \
     --exclude-dir=contracts src; then
  echo "[contract-drift] FAIL: apps/web/src のどこからも contracts (生成型) が import されていません" >&2
  echo "  API クライアント・画面の型参照は src/contracts (openapi.yaml 由来) に一本化してください" >&2
  exit 1
fi
# 手書きサーバ契約型 (旧 src/types.ts) の復活を防ぐ
if [[ -f src/types.ts ]]; then
  echo "[contract-drift] FAIL: src/types.ts が存在します。サーバ契約型は生成型 (src/contracts) のみに置くこと" >&2
  exit 1
fi
echo "[contract-drift] PASS: 生成型は src/contracts 経由で参照されています"
