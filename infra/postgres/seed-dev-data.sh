#!/usr/bin/env bash
# seed-dev-data.sh — 開発用シードの投入 (compose の one-shot サービス seed が実行)
#
# テーブル DDL は API 起動時の Flyway マイグレーションが作るため、initdb 時ではなく
# 「マイグレーション適用後」にシードを流す必要がある。app テーブルに依存しない
# GIS データ (010) だけは従来どおり initdb (docker-entrypoint-initdb.d) に残る。
#
# 各シードはセンチネル行の有無で冪等化しており、`docker compose up` を繰り返しても
# 一度投入したシードは再適用しない (従来の「initdb 時に一度だけ」と同じ意味論)。
# 本番環境ではこのサービスごと外すこと (070 のコメント参照)
set -euo pipefail

SEED_DIR="${SEED_DIR:-/seed}"
DEFAULT_PROJECT_ID="00000000-0000-0000-0000-000000000000"

log() { echo "[seed] $*"; }
fail() { echo "[seed] FAIL: $*" >&2; exit 1; }

query() { # 単一クエリを実行して結果 (tuples only) を返す
  psql -v ON_ERROR_STOP=1 -tA -c "$1"
}

log "Flyway マイグレーション適用待ち (API 起動時に app.projects が作られる)"
ready=0
for _ in $(seq 1 120); do
  if [[ "$(query "SELECT count(*) FROM app.projects WHERE id = '$DEFAULT_PROJECT_ID'" 2>/dev/null)" == "1" ]]; then
    ready=1
    break
  fi
  sleep 5
done
[[ "$ready" == "1" ]] || fail "マイグレーションが適用されません (api コンテナのログを確認)"

apply_once() { # $1=シード名 $2=センチネル (結果が非空ならスキップ) $3=ファイル
  local name="$1" sentinel="$2" file="$3"
  if [[ -n "$(query "$sentinel")" ]]; then
    log "skip: $name (適用済み)"
    return 0
  fi
  log "apply: $name"
  # -1 (単一トランザクション) で「途中まで適用された」状態を作らない。
  # センチネル判定はシード全体の適用完了と同値になる
  case "$file" in
    *.gz) zcat "$file" | psql -v ON_ERROR_STOP=1 -q -1 ;;
    *) psql -v ON_ERROR_STOP=1 -q -1 -f "$file" ;;
  esac
}

apply_once "020-seed-tokyo-metadata" \
  "SELECT 1 FROM app.layers WHERE id = '54240d3d-0b3d-4d66-9f6d-07af52c6df5a'" \
  "$SEED_DIR/020-seed-tokyo-metadata.sql.gz"
apply_once "040-seed-tokyo-commercial-zoning" \
  "SELECT 1 FROM app.layers WHERE id = 'a6dbb70e-1999-578f-904d-8f5c68513085'" \
  "$SEED_DIR/040-seed-tokyo-commercial-zoning.sql.gz"
apply_once "050-seed-business-data" \
  "SELECT 1 FROM app.lands WHERE id = 'L-0001'" \
  "$SEED_DIR/050-seed-business-data.sql"
apply_once "060-seed-dense-tokyo-business-demo" \
  "SELECT 1 FROM app.layers WHERE id = 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'" \
  "$SEED_DIR/060-seed-dense-tokyo-business-demo.sql"
apply_once "070-seed-dev-users" \
  "SELECT 1 FROM app.users WHERE subject = 'a0000000-0000-4000-8000-000000000001'" \
  "$SEED_DIR/070-seed-dev-users.sql"

log "PASS: 開発用シードの投入完了"
