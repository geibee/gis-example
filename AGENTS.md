# 開発ガイド (エージェント向け)

## 言語

- 本リポジトリの主要言語は日本語。ドキュメント・コミットメッセージ・コメントは日本語で記述する
- コード上の識別子(型名・関数名・変数名)は英語

## アーキテクチャの分担

**「Python はテーブルを産み、Kotlin はテーブルを問う」** を守ること。

| コンポーネント | 責務 |
|---|---|
| `apps/worker-gis` (Python) | GIS 取込のみ: ogr2ogr 変換、EPSG:3857 への正規化、`ST_MakeValid`、レイヤメタデータ登録 |
| `apps/api` (Kotlin) | 業務・クエリ層のすべて: 条件検索(プレビューと分析ジョブ実体化の両方)、CRUD、MVT 配信、ジョブ実行 (`AnalysisJobRunner`) |
| PostGIS | 両者の共有契約。「レイヤ契約」= geom は 3857・valid・GiST インデックス・`app.layers`/`app.layer_attributes` 登録済み |

- 業務条件の解釈を worker に書かない。分析・検索 SQL は Kotlin 側の単一実装 (`conditionSearchFilters`) に寄せる
- ジオメトリを JVM / Python プロセス内で解釈しない。空間演算は PostGIS の SQL で行う

## 認証・認可

- 認証は OIDC の Bearer JWT (`Auth.kt`)。`/health` 以外のルートは必ず `authenticate(OIDC_AUTH_NAME)` の内側に置く
- 認可の設計原則は **「可変データは DB、ポリシーはコード」**:
  - 誰がどのプロジェクトのメンバーか (`app.users` / `app.project_members`) は DB
  - ロールが何をできるか (`Action` × ロールのマトリクス) は `Authorization.kt` の純粋関数 `AccessPolicy.allows`。判定に I/O を持ち込まない
- エンドポイントを追加するときは必ず: (1) いずれかの `Action` へ割り当てて PEP (`requireProjectPermission` / `requireResourcePermission` / `requireSystemPermission`) を呼ぶ、(2) `AccessPolicyTest` の期待表を更新する、(3) openapi.yaml に 401/403 を記載する
- ステータスの使い分け: 非メンバーへの個別リソースは 404 (存在を隠す)、メンバーのロール不足と projectId 明示操作の拒否は 403
- 監査ログ (`AuditLog.kt`) は mutate 成功と 401/403 を記録する。PEP が action / projectId を call attributes へ残す前提を崩さない

## GIS 規約

- 格納 SRID は **3857**、公開する bbox は **4326** (`bbox_4326`)
- 動的 SQL の識別子は必ず `quoteIdent` (Kotlin) / `quote_ident` (Python) を通す。値は必ずバインドパラメータ
- 属性演算子・空間演算子は allowlist 検証 (`AnalysisValidator.kt` / `validateConditionSearchConditions`) を通ったものだけを SQL 化する
- ジオメトリの等価比較をテストで書くときは完全一致ではなく許容誤差付きで行う

## スキーマ変更 (DB マイグレーション)

DDL の SSoT は Flyway の versioned migration (`apps/api/src/main/resources/db/migration/V*.sql`)。
運用ルールの詳細は [`docs/db-migrations.md`](docs/db-migrations.md)。

- スキーマ変更は必ず `V<最大値+1>__<内容>.sql` の追加で行う。起動コードに DDL を書かない
  (`CREATE TABLE IF NOT EXISTS` を起動時に流す旧 `SchemaSetup.kt` 方式は廃止済み)
- **適用済みマイグレーションは編集・削除しない** (チェックサム不一致で起動が止まる)。
  修正も新しいマイグレーションの追加で行う
- 破壊的変更 (列削除・リネーム・型変更) は **expand-contract** で段階を分ける:
  (1) expand: 新列を NULL 許容/DEFAULT 付きで追加 → (2) アプリを両対応にして backfill →
  (3) contract: 全インスタンス移行後の次リリースで旧列を削除。単発の `RENAME COLUMN` は禁止
  (ローリングデプロイ中の旧アプリが即死する)
