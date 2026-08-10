#!/usr/bin/env bash
# 互換入口。Feedbackの正本抽出形状はGo-onlyなので同じJDKなしゲートへ委譲する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec bash scripts/check-feedback-go-only-extraction.sh
