# Web GIS MVP

PostGIS を正本データストアにした OSS ベースの Web GIS MVP です。初期版は GIS ファイル取込、MapLibre/Martin による表示、複数レイヤを使った条件検索、結果レイヤ保存に絞っています。

## Stack

- Web: React + TypeScript + MapLibre GL JS
- API: Ktor + PostgreSQL JDBC (business/query layer: condition search preview and analysis-job execution)
- GIS worker: Python + GDAL/OGR + psycopg (GIS ingestion only: file import into PostGIS)
- Tile server: API dynamic MVT endpoint for newly created layers, with Martin included in the stack for PostGIS tile serving
- DB: PostgreSQL + PostGIS
- Local runtime: Docker Compose

## Run

compose は**ローカル開発専用** (本番は ECS Fargate + Secrets Manager を前提とする。後述)。資格情報は `infra/.env` (gitignore 済み) から供給されるため、初回はテンプレートをコピーしてから起動する:

```bash
cp infra/.env.example infra/.env   # 初回のみ (dev 既定の資格情報)
docker compose -f infra/docker-compose.yml up --build
```

Services:

- Web: http://localhost:5173
- API health: http://localhost:8080/health
- Keycloak (OIDC IdP): http://localhost:8081 (管理コンソールは `infra/.env` の `KC_BOOTSTRAP_ADMIN_*`、既定 `admin` / `admin`)
- Martin: http://localhost:3000 (ループバックのみ)
- PostgreSQL: localhost:5432 (`infra/.env` の `POSTGRES_*`、既定 `gis` / `gis`、ループバックのみ)

Martin と PostgreSQL のホスト公開はローカル開発用に `127.0.0.1` バインドへ限定している。どちらも API の認可を迂回できる経路になるため、本番環境ではホストへ公開しないこと。

本番は ECS タスク定義の `secrets` (Secrets Manager / SSM Parameter Store) で同じ環境変数を注入する。全コンポーネントの環境変数一覧 (ECS タスク定義のインプット)・シークレットローテーション運用・dev シード混入ガード・ROPC の扱いは [`docs/environment-variables.md`](docs/environment-variables.md) を参照。

Uploaded files and generated runtime data are stored under `./data` (dev 既定の `UPLOAD_STORAGE=local`)。本番はアップロードを S3 に保存し、DB バックアップは RDS の自動バックアップ + PITR に委譲する — 構成とリストア runbook は [`docs/backup-restore.md`](docs/backup-restore.md) を参照。S3 経路は dev でも `infra/.env` の `UPLOAD_STORAGE=s3` + `docker compose --profile s3 up` (MinIO) で試せる。

## Bundled Tokyo Sample Data

Fresh PostgreSQL volumes are seeded automatically during `docker compose up` from the SQL dumps under `infra/postgres`.
The Web UI is immediately usable with these Tokyo layers:

- `地価公示 2023 東京`
- `小地域（町丁・字等）2020 東京`
- `坪単価200万以上の小地域`
- `商業地域・近隣商業地域 東京`

The same fresh seed also includes business-domain records for the condition-search UI:

- Lands: `L-0001` to `L-0003`
- Buildings: `B-0001` to `B-0002`
- Parties and relationships for owner, manager, and sales-party filters, including `銀座開発株式会社`
- Dense central Tokyo demo layers:
  - `登記所備付地図 土地筆（都心サンプル）`
  - `PLATEAU 建物（都心サンプル）`
  - `都心業務区域v1`
- Dense demo business records:
  - Lands: `L-DENSE-001` to `L-DENSE-036`
  - Buildings: `B-DENSE-001` to `B-DENSE-036`
  - Zones: `Z-DENSE-001` to `Z-DENSE-004`, each containing multiple linked lands and buildings
  - Parties: `P-DENSE-001` to `P-DENSE-011`, with generated relationships for zone party summaries and ranking

The GIS seed data is stored as PostGIS SQL dumps, not as the original source ZIP files. Source datasets:

- 国土数値情報 地価公示データ L01 2023 東京都
- 国土数値情報 用途地域データ A29 2019 東京都
- e-Stat 国勢調査 2020 小地域（町丁・字等）境界 東京都
- 法務省 登記所備付地図データ（G空間情報センターで公開）
- PLATEAU 3D都市モデル 建築物モデル