- `infra/postgres/init.sql` は拡張・スキーマ作成のみ (initdb 用)。テーブル DDL を書き足さない。
  app テーブルに依存する開発シードは compose の `seed` サービス (`seed-dev-data.sh`) に置く
- マイグレーションの適用検証は統合ティアの `MigrationIntegrationTest`
  (クリーン DB 全適用 / 既存 DB baseline / スキーマ収束) が行う

## 品質ゲート

コミット前の統合ゲートは `scripts/verify.sh`(api / worker / web を変更スコープで自動判定、fail-closed)。

```bash
bash scripts/verify.sh              # 変更スコープを自動判定
VERIFY_SCOPE=all bash scripts/verify.sh
```

- **fail-closed**: ツールチェーンが無い環境では「スキップして合格」にせず失敗させる。検証できなかったものを緑にしない
- GitHub Actions (`.github/workflows/verify.yml`) は同じ verify.sh に委譲する。CI とローカルでゲートを乖離させない
- スコープ別の内訳:
  - api: `gradle build`(警告エラー化 + 単体テスト)
  - worker: `ruff check` / `ruff format --check` / `mypy --strict` / `pytest`
  - web: `tsc --noEmit` + `vite build`
- **統合ティア** (`VERIFY_INTEGRATION=1`): PostGIS 実体に対するテスト。CI ではサービスコンテナで自動実行される
  - api: `gradle integrationTest`(`@Tag("integration")` の JUnit テスト。`DATABASE_URL` 必須)
  - worker: `pytest -m integration`(GDAL 実取込。`PG*` 環境変数 + `ogr2ogr` 必須)
  - 統合テストは接続先の `app` / `gis_data` スキーマを DROP して作り直す。開発 DB に向けない
- **nightly 重量ゲート** (`.github/workflows/nightly.yml`、03:00 JST + workflow_dispatch):
  - security: gitleaks(git 履歴全体)/ Trivy(HIGH,CRITICAL で失敗)/ SBOM(CycloneDX)。SARIF は run のアーティファクト
  - smoke-e2e: `scripts/smoke-e2e.sh` が docker compose 全スタックで「取込 → 検索プレビュー → 分析実体化(プレビューと件数一致)→ タイル配信」を検証。ローカルは `SMOKE_MANAGE_COMPOSE=0` で起動済みスタックに対して実行できる
  - 失敗時は `ci-nightly` ラベルの Issue に自動起票(既存 open Issue にはコメント追記)。**Issue を閉じる前に原因への恒久対応(ゲート強化・依存更新)を済ませること**
  - api-fuzz: Schemathesis が `apps/api/openapi.yaml` から入力を生成して実 API を検査(固定 seed 42)。既知の失敗クラス(不正 UUID で 500 等)が残っているため**当面は非ブロッキング**(`scripts/fuzz-api.sh`、`FUZZ_BLOCKING=0`)。失敗クラスを潰し切ったら `FUZZ_BLOCKING=1` に昇格する
- ビジュアルリグレッションは今後 nightly へ追加予定。verify.sh の軽量ゲートに混ぜない

## API 契約 (OpenAPI)

`apps/api/openapi.yaml` が API 契約の SSoT。

- **API のエンドポイント・DTO を変えたら同じコミットで openapi.yaml を更新する**
- 型は `npm --workspace apps/web run generate:contracts` で `apps/web/src/contracts/generated.ts` に生成してコミットする(ドリフトは verify.sh の web スコープで fail)
- 仕様の静的検査は Spectral(`npm --workspace apps/web run lint:contracts`)
- web クライアント(`api.ts` / `types.ts`)は段階的に `contracts/generated.ts` の型へ移行する(手書き型と生成型の二重管理は移行期間のみ許容)

## テスト方針

- 純粋関数(SQL 述語生成・識別子クォート・テーブル名生成など)は DB 不要の単体テストを書く
  - Kotlin: `apps/api/src/test/kotlin/`
  - Python: `apps/worker-gis/tests/`
- SQL インジェクション境界(`quoteIdent` / 演算子 allowlist)の変更時は必ず対応するテストを更新する
- criteria JSON など永続化するデータの形を変えるときは、ラウンドトリップ互換テスト(`AnalysisJobCriteriaTest`)を更新する
