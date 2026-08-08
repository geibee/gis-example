#!/usr/bin/env bash
# 独立 Feedback API / JSON Schema / 生成型 / package 境界のドリフト検査。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

OPENAPI="contracts/feedback/openapi.yaml"
GENERATED="contracts/feedback/src/generated.ts"
[[ -f "$OPENAPI" ]] || { echo "[feedback-contract] FAIL: $OPENAPI がありません" >&2; exit 1; }
[[ -f "$GENERATED" ]] || { echo "[feedback-contract] FAIL: $GENERATED がありません" >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
npx --no-install openapi-typescript "$OPENAPI" -o "$tmp" >/dev/null
if ! diff -u "$GENERATED" "$tmp"; then
  echo "[feedback-contract] FAIL: @feedback/contracts の生成型が専用OpenAPIと同期していません" >&2
  echo "  npm --workspace @feedback/contracts run generate を実行してください" >&2
  exit 1
fi

npx --no-install spectral lint --ruleset .spectral.yaml "$OPENAPI"

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
if rg -n '@web-gis|apps/api/openapi|projectId|app\.projects|app\.users|gis_data|org\.postgis|ST_[A-Za-z]+' \
  apps/feedback-service/src/main; then
  echo "[feedback-contract] FAIL: 独立 Feedback Service に Web GIS / PostGIS 固有依存が混入しています" >&2
  exit 1
fi
if rg -n 'maplibre' packages/feedback-react/package.json packages/feedback-react/src; then
  echo "[feedback-contract] FAIL: @feedback/react がMapLibreへ依存しています" >&2
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

echo "[feedback-contract] PASS: 専用契約・生成型・package境界は同期しています"
