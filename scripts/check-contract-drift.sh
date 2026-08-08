#!/usr/bin/env bash
# 生成コードドリフト検査: WebアプリとフィードバックSDKのgenerated.tsが
# apps/api/openapi.yamlから再生成した結果と一致するかを検証する (fail-closed)。
# ずれていたら `npm --workspace apps/web run generate:contracts` を実行してコミットする
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT/apps/web"

WEB_GENERATED="src/contracts/generated.ts"
SDK_GENERATED="$ROOT/packages/feedback-plugin/src/contracts/generated.ts"
for generated in "$WEB_GENERATED" "$SDK_GENERATED"; do
  [[ -f "$generated" ]] || { echo "[contract-drift] FAIL: $generated がありません (generate:contracts を実行してコミットすること)" >&2; exit 1; }
done

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript ../api/openapi.yaml -o "$tmp" >/dev/null

for generated in "$WEB_GENERATED" "$SDK_GENERATED"; do
  if ! diff -u "$generated" "$tmp"; then
    echo "[contract-drift] FAIL: $generated が openapi.yaml と同期していません。" >&2
    echo "  apps/web と @web-gis/feedback-plugin の generate:contracts を実行してください" >&2
    exit 1
  fi
done
echo "[contract-drift] PASS: WebアプリとSDKのgenerated.tsはopenapi.yamlと同期しています"

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

if ! grep -q 'from "./generated"' "$ROOT/packages/feedback-plugin/src/contracts/index.ts"; then
  echo "[contract-drift] FAIL: SDKのcontracts/index.tsがgenerated.tsを参照していません" >&2
  exit 1
fi
echo "[contract-drift] PASS: SDKも生成型を参照しています"