Seeding happens in two stages: the PostgreSQL entrypoint loads the self-contained GIS dump (010) only when the `postgres-data` volume is created, while seeds that depend on `app` tables (020/040/050/060/070) are applied by the one-shot `seed` Compose service after the API has applied the Flyway migrations. Each seed is guarded by a sentinel row, so repeated `docker compose up` runs do not re-apply it. If you need to recreate the bundled sample state from scratch, remove the existing Compose volume first.

Open-data fetch settings for the dense Tokyo demo live under `tools/open-data`.
The direct G空間情報センター download URLs are configuration values because they can change by release year and may require a logged-in session:

```bash
python3 tools/open-data/fetch_tokyo_core_open_data.py --cache-dir /tmp/tokyo-core-open-data
```

## Import Workflow

Use the left panel in the Web UI or call the API directly:

```bash
curl -F projectId=<project-id> \
  -F format=geojson \
  -F sourceSrid=4326 \
  -F file=@samples/geojson/parcels.geojson \
  http://localhost:8080/api/import-jobs
```

Supported initial formats are Shapefile zip, GML, KML, GPX, and GeoJSON. The worker loads data through GDAL/OGR into `gis_data.<layer_table>` and records metadata in the `app.layers` and `app.layer_attributes` tables.

`GET /api/tilejson/{layerId}` returns vector tile URLs backed by `GET /api/tiles/{layerId}/{z}/{x}/{y}`. This keeps imported and analysis-result layers visible immediately without restarting Martin. Martin remains available in the Compose stack for direct PostGIS tile serving and later production tuning.

## Analysis Criteria

`POST /api/features/condition-search` accepts a `ConditionQuery` and returns temporary feature matches grouped by `layerId`/`layerName` for UI review and map highlighting. `POST /api/analysis-jobs` also accepts `operation: "condition_search"` with the same `ConditionQuery`; a background runner inside the API claims the job from `app.analysis_jobs` and saves a result set and child result layers per source layer. The preview and the saved analysis share the same SQL predicate builder, so their results always match. Conditions are joined with AND in v1.

Analysis jobs are executed by the API process (`AnalysisJobRunner`, poll interval `ANALYSIS_POLL_INTERVAL_SECONDS`, default 2s). The Python worker handles import jobs only: format conversion via GDAL/OGR, reprojection to EPSG:3857, geometry normalization, and layer metadata registration. The PostGIS layer tables are the contract between the two: the worker produces normalized layers, the API queries them.

```json
{
  "projectId": "00000000-0000-0000-0000-000000000000",
  "targetLayerIds": ["a6dbb70e-1999-578f-904d-8f5c68513085"],
  "keyword": "商業地域",
  "conditions": [
    { "type": "attribute", "layerId": "a6dbb70e-1999-578f-904d-8f5c68513085", "field": "zoning_name", "operator": "LIKE", "value": "商業" },
    { "type": "spatial", "comparisonTarget": "business", "spatialOperator": "intersects" },
    { "type": "business", "sourceTypes": ["land"], "partyQuery": "銀座開発", "relationType": "売買事業者" }
  ],
  "limit": 100
}
```

Allowed spatial operators: `intersects`, `contains`, `within`, `dwithin`.

Allowed attribute operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `IN`, `IS NULL`.

## Database Migrations

スキーマ (`app.*`) の DDL は Flyway の versioned migration (`apps/api/src/main/resources/db/migration/V*.sql`) が SSoT。API 起動時に自動適用され、現在バージョンは `app.flyway_schema_history` で追跡できる。Flyway 導入前にテーブルが作成済みの既存 DB は初回起動時に自動で baseline (V1 適用済み扱い) され、以降の差分のみが適用される。V 番号の付け方・expand-contract (破壊的変更の段階分け)・既存 DB への導入手順は [`docs/db-migrations.md`](docs/db-migrations.md) を参照。

## Quality Gate

コミット前の統合ゲートは `scripts/verify.sh`(api / worker / web を変更スコープで自動判定、fail-closed)。GitHub Actions の `verify` ワークフローも同じスクリプトに委譲する。

