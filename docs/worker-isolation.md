# worker-gis の隔離実行要件 (AWS ネットワーク隔離)

GIS 取込 worker (apps/worker-gis) は**ユーザーがアップロードしたファイルを GDAL (ogr2ogr) に
食わせる**という性質上、リポジトリ内で最も攻撃面の広いコンポーネントである。防御は 2 層で行う:

1. **コード側の入力防御** (issue #19、本リポジトリで実装済み — 下記「コード側防御の一覧」)
2. **AWS 側のネットワーク隔離** (本ドキュメント — infra 構築のインプット)。
   コード側防御が破られても「外部へ出る経路が存在しない」ことで実害を無害化する

## 実行形態

- ECS Fargate のサービスとして常駐 (ポーリング型。inbound を一切受けない — リッスンポートなし)
- **egress なしの private subnet** に配置する:
  - ルートテーブルに NAT Gateway / Internet Gateway への経路を持たない
  - 必要な AWS サービスへは **VPC エンドポイント経由のみ**で到達する
- セキュリティグループ:
  - inbound: なし (全拒否)
  - outbound: RDS の SG への 5432、VPC エンドポイントの SG への 443 のみ許可
    (`0.0.0.0/0` への outbound を残さない)

## 必要な宛先の完全列挙

worker タスクが到達する必要がある宛先は以下で**すべて**である。これ以外への通信は
発生しない設計であり、経路も用意しない。

| 宛先 | 用途 | 到達手段 |
|---|---|---|
| RDS (PostGIS) | ジョブ claim・取込先・メタデータ登録 (`PG*` env) | VPC 内直接 (RDS の SG で worker SG からの 5432 のみ許可)。エンドポイント不要 |
| S3 (アップロードバケット) | `s3://` 参照のアップロード取得 (boto3) | **Gateway VPC エンドポイント** `com.amazonaws.<region>.s3`。エンドポイントポリシーでアップロードバケットに限定する |
| Secrets Manager | タスク定義 `secrets.valueFrom` による `PGPASSWORD` 等の注入 (タスク起動時に Fargate プラットフォームがタスク ENI 経由で解決する) | **Interface VPC エンドポイント** `com.amazonaws.<region>.secretsmanager` |
| CloudWatch Logs | `awslogs` ログドライバの出力 (LOG_FORMAT=json) | **Interface VPC エンドポイント** `com.amazonaws.<region>.logs` |
| ECR | コンテナイメージの pull (タスク起動時) | **Interface VPC エンドポイント** `com.amazonaws.<region>.ecr.api` と `com.amazonaws.<region>.ecr.dkr` (イメージレイヤ実体は S3 Gateway エンドポイント経由) |
| タスクロール資格情報 | boto3 の既定チェーン | リンクローカル `169.254.170.2` (タスク内完結。外部経路不要) |

補足:

- Interface エンドポイントは **private DNS を有効化**する (SDK のエンドポイント解決を変えないため)
- worker は IdP (OIDC) にも外部 API にも到達しない。**JWKS フェッチが必要な api とは要件が
  異なる**ので、api のサブネット/SG 設計を worker に流用しないこと
- `S3_ENDPOINT_URL` は dev (MinIO) 専用。本番では設定しない (docs/environment-variables.md)

この構成により、GDAL の入力ドライバに外部フェッチ (`/vsicurl` 等) やローカル参照を誘発する
細工入力 (VRT 等) が仮にコード側検査を突破しても、**外に出る経路そのものが無い**ため
SSRF・データ持ち出しは成立しない。

## コード側防御の一覧 (issue #19 実装)

| 防御 | 実装 | 内容 |
|---|---|---|
| GDAL 入力ドライバ allowlist | `worker.py` `INPUT_DRIVERS` + ogr2ogr `-if` | 受付形式と 1:1 の `GeoJSON` / `ESRI Shapefile` のみ。VRT / CSV 等の自動ドライバ選択を封じる。allowlist 外の形式のジョブは取込前に failed (`-if` は GDAL 3.2+、worker イメージは 3.9.2) |
| zip 展開前検査 | `worker.py` `inspect_zip_archive` | `/vsizip` に渡す前に、エントリ数上限 (`IMPORT_ZIP_MAX_ENTRIES` 既定 100)・合計展開サイズ上限 (`IMPORT_ZIP_MAX_TOTAL_BYTES` 既定 2GiB、セントラルディレクトリの宣言値で判定)・ネスト zip 拒否・パストラバーサル (絶対パス・ドライブレター・`..`) 拒否。違反は failed + 理由記録 |
| 実体 (マジックバイト) 検査 | api `routes/JobRoutes.kt` `validateUploadMatchesFormat` | 宣言 format と実体の不一致 (geojson 宣言で zip 実体等) を **UploadStorage への保存前に** 400 で拒否 |
| DB 資格情報の秘匿 | `worker.py` `run_ogr2ogr` | PG 接続文字列に password を含めず、サブプロセスの `PGPASSWORD` 環境変数でのみ渡す (プロセス引数は同一ホストの他プロセスから可視のため) |

回帰テスト: `apps/worker-gis/tests/test_pure_functions.py` (zip 検査・ドライバ allowlist・
引数へのパスワード不漏洩) と `apps/worker-gis/tests/integration/test_malicious_inputs.py`
(VRT 入り zip・zip 爆弾・偽装拡張子・パストラバーサル・許可外形式が failed + 理由記録になること)、
api 側は `ImportJobIntegrationTest` (マジックバイト不一致の 400)。

## さらに検討するもの (infra 側)

- **GuardDuty Malware Protection for S3** をアップロードバケットで有効化し、悪性判定
  オブジェクトのタグ付け・隔離を取込前段に挟む
- 将来: `PGPASSWORD` の注入をやめ **RDS IAM 認証** (短命トークン) へ移行する
- アップロードバケットのライフサイクルルールによる失効 (docs/backup-restore.md)
