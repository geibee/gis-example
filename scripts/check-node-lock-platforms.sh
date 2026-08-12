#!/usr/bin/env bash
# ARM開発環境でlockfileを更新しても、x64本番・CI向けnative packageを欠落させない。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() { echo "[node-lock-platform] FAIL: $*" >&2; exit 1; }

node <<'NODE'
const lock = require("./package-lock.json");
const required = [
  "node_modules/@rollup/rollup-linux-arm64-gnu",
  "node_modules/@rollup/rollup-linux-arm64-musl",
  "node_modules/@rollup/rollup-linux-x64-gnu",
  "node_modules/@rollup/rollup-linux-x64-musl",
  "node_modules/@rolldown/binding-linux-arm64-gnu",
  "node_modules/@rolldown/binding-linux-arm64-musl",
  "node_modules/@rolldown/binding-linux-x64-gnu",
  "node_modules/@rolldown/binding-linux-x64-musl",
  "node_modules/@esbuild/linux-arm64",
  "node_modules/@esbuild/linux-x64",
  "node_modules/lightningcss-linux-arm64-gnu",
  "node_modules/lightningcss-linux-arm64-musl",
  "node_modules/lightningcss-linux-x64-gnu",
  "node_modules/lightningcss-linux-x64-musl"
];
const missing = required.filter((path) => !lock.packages?.[path]);
if (missing.length) {
  console.error(`[node-lock-platform] FAIL: platform別optional dependencyが不足しています:\n${missing.join("\n")}`);
  process.exit(1);
}
NODE

grep -Fq 'FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build' apps/web/Dockerfile \
  || fail "Web build stageがBUILDPLATFORMで実行されません"
grep -Fq 'FROM docker.io/library/nginx:1.27-alpine' apps/web/Dockerfile \
  || fail "Web runtime stageがtarget platform用nginx imageを使用していません"

echo "[node-lock-platform] PASS: arm64/amd64のnative packageとDocker platform境界が揃っています"
