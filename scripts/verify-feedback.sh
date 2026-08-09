#!/usr/bin/env bash
# 独立Feedback repositoryと現monorepoの両方で使うfail-closed品質ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-verify] $*"; }
fail() { echo "[feedback-verify] FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.jsが見つかりません"
command -v npm >/dev/null 2>&1 || fail "npmが見つかりません"
command -v java >/dev/null 2>&1 || fail "JDKが見つかりません"
[[ -x apps/feedback-service/gradlew ]] || fail "Feedback ServiceのGradle wrapperがありません"

java_major=$(java -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')
[[ "$java_major" == "21" ]] || fail "JDK 21が必要です (検出: ${java_major:-unknown})"

feedback_gradle_home=""
if [[ -z "${GRADLE_USER_HOME:-}" ]]; then
  feedback_gradle_home=$(mktemp -d -t feedback-verify-gradle.XXXXXX)
  export GRADLE_USER_HOME="$feedback_gradle_home"
  cleanup_feedback_gradle_home() {
    if [[ -d "$feedback_gradle_home" && "$(basename "$feedback_gradle_home")" == feedback-verify-gradle.?????? ]]; then
      rm -rf -- "$feedback_gradle_home"
    fi
  }
  trap cleanup_feedback_gradle_home EXIT
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
(( node_major >= 22 )) || fail "Node.js 22以上が必要です"

if [[ "${FEEDBACK_VERIFY_SKIP_NPM_CI:-0}" != "1" ]]; then
  log "clean npm install"
  npm ci --ignore-scripts --no-audit --no-fund
fi

for package_name in @feedback/contracts @feedback/core @feedback/react @feedback/maplibre @feedback/admin-react; do
  log "$package_name"
  npm --workspace "$package_name" run typecheck
  npm --workspace "$package_name" run test
  npm --workspace "$package_name" run build
done

for application in @feedback/admin-console @feedback/token-broker-reference @feedback/conformance-consumer; do
  log "$application"
  npm --workspace "$application" run typecheck
  npm --workspace "$application" run test
  npm --workspace "$application" run build
done

bash scripts/check-feedback-contracts.sh
if [[ "${FEEDBACK_VERIFY_SKIP_PACKAGE_CONSUMERS:-0}" != "1" ]]; then
  bash scripts/check-feedback-packages.sh
fi
bash scripts/check-feedback-conformance.sh

log "Feedback Service"
(
  cd apps/feedback-service
  ./gradlew build --no-daemon
)

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
else
  fail "docker composeが見つからずstandalone構成を検証できません"
fi

log "PASS"
