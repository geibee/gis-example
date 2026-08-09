#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

consumer="apps/feedback-conformance-consumer"
node -e '
  const value = require(`./${process.argv[1]}/package.json`);
  const dependencies = new Set(Object.keys(value.dependencies || {}));
  const expected = new Set(["@feedback/core", "@feedback/react", "react", "react-dom"]);
  if (!value.private || dependencies.size !== expected.size || [...dependencies].some((name) => !expected.has(name))) {
    process.exit(1);
  }
' "$consumer" || {
  echo "[feedback-conformance] FAIL: consumer 2 のruntime dependency境界が不正です" >&2
  exit 1
}

if rg -n '@web-gis|apps/api|gis_data|app\.(projects|users)|maplibre|projectId|systemRole|\b(viewer|editor)\b' \
  "$consumer/src" "$consumer/package.json"; then
  echo "[feedback-conformance] FAIL: consumer 2 にWeb GIS固有依存が混入しています" >&2
  exit 1
fi

if rg -n '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,})' "$consumer"; then
  echo "[feedback-conformance] FAIL: consumer 2 fixture に資格情報らしき値があります" >&2
  exit 1
fi

echo "[feedback-conformance] PASS: consumer 2 は独立package/router/token-exchange境界だけを使用しています"
