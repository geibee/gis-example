#!/usr/bin/env bash
# 独立リポジトリから取り込んだ固定Feedback SDK artifactの改変を検出する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

check() {
  local expected="$1"
  local path="$2"
  [[ -f "$path" ]] || { echo "[feedback-sdk] FAIL: $path がありません" >&2; exit 1; }
  local actual
  actual=$(sha256sum "$path" | cut -d ' ' -f 1)
  [[ "$actual" == "$expected" ]] || {
    echo "[feedback-sdk] FAIL: $path のSHA-256が独立リポジトリのartifactと一致しません" >&2
    exit 1
  }
}

check 9c521930b8eb47e1957130e23351f6ecb1fb3e0798adc4cc6e7294b37d4304d1 \
  vendor/feedback-sdk/feedback-contracts-1.0.0-alpha.1.tgz
check cf9b90f6bd85ec562f9a44afb5a292a470edcd3de28f6abad4145bba3cbb48d9 \
  vendor/feedback-sdk/feedback-core-1.0.0-alpha.1.tgz

echo "[feedback-sdk] PASS: 固定artifactのSHA-256が一致しました"
