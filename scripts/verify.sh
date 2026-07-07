#!/usr/bin/env bash
# verify.sh — リポジトリ統合 verify ゲート (fail-closed)
#
# api (Kotlin) / worker (Python) / web (TypeScript) の変更スコープを判定し、
# 該当スコープの build / lint / typecheck / test を実行する。手動でも CI でも同じ入口を使う:
#
#   bash scripts/verify.sh                     # 変更スコープを自動判定 (基準: origin/main)
#   VERIFY_SCOPE=all bash scripts/verify.sh    # 全スコープ強制
#
# 設計原則 (fail-closed):
#   - 必要なツールチェーンが無い場合は「スキップして合格」ではなく失敗させる。
#     検証できなかったものを緑にしない
#   - スコープ判定で分類できないパスは全スコープを要求する (未知 = 全部検証)
#   - infra/postgres (スキーマ・シード) は api / worker 双方の共有契約なので両方を検証する
#   - PostGIS を要する統合テスト・E2E は本スクリプトの対象外 (将来 nightly に配置する)
#
# Env:
#   VERIFY_SCOPE        auto | all | api | worker | web   (default: auto)
#   VERIFY_BASE_REF     auto 判定の基準 ref                (default: origin/main)
#   VERIFY_DETECT_ONLY  1 ならスコープ判定だけ行い GITHUB_OUTPUT に出力して終了
#   VERIFY_INTEGRATION  1 なら軽量ゲートの代わりに統合ティアを実行する。
#                       api: gradle integrationTest (PostGIS を DATABASE_URL で指定)
#                       worker: pytest -m integration (PG* 環境変数 + ogr2ogr が必要)
#                       いずれも前提が無ければ失敗する (fail-closed)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SCOPE="${VERIFY_SCOPE:-auto}"
BASE_REF="${VERIFY_BASE_REF:-origin/main}"
INTEGRATION="${VERIFY_INTEGRATION:-0}"

log() { echo "[verify] $*"; }
fail() { echo "[verify] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- スコープ判定
NEED_API=0
NEED_WORKER=0
NEED_WEB=0

classify_paths() {
  local path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      apps/api/*)
        NEED_API=1 ;;
      apps/worker-gis/*)
        NEED_WORKER=1 ;;
      apps/web/*)
        NEED_WEB=1 ;;
      infra/postgres/*)
        # DB スキーマ・シードは api / worker の共有契約
        NEED_API=1; NEED_WORKER=1 ;;
      docs/* | *.md)
        ;; # ドキュメントのみの変更は検証対象外
      *)
        # 分類できないパス (ルート設定 / scripts / .github など) は全部検証する
        NEED_API=1; NEED_WORKER=1; NEED_WEB=1 ;;
    esac
  done
}

case "$SCOPE" in
  all)    NEED_API=1; NEED_WORKER=1; NEED_WEB=1 ;;
  api)    NEED_API=1 ;;
  worker) NEED_WORKER=1 ;;
  web)    NEED_WEB=1 ;;
  auto)
    if base=$(git merge-base HEAD "$BASE_REF" 2>/dev/null); then
      changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u )
      if [[ -z "$changed" ]]; then
        log "変更なし ($BASE_REF と同一) — 全スコープを検証します"
        NEED_API=1; NEED_WORKER=1; NEED_WEB=1
      else
        classify_paths <<<"$changed"
        log "変更ファイル ($(wc -l <<<"$changed") 件) から判定: api=$NEED_API worker=$NEED_WORKER web=$NEED_WEB"
      fi
    else
      log "基準 ref '$BASE_REF' を解決できません — 全スコープを検証します"
      NEED_API=1; NEED_WORKER=1; NEED_WEB=1
    fi
    ;;
  *) fail "不明な VERIFY_SCOPE: $SCOPE (auto | all | api | worker | web)" ;;
esac

if [[ "${VERIFY_DETECT_ONLY:-0}" == "1" ]]; then
  log "detect-only: api=$NEED_API worker=$NEED_WORKER web=$NEED_WEB"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "api=$NEED_API"
      echo "worker=$NEED_WORKER"
      echo "web=$NEED_WEB"
    } >>"$GITHUB_OUTPUT"
  fi
  exit 0
fi

if [[ $NEED_API -eq 0 && $NEED_WORKER -eq 0 && $NEED_WEB -eq 0 ]]; then
  log "PASS: 検証対象の変更なし (ドキュメントのみ)"
  exit 0
fi

# ---------------------------------------------------------------- api (Kotlin)
verify_api() {
  log "=== api (apps/api) ==="
  command -v gradle >/dev/null 2>&1 \
    || fail "gradle が見つかりません (fail-closed: api 変更は gradle なしで合格にできない)"

  pushd apps/api >/dev/null
  if [[ "$INTEGRATION" == "1" ]]; then
    # 統合ティア: PostGIS 実体に対する integrationTest
    [[ -n "${DATABASE_URL:-}" ]] \
      || fail "DATABASE_URL が未設定です (fail-closed: 統合テストは接続先なしで合格にできない)"
    gradle integrationTest --no-daemon
    log "api integration PASS"
  else
    # 軽量ゲート: build = compile (警告エラー化) + test (単体テスト)
    gradle build --no-daemon
    log "api PASS"
  fi
  popd >/dev/null
}

# ---------------------------------------------------------------- worker (Python)
verify_worker() {
  log "=== worker (apps/worker-gis) ==="
  local py="${VERIFY_PYTHON:-python3}"
  command -v "$py" >/dev/null 2>&1 \
    || fail "python3 が見つかりません (fail-closed: worker 変更は python なしで合格にできない)"
  for tool in ruff mypy pytest; do
    "$py" -m "$tool" --version >/dev/null 2>&1 \
      || fail "$tool が見つかりません (pip install ruff mypy pytest 'psycopg[binary]')"
  done

  pushd apps/worker-gis >/dev/null
  if [[ "$INTEGRATION" == "1" ]]; then
    # 統合ティア: GDAL + PostGIS 実体に対する取込ラウンドトリップ
    command -v ogr2ogr >/dev/null 2>&1 \
      || fail "ogr2ogr が見つかりません (fail-closed: apt install gdal-bin)"
    "$py" -m pytest -q -m integration
    log "worker integration PASS"
  else
    "$py" -m ruff check src tests
    "$py" -m ruff format --check src tests
    "$py" -m mypy
    "$py" -m pytest -q
    log "worker PASS"
  fi
  popd >/dev/null
}

# ---------------------------------------------------------------- web (TypeScript)
verify_web() {
  if [[ "$INTEGRATION" == "1" ]]; then
    log "web に統合ティアは未定義のためスキップします (E2E は今後 nightly に配置)"
    return 0
  fi
  log "=== web (apps/web) ==="
  command -v npm >/dev/null 2>&1 \
    || fail "npm が見つかりません (fail-closed: web 変更は npm なしで合格にできない)"

  # lockfile は npm workspaces のルートにあるため、ルートで npm ci を実行する
  npm ci
  npm --workspace apps/web run typecheck
  npm --workspace apps/web run build
  log "web PASS"
}

[[ $NEED_API    -eq 1 ]] && verify_api
[[ $NEED_WORKER -eq 1 ]] && verify_worker
[[ $NEED_WEB    -eq 1 ]] && verify_web

log "PASS: 統合 verify 完了 (api=$NEED_API worker=$NEED_WORKER web=$NEED_WEB)"