```bash
bash scripts/verify.sh              # 変更スコープを自動判定 (基準: origin/main)
VERIFY_SCOPE=all bash scripts/verify.sh
```

| スコープ | 軽量ゲート | 統合ティア (`VERIFY_INTEGRATION=1`) |
|---|---|---|
| api | `gradle build`(Kotlin 警告エラー化 + 単体テスト) | `gradle integrationTest`: PostGIS 実体で空間演算子の境界ケース、プレビューと分析ジョブの一致、結果レイヤ契約、MVT 配信、失敗時ロールバックを検証 |
| worker | `ruff check` / `ruff format --check` / `mypy --strict` / `pytest` | `pytest -m integration`: GDAL 実取込のラウンドトリップ(レイヤ契約・zone 同期・破損入力の failed 記録) |
| web | `tsc --noEmit` + `vite build` | (未定義。E2E は今後 nightly に配置) |

統合ティアは CI では PostGIS サービスコンテナに対して実行される。ローカルで回す場合は接続情報を渡す:

```bash
DATABASE_URL=jdbc:postgresql://localhost:5432/gis DATABASE_USER=gis DATABASE_PASSWORD=gis \
  VERIFY_SCOPE=api VERIFY_INTEGRATION=1 bash scripts/verify.sh
PGHOST=localhost PGDATABASE=gis PGUSER=gis PGPASSWORD=gis \
  VERIFY_SCOPE=worker VERIFY_INTEGRATION=1 bash scripts/verify.sh   # 要 ogr2ogr (gdal-bin)
```

注意: 統合テストは接続先 DB の `app` / `gis_data` スキーマを削除して作り直す。開発データの入った DB に向けないこと。

nightly の重量ゲート(`.github/workflows/nightly.yml`、03:00 JST)は、セキュリティスキャン(gitleaks / Trivy / SBOM)、docker compose 全スタックに対するスモーク E2E(`scripts/smoke-e2e.sh`: 取込 → 検索 → 分析 → タイル)、API fuzz(Schemathesis、当面は非ブロッキング)を実行し、失敗時は `ci-nightly` ラベルの Issue に自動起票する。

## API Contract

`apps/api/openapi.yaml` が API 契約の SSoT。Spectral で lint し、`apps/web/src/contracts/generated.ts` を openapi-typescript で生成する(同期は `scripts/check-contract-drift.sh` が検査)。API を変更するときは仕様と生成型を同じコミットで更新する。

開発規約・アーキテクチャの分担は [`AGENTS.md`](AGENTS.md) を参照。

## Authentication

`/health` を除く全 API は OIDC の Bearer JWT による認証が必須。IdP は Keycloak を想定している (compose に開発用 realm 込みで含まれる。他の IdP も OIDC 準拠なら利用可)。

| 環境変数 (API) | 説明 |
|---|---|
| `OIDC_ISSUER` | トークンの `iss` クレームと一致すべき issuer (例 `http://localhost:8081/realms/gis`)。必須 |
| `OIDC_AUDIENCE` | トークンの `aud` に要求する値 (例 `gis-api`)。必須 |
| `OIDC_JWKS_URL` | JWKS の取得先。未設定時は Keycloak の既定パス (`$OIDC_ISSUER/protocol/openid-connect/certs`) |
| `AUTH_ADMIN_EMAILS` | カンマ区切り。この email のユーザーは初回ログイン時に system admin として登録される (初期管理者のブートストラップ用) |

認証に成功した subject は `app.users` へ初回アクセス時に自動登録 (JIT) される。`is_active = false` にすると即時にアクセスを止められる。

web は Authorization Code + PKCE でログインし (`oidc-client-ts` / `react-oidc-context`)、API 呼び出しと MapLibre のタイル取得 (`transformRequest`) に Bearer トークンを付与する。ビルド時の設定は `VITE_OIDC_AUTHORITY`(既定 `http://localhost:8081/realms/gis`)と `VITE_OIDC_CLIENT_ID`(既定 `gis-web`)。

