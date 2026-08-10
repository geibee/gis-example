#!/usr/bin/env bash
# 独立 Feedback API / JSON Schema / 生成型 / package 境界のドリフト検査。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

OPENAPI="contracts/feedback/openapi.yaml"
GENERATED="contracts/feedback/src/generated.ts"
[[ -f "$OPENAPI" ]] || { echo "[feedback-contract] FAIL: $OPENAPI がありません" >&2; exit 1; }
[[ -f "$GENERATED" ]] || { echo "[feedback-contract] FAIL: $GENERATED がありません" >&2; exit 1; }

go_legacy_journal=apps/feedback-service-go/migrations/legacyjournal/V1__feedback_v4_copy_journal.sql
[[ -f "$go_legacy_journal" ]] || {
  echo "[feedback-contract] FAIL: Go legacy migration journalがありません" >&2
  exit 1
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript "$OPENAPI" -o "$tmp" >/dev/null
if ! diff -u "$GENERATED" "$tmp"; then
  echo "[feedback-contract] FAIL: @feedback/contracts の生成型が専用OpenAPIと同期していません" >&2
  echo "  npm --workspace @feedback/contracts run generate を実行してください" >&2
  exit 1
fi

npx --no-install spectral lint --ruleset .spectral.yaml "$OPENAPI"
npx --no-install spectral lint --ruleset .spectral.yaml contracts/feedback/token-exchange.openapi.yaml

if grep -qE '^  /api/' "$OPENAPI"; then
  echo "[feedback-contract] FAIL: 専用契約にWeb GISの /api pathが混入しています" >&2
  exit 1
fi
if grep -qE '/(tiles|layers|lands|buildings|parties|zones|analysis-jobs|import-jobs)(/|:|$)' "$OPENAPI"; then
  echo "[feedback-contract] FAIL: 専用契約にGIS・業務endpointが混入しています" >&2
  exit 1
fi

for schema in contracts/feedback/schemas/*.json; do
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!value["$schema"] || !value["$id"]) process.exit(1)' "$schema" \
    || { echo "[feedback-contract] FAIL: $schema に \$schema / \$id がありません" >&2; exit 1; }
done

if rg -n '@web-gis|apps/api/openapi|projectId' \
  contracts/feedback/src packages/feedback-core/src packages/feedback-react/src packages/feedback-maplibre/src \
  packages/feedback-admin-react/src apps/feedback-admin/src apps/feedback-conformance-consumer/src; then
  echo "[feedback-contract] FAIL: 独立packageにWeb GIS固有契約が混入しています" >&2
  exit 1
fi
if rg -n '@web-gis|apps/api/openapi|projectId|app\.projects|app\.users|gis_data|org\.postgis|(^|[^A-Za-z0-9_])ST_[A-Za-z]+' \
  apps/feedback-service-go; then
  echo "[feedback-contract] FAIL: 独立 Feedback Service に Web GIS / PostGIS 固有依存が混入しています" >&2
  exit 1
fi
if rg -n 'maplibre' packages/feedback-react/package.json packages/feedback-react/src; then
  echo "[feedback-contract] FAIL: @feedback/react がMapLibreへ依存しています" >&2
  exit 1
fi
if rg -n 'style=|dangerouslySetInnerHTML|document\.head|<style' \
  packages/feedback-react/src packages/feedback-admin-react/src packages/feedback-maplibre/src; then
  echo "[feedback-contract] FAIL: strict CSPを壊すinline style/runtime style注入がpackageに混入しています" >&2
  exit 1
fi
if rg -n "from ['\"](react|react-dom|@tanstack/|maplibre-gl)|document\\.|window\\." packages/feedback-core/src; then
  echo "[feedback-contract] FAIL: @feedback/core にUI/runtime固有依存が混入しています" >&2
  exit 1
fi
node -e '
  const value = require("./packages/feedback-core/package.json");
  const forbidden = ["react", "react-dom", "@tanstack/react-query", "maplibre-gl"];
  if (forbidden.some((name) => value.dependencies?.[name] || value.peerDependencies?.[name])) process.exit(1);
' || { echo "[feedback-contract] FAIL: @feedback/core のpackage dependency境界が不正です" >&2; exit 1; }

undocumented_feedback_variables=$(comm -23 \
  <(rg -o -P --no-filename '(?<![A-Z0-9_])FEEDBACK_[A-Z][A-Z0-9_]+' \
    apps/feedback-* packages/feedback-* contracts/feedback deploy .github/workflows scripts \
    --glob '!**/node_modules/**' --glob '!**/build/**' --glob '!**/dist/**' \
    | rg -v '^(FEEDBACK_AUTH_NAME|FEEDBACK_EXCHANGE_AUTH_NAME)$' | LC_ALL=C sort -u) \
  <(rg -o --no-filename 'FEEDBACK_[A-Z][A-Z0-9_]+' docs/environment-variables.md | LC_ALL=C sort -u))
if [[ -n "$undocumented_feedback_variables" ]]; then
  echo "[feedback-contract] FAIL: docs/environment-variables.mdに未記載のFeedback変数があります" >&2
  echo "$undocumented_feedback_variables" >&2
  exit 1
fi

echo "[feedback-contract] PASS: 専用契約・生成型・package境界は同期しています"
