#!/usr/bin/env bash
# check-dev-seed-isolation.sh — dev シード・開発 realm の本番混入ガード (fail-closed)
#
# 開発専用の弱い資格情報 (infra/keycloak/realm-gis.json の gis-admin 等、
# infra/postgres/070-seed-dev-users.sql) が本番用イメージ・アプリ本体コードへ
# 混入しない構造を検査する。scripts/verify.sh から毎回実行される。
#
# 検査内容:
#   1. 本番イメージの Dockerfile (apps/api, apps/worker-gis, apps/web) が
#      infra/ 配下 (シード SQL・realm JSON) を COPY/ADD しないこと
#      (web の build context はリポジトリルートのため、構造的に到達可能な点に注意)
#   2. 開発ユーザーの識別子 (固定 UUID prefix / @gis.example / gis-admin 等) が
#      アプリ本体コード (apps/*/src の非テストコード。Flyway マイグレーション含む)
#      に現れないこと — 「dev ユーザーはシードでのみ作られる」構造の維持
#   3. dev 資格情報ファイル infra/.env が git 管理に入らないこと
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

log() { echo "[seed-guard] $*"; }
fail() { echo "[seed-guard] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------- 1. 本番 Dockerfile の検査
PROD_DOCKERFILES=(apps/api/Dockerfile apps/worker-gis/Dockerfile apps/web/Dockerfile)
for df in "${PROD_DOCKERFILES[@]}"; do
  [[ -f "$df" ]] || fail "$df が見つかりません (本番 Dockerfile の配置が変わった場合はこのスクリプトを更新すること)"
  if hits=$(grep -inE '^[[:space:]]*(COPY|ADD)[[:space:]]' "$df" | grep -iE 'infra/|realm|seed'); then
    fail "$df が dev シード / realm に到達しています:"$'\n'"$hits"
  fi
done
log "OK: 本番 Dockerfile は infra/ のシード・realm を参照しない"

# ------------------------------------- 2. 開発ユーザー識別子の混入検査
# 識別子の正: infra/keycloak/realm-gis.json / infra/postgres/070-seed-dev-users.sql
MARKERS='a0000000-0000-4000-8000|@gis\.example|gis-admin|gis-editor|gis-viewer'
# 検査対象はアプリ本体コードのみ (テストコードは dev 固定 ID の利用を許容する)
mapfile -t hits < <(git grep -lE "$MARKERS" -- \
  'apps/api/src/main' 'apps/worker-gis/src' 'apps/web/src' 2>/dev/null || true)
if ((${#hits[@]} > 0)); then
  fail "開発ユーザーの識別子がアプリ本体コードに混入しています (シード / テスト以外に置かない): ${hits[*]}"
fi
log "OK: 開発ユーザーの識別子はアプリ本体コードに存在しない"

# ------------------------------------- 3. dev 資格情報ファイルの git 混入検査
if git ls-files --error-unmatch infra/.env >/dev/null 2>&1; then
  fail "infra/.env が git 管理に入っています (資格情報はコミットしない。git rm --cached infra/.env)"
fi
git check-ignore -q infra/.env \
  || fail "infra/.env が gitignore されていません (.gitignore の .env ルールを確認)"
log "OK: infra/.env は git 管理外 (gitignore 済み)"

log "PASS: dev シードの本番混入ガード"
