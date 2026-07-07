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

## GIS 規約

- 格納 SRID は **3857**、公開する bbox は **4326** (`bbox_4326`)
- 動的 SQL の識別子は必ず `quoteIdent` (Kotlin) / `quote_ident` (Python) を通す。値は必ずバインドパラメータ
- 属性演算子・空間演算子は allowlist 検証 (`AnalysisValidator.kt` / `validateConditionSearchConditions`) を通ったものだけを SQL 化する
- ジオメトリの等価比較をテストで書くときは完全一致ではなく許容誤差付きで行う

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
- E2E・ビジュアルリグレッション・重量級検査(fuzz / セキュリティスキャン)は今後 nightly ゲートとして追加する。verify.sh の軽量ゲートに混ぜない

## テスト方針

- 純粋関数(SQL 述語生成・識別子クォート・テーブル名生成など)は DB 不要の単体テストを書く
  - Kotlin: `apps/api/src/test/kotlin/`
  - Python: `apps/worker-gis/tests/`
- SQL インジェクション境界(`quoteIdent` / 演算子 allowlist)の変更時は必ず対応するテストを更新する
- criteria JSON など永続化するデータの形を変えるときは、ラウンドトリップ互換テスト(`AnalysisJobCriteriaTest`)を更新する