開発 realm (`infra/keycloak/realm-gis.json`) のユーザー: `gis-admin` / `gis-editor` / `gis-viewer` (パスワードはユーザー名と同じ)。compose のシード (`infra/postgres/070-seed-dev-users.sql`) が gis-editor / gis-viewer を Default project のメンバーとして登録済み。この realm と seed は**ローカル開発専用**で、本番イメージには含まれない (`scripts/check-dev-seed-isolation.sh` が verify で毎回検査)。開発 realm の ROPC (`directAccessGrantsEnabled`) はスモーク E2E のトークン取得用で、**本番 realm では無効化必須** — 詳細は [`docs/environment-variables.md`](docs/environment-variables.md)。

## Authorization

認可は「メンバーシップ (誰がどのプロジェクトで何のロールか) は DB、ポリシー (ロールが何をできるか) はコード」の分離で実装している (`apps/api` の `AccessPolicy`)。判定は I/O を持たない純粋関数で、Cedar と同型の (principal, action, resource) モデルを取り、ロール × アクションの全組合せを単体テストが検査する。

| ロール | 範囲 | できること |
|---|---|---|
| system admin (`app.users.system_role`) | 全プロジェクト | すべて + ユーザー・メンバー管理 |
| editor (`app.project_members.role`) | プロジェクト単位 | 閲覧に加えて取込・分析・レイヤ / フィーチャ編集・業務データ編集 |
| viewer (`app.project_members.role`) | プロジェクト単位 | 閲覧のみ (一覧・検索・タイル・ジョブ状態) |

- メンバーでないプロジェクトのリソースへの個別アクセスは 404 (ID の存在自体を隠す)。メンバーだがロール不足の場合と、projectId を明示した操作の拒否は 403
- 一覧 API (`/api/layers` `/api/lands` `/api/buildings` `/api/parties` `/api/zones` `/api/features/search`) は `projectId` が必須
- `/api/projects` はメンバーであるプロジェクトのみ返す (admin は全件)
- 監査ログ (`app.audit_logs`): 変更系 (POST/PATCH/DELETE) の成功と、認証失敗・認可拒否 (401/403) を「誰が・いつ・どのアクションを・どのプロジェクトで」の形で記録する。閲覧成功は記録しない。書込みはベストエフォートで、失敗してもリクエストは落とさない
- 管理 API: `GET /api/me`(自分のロールとメンバーシップ)、admin 専用の `GET /api/users`・`PATCH /api/users/{id}`(system_role / is_active。自分自身は変更不可)・`GET/PUT/DELETE /api/projects/{id}/members/{userId}`。メンバーシップの変更は次のリクエストから即時反映される

## Notes

- API は `DATABASE_PASSWORD`(または `PGPASSWORD`)必須、worker は `PGPASSWORD` 必須。既定パスワードへのフォールバックはしない。全環境変数の一覧と本番 (ECS + Secrets Manager) での供給元は [`docs/environment-variables.md`](docs/environment-variables.md)。
- CORS の許可オリジンは `WEB_ORIGIN`(未設定時は `http://localhost:5173` のみ)。全開放 (`anyHost`) にはならない。
- アップロード上限は API 側 `UPLOAD_MAX_BYTES`(既定 200MB)と web の nginx `client_max_body_size 200m` で揃えている。
- API の SQL には `DATABASE_STATEMENT_TIMEOUT_MS`(既定 30 秒)の statement_timeout がかかる。分析ジョブ・区域レイヤ生成などの重い生成系処理はトランザクション内で `HEAVY_STATEMENT_TIMEOUT_MS`(既定 0 = 無制限)に差し替わる。
- 一覧 API (`/api/lands` `/api/buildings` `/api/parties` `/api/zones`) は `limit`(既定 200・最大 1000)と `offset` でページングし、フィルタ適用後の総件数を `X-Total-Count` ヘッダで返す。
- 実行中のままプロセスが落ちたジョブはリース期限で pending へ再キューされる: 取込ジョブは worker の `IMPORT_JOB_STALE_SECONDS`(既定 1800 秒)、分析ジョブは API の `ANALYSIS_JOB_STALE_SECONDS`(既定 1800 秒)。長時間かかる正当なジョブがある場合はこの値を延ばすこと。
- Imported and result geometries are stored in EPSG:3857 for Martin tile serving. Bboxes are exposed in EPSG:4326.
- Layer IDs, table names, geometry columns, attribute names, and operators are validated against DB metadata before jobs are accepted or executed.
