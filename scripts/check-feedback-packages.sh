#!/usr/bin/env bash
# publish 前に各 package の tarball 構成と公開可否 metadata を検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

packages=(
  @feedback/contracts
  @feedback/core
  @feedback/react
  @feedback/maplibre
)

for package_name in "${packages[@]}"; do
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const entry = Object.values(lock.packages).find((value) => value && value.name === process.argv[1]);
    if (!entry || entry.private === true) process.exit(1);
  ' "$package_name" || { echo "[feedback-package] FAIL: $package_name を公開可能なworkspaceとして解決できません" >&2; exit 1; }
  pack_result=$(npm --workspace "$package_name" pack --dry-run --json)
  PACK_RESULT="$pack_result" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    const files = new Set(result.files.map((file) => file.path));
    if (!files.has("dist/index.js") || !files.has("dist/index.d.ts") || !files.has("package.json")) process.exit(1);
  ' || { echo "[feedback-package] FAIL: $package_name のtarballにJS/types/metadataが揃っていません" >&2; exit 1; }
  echo "[feedback-package] PASS: $package_name"
done
