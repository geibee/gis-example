#!/usr/bin/env bash
# 独立Feedback repositoryと現monorepoの両方で使うfail-closed品質ゲート。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

log() { echo "[feedback-verify] $*"; }
fail() { echo "[feedback-verify] FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.jsが見つかりません"
command -v npm >/dev/null 2>&1 || fail "npmが見つかりません"
command -v go >/dev/null 2>&1 || fail "Goが見つかりません"

[[ ! -d apps/feedback-service ]] || fail "廃止済みKotlin Feedback Serviceが混入しています"
[[ -f apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql ]] ||
  fail "Go-only Feedback Serviceにfresh baselineがありません"
if rg -n 'apps/feedback-service/Dockerfile|eclipse-temurin|openjdk|gradle:' deploy \
    apps/feedback-service-go/Dockerfile >/dev/null; then
  fail "Feedback Serviceのbuild/runtime経路にJDKまたはKotlin image参照があります"
fi
log "Go-only Feedback ServiceをJDKなしで検証します"

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
(( node_major >= 22 )) || fail "Node.js 22以上が必要です"

bash scripts/verify-feedback-go.sh

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

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml \
    --profile go-migration config --format json | node -e '
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync(0, "utf8"));
      const names = [
        "feedback-migrate", "feedback-service", "feedback-bootstrap-east", "feedback-bootstrap-west",
        "feedback-notification-worker", "feedback-webhook-connector", "feedback-connector-register",
        "feedback-export-worker", "feedback-retention-worker",
      ];
      for (const name of names) {
        const service = config.services?.[name];
        if (!service) throw new Error(`Feedback runtime serviceがありません: ${name}`);
        if (Number(service.cpus) !== 1) throw new Error(`CPU limit 1.0が未設定です: ${name}`);
        if (Number(service.mem_limit) !== 536870912) throw new Error(`memory limit 512MiBが未設定です: ${name}`);
        if (service.read_only !== true) throw new Error(`read_onlyが未設定です: ${name}`);
        if (!service.cap_drop?.includes("ALL")) throw new Error(`cap_drop ALLが未設定です: ${name}`);
        if (!service.security_opt?.includes("no-new-privileges:true")) {
          throw new Error(`no-new-privilegesが未設定です: ${name}`);
        }
        if (!service.tmpfs?.some((value) => value.startsWith("/tmp:"))) {
          throw new Error(`制限付き/tmp tmpfsが未設定です: ${name}`);
        }
      }
    '
else
  fail "docker composeが見つからずstandalone構成を検証できません"
fi

log "PASS"
