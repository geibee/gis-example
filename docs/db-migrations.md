# DB スキーママイグレーション運用 (Flyway)

スキーマ (app.*) の DDL は Flyway の versioned migration で管理する (issue #12)。

- **SSoT**: `apps/api/src/main/resources/db/migration/V*.sql`
- **適用タイミング**: API 起動時に `migrateSchema()` (`SchemaMigration.kt`) が自動適用する。
  Flyway CLI や専用コンテナは使わない (アプリ内蔵 migrate)
- **履歴**: `app.flyway_schema_history` で現在バージョンと適用履歴を追跡できる
- アプリは起動時に migrate 以外の DDL を発行しない。`CREATE TABLE IF NOT EXISTS` を
  起動コードへ追記する旧方式 (`SchemaSetup.kt`) は廃止した

## バージョン番号の付け方

- ファイル名は `V<番号>__<内容のスネークケース>.sql` (例: `V3__add_lands_survey_status.sql`)。
  区切りはアンダースコア 2 つ
- 番号は既存の最大値 + 1 の整数を使う。枝番 (`V3_1`) はホットフィックスのブランチ運用が
  必要になるまで使わない
- **適用済みマイグレーションは編集・削除しない** (Flyway がチェックサム不一致で起動を止める)。
  間違えた場合も打ち消しの新しいマイグレーションを追加する
- 1 マイグレーション = 1 関心事。無関係な変更を 1 ファイルに混ぜない
- データ補正 (UPDATE/backfill) も versioned migration に書く。ただし大量データの backfill は
  ロック時間を考慮して分割する

## 後方互換の書き方 (expand-contract)

ローリングデプロイ中は「旧アプリ + 新スキーマ」が同時に動く。破壊的変更
(列の削除・リネーム・型変更) は 1 リリースで行わず、必ず段階を分ける:

1. **expand**: 新しい列・テーブルを追加する (NULL 許容または DEFAULT 付き)。
   旧アプリはこの変更に気づかず動き続ける
2. **移行**: アプリを新旧両方へ書く (または新へ書き旧から読む) バージョンに更新し、
   既存データを backfill する
3. **contract**: 全インスタンスが新列だけを使うようになった後のリリースで、
   旧列を削除するマイグレーションを追加する

してはいけない例: `ALTER TABLE ... RENAME COLUMN` を単発で適用する
(旧アプリの SQL が即座に壊れる)。リネームは「新列追加 → 両書き → 旧列削除」で実現する。

`NOT NULL` の追加は「NULL 許容で追加 → backfill → `SET NOT NULL`」の順
(V1 導入前の `SchemaSetup.kt:151-157` にあった zones の補正がこのパターンの例)。

## 既存 DB (Flyway 導入前) への導入手順

Flyway 導入前にテーブルが作成済みの環境 (init.sql + 旧 SchemaSetup.kt で構築された DB)
には `baselineOnMigrate=true` / `baselineVersion=1` を設定済みのため、**新しい API を
起動するだけでよい**。初回 migrate 時に次が起こる:

1. `app.flyway_schema_history` が無く `app` スキーマが空でないことを検知する
2. V1 (導入時点の到達スキーマを凍結したもの) を「適用済み」として baseline 記録する
3. V2 以降の差分のみを適用する

導入後の確認:

```sql
SELECT installed_rank, version, description, type, success
FROM app.flyway_schema_history ORDER BY installed_rank;
-- type = 'BASELINE' の version 1 と、それ以降の 'SQL' 行が success = true であること
```

クリーン環境 (空の app スキーマ) では baseline は発生せず V1 から全適用される。
両経路が同一スキーマへ収束することは CI の統合テスト
(`MigrationIntegrationTest`) が毎回検証する。

## 拡張 (EXTENSION) とスキーマの扱い

- `CREATE EXTENSION` は superuser 権限が必要になり得るため、開発 compose では
  `infra/postgres/init.sql` (initdb、superuser で実行) が `postgis` / `pgcrypto` /
  `pg_trgm` を作成する
- V1 にも `CREATE EXTENSION IF NOT EXISTS pg_trgm` を置いているが、これは作成済みなら
  権限チェックなしでスキップされる保険。アプリユーザーに拡張作成権限が無い本番環境では、
  **DBA が事前に拡張を作成しておくこと**
- `app` スキーマは Flyway が、`gis_data` スキーマは init.sql と V1 (`IF NOT EXISTS`) が作る

## 開発シードとの関係

initdb スクリプト (`docker-entrypoint-initdb.d`) は postgres ボリューム初回作成時にしか
走らず、その時点では Flyway 未適用でテーブルが無い。そのため:

- **initdb に残るもの**: `init.sql` (拡張・スキーマ) と、app テーブルに依存しない
  GIS データ `010` (gis_data に自前でテーブルを作る pg_dump)
- **seed サービスが投入するもの**: app テーブルに依存する `020` / `040` / `050` / `060` / `070`。
  compose の one-shot サービス `seed` (`infra/postgres/seed-dev-data.sh`) が
  マイグレーション適用完了 (Default project の出現) を待ってから投入する。
  各シードはセンチネル行の有無で冪等化されており、`docker compose up` を繰り返しても
  再適用されない
- 既定プロジェクト (`Default project`) はシードではなくスキーマと不可分の参照データとして
  V1 が投入する

## CI での検証

- 軽量ゲート (`scripts/verify.sh`, api スコープ): コンパイルと単体テスト
- 統合ティア (`VERIFY_INTEGRATION=1`, CI の api integration ジョブ):
  `MigrationIntegrationTest` が「クリーン DB への全適用」「既存 DB への baseline 導入と
  差分適用」「再実行が no-op」「両経路のスキーマ収束」を PostGIS 実体で検証する。
  他の統合テストも `init.sql → migrateSchema()` の順でスキーマを作るため、
  マイグレーションが壊れていれば全て失敗する
- worker の統合テストも同じ `V*.sql` を適用してから取込を検証する (DDL の二重管理なし)
