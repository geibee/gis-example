#!/usr/bin/env bash
# cleanな一時directoryで、monorepoの生成物/cacheへ依存しない抽出ゲートを実行する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
temporary_root=$(mktemp -d -t feedback-extraction.XXXXXX)
gradle_home=$(mktemp -d -t feedback-gradle.XXXXXX)

cleanup() {
  for target in "$temporary_root" "$gradle_home"; do
    if [[ -d "$target" && "$(basename "$target")" == feedback-*.?????? ]]; then
      rm -rf -- "$target"
    fi
  done
}
trap cleanup EXIT

repository="$temporary_root/repository"
mkdir -p "$repository"
bash scripts/assemble-feedback-repository --output "$repository" >/dev/null

[[ ! -d "$repository/node_modules" ]] || { echo "抽出前からnode_modulesが存在します" >&2; exit 1; }
[[ ! -d "$repository/apps/feedback-service/build" ]] || { echo "抽出前からGradle buildが存在します" >&2; exit 1; }
[[ ! -d "$repository/apps/feedback-admin/dist" ]] || { echo "抽出前からdistが存在します" >&2; exit 1; }

(
  cd "$repository"
  npm ci --ignore-scripts --no-audit --no-fund
  GRADLE_USER_HOME="$gradle_home" \
    FEEDBACK_VERIFY_SKIP_NPM_CI=1 \
    bash scripts/verify-feedback.sh

  if [[ "${FEEDBACK_EXTRACTION_SKIP_DOCKER_BUILD:-0}" != "1" ]]; then
    docker build --no-cache -f apps/feedback-service/Dockerfile -t feedback-service:extraction-test .
    docker build --no-cache -f apps/feedback-admin/Dockerfile -t feedback-admin:extraction-test .
    docker build --no-cache -f apps/feedback-token-broker-reference/Dockerfile \
      -t feedback-token-broker-reference:extraction-test .
  fi
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
  if [[ "${FEEDBACK_EXTRACTION_SKIP_STANDALONE_SMOKE:-0}" != "1" ]]; then
    bash scripts/smoke-feedback-standalone.sh
  fi
)

echo "[feedback-extraction] PASS: $repository の外部file/生成物なしで検証しました"
