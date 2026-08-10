# 環境変数一覧とシークレット管理 (AWS 前提)

本リポジトリの全コンポーネントは**環境変数駆動**で設定される。このドキュメントは
ECS タスク定義を作成するときの完全なインプットとして、全設定項目を
「名称 / 必須・任意 / dev 既定 / 本番の供給元」で一覧化する。

## 前提 (実行基盤とシークレットの正本)

- 実行基盤は **ECS Fargate** を想定する (動的 MVT タイルのバースト・長時間取込ジョブ・日中定常負荷というワークロード特性による。詳細は issue #16)
- シークレットの正本は **AWS Secrets Manager** (DB 資格情報は RDS 統合ローテーション対象)。シークレットでない設定値は **SSM Parameter Store**、環境ごとに固定の値は**タスク定義の `environment` 直書き**でよい
- 注入は ECS タスク定義の `secrets` (`valueFrom`) を使う。アプリからは従来どおり環境変数に見えるため、**アプリコードの変更は不要**
- AWS への認証は IAM タスクロール。CI からは GitHub Actions OIDC フェデレーション (長期アクセスキー不使用)
- **`infra/docker-compose.yml` はローカル開発専用**。本番構成には使わない。dev の資格情報は `infra/.env` (gitignore 済み、`infra/.env.example` をコピーして作成) から供給する

供給元の凡例:

| 凡例 | 意味 |
|---|---|
| Secrets Manager | ECS タスク定義 `secrets.valueFrom` で Secrets Manager から注入 (ローテーション対象) |
| SSM | ECS タスク定義 `secrets.valueFrom` で SSM Parameter Store から注入 (シークレットではない設定値) |
| タスク定義 | ECS タスク定義 `environment` に直書き (環境ごとに固定・秘匿不要) |
| ビルド引数 | コンテナイメージのビルド時に確定 (実行時には変更不可) |

## api (apps/api — Ktor)

ソース: `Application.kt` / `Database.kt` / `Auth.kt` の `System.getenv`。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `PORT` | 任意 | `8080` | タスク定義 |
| `DATABASE_URL` | 任意 (本番は明示) | `jdbc:postgresql://localhost:5432/gis` | タスク定義 (RDS エンドポイント) |
| `DATABASE_USER` | 任意 (本番は明示) | `PGUSER` → `gis` | Secrets Manager (RDS シークレットの `username`) |
| `DATABASE_PASSWORD` | **必須** (`PGPASSWORD` でも可。既定へのフォールバックなし — 未設定は起動失敗) | なし (compose が注入) | **Secrets Manager** (RDS シークレットの `password`) |
| `DATABASE_POOL_SIZE` | 任意 | `10` | タスク定義 |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 任意 | `10000` | タスク定義 |
| `DATABASE_MAX_LIFETIME_MS` | 任意 | `1500000` (25 分) | タスク定義 |
| `DATABASE_LEAK_DETECTION_MS` | 任意 | `60000` | タスク定義 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 任意 | `30000` | タスク定義 |
| `HEAVY_STATEMENT_TIMEOUT_MS` | 任意 | `0` (無制限。分析ジョブ等の重い処理で statement_timeout を差し替える) | タスク定義 |
| `UPLOAD_DIR` | 任意 | `/tmp/web-gis-uploads` | タスク定義 (multipart 受信のステージング先。`UPLOAD_STORAGE=s3` ではタスク一時領域でよい。local では保存先そのもの) |
| `UPLOAD_STORAGE` | 任意 (**本番は `s3` 必須** — Fargate のローカル FS は揮発) | `local` | タスク定義。詳細は [backup-restore.md](backup-restore.md) |
| `S3_BUCKET` | `UPLOAD_STORAGE=s3` のとき**必須** (未設定は起動失敗) | なし | タスク定義 / SSM |
| `S3_REGION` | 任意 (未設定時は SDK 既定チェーン: `AWS_REGION` 等) | なし | タスク定義 |
| `S3_ENDPOINT_URL` | 任意 (**dev の MinIO 専用**。指定時は path-style アクセス。本番では設定しない) | なし (compose の s3 プロファイルは `http://minio:9000`) | — |
| `S3_KEY_PREFIX` | 任意 | `uploads/` | タスク定義 |
| `UPLOAD_MAX_BYTES` | 任意 | `209715200` (200MB。web の nginx `client_max_body_size` と揃える) | タスク定義 |
| `REVIEW_EVIDENCE_MAX_BYTES` | 任意 | `10485760` (10MB。1440x900 の証跡 PNG は実測 70KB 前後) | タスク定義 |
| `REVIEW_NOTIFICATION_RUNNER_MODE` | 任意 (`in-process` \| `external`) | `in-process` | タスク定義。本番の水平分割時は `external` + `bin/review-notification-worker`。詳細は [review-notifications.md](review-notifications.md) |
| `REVIEW_NOTIFICATION_POLL_INTERVAL_SECONDS` | 任意 | `2` | タスク定義 |
| `REVIEW_NOTIFICATION_MAX_ATTEMPTS` | 任意 | `5` | タスク定義 |
| `REVIEW_NOTIFICATION_LEASE_SECONDS` | 任意 (配信中ワーカー停止時に再 claim するまでの時間) | `120` | タスク定義 |
| `REVIEW_NOTIFICATION_REQUEST_TIMEOUT_SECONDS` | 任意 (Teams / Issue Webhook の接続・応答期限) | `10` | タスク定義 |
| `REVIEW_APP_URL` | 任意 | `WEB_ORIGIN` → `http://localhost:5173` | SSM (通知内のレビュー画面リンク) |
| `REVIEW_EMAIL_FROM` | 任意 (設定すると Email チャネルが利用可能) | なし | SSM (SES で検証済みの送信元) |
| `REVIEW_SES_REGION` | 任意 (未設定時は AWS SDK 既定チェーン) | なし | タスク定義 |
| `REVIEW_SES_ENDPOINT_URL` | 任意 (**dev の SES 互換モック専用**。本番では設定しない) | なし | — |
| `REVIEW_TEAMS_WEBHOOK_URL` | 任意 (設定すると Teams チャネルが利用可能) | なし | **Secrets Manager** |
| `REVIEW_ISSUE_WEBHOOK_URL` | 任意 (設定すると Issue 生成チャネルが利用可能) | なし | **Secrets Manager** |
| `REVIEW_ISSUE_WEBHOOK_TOKEN` | 任意 (Issue Webhook の Bearer token) | なし | **Secrets Manager** |
| `API_PUBLIC_URL` | 任意 (本番は明示) | API単体は `http://localhost:8080`、composeはCSPと同一オリジンの `http://localhost:5173` | タスク定義 / SSM |
| `WEB_ORIGINS` | 任意 (複数SPAを許可する場合に推奨。カンマ区切りの完全なorigin。指定時は `WEB_ORIGIN` より優先) | なし | タスク定義 / SSM |
| `WEB_ORIGIN` | 任意 (`WEB_ORIGINS` 未設定時の後方互換な単一値。本番はどちらかを明示。未指定時も anyHost には開放しない) | `http://localhost:5173` | タスク定義 / SSM |
| `OIDC_ISSUER` | **必須** (未設定は起動失敗) | なし (compose が注入) | タスク定義 / SSM |
| `OIDC_AUDIENCE` | **必須** (未設定は起動失敗) | なし (compose が注入) | タスク定義 / SSM |
| `OIDC_JWKS_URL` | 任意 | `$OIDC_ISSUER/protocol/openid-connect/certs` | タスク定義 / SSM |
| `AUTH_ADMIN_EMAILS` | 任意 (初期 system admin のブートストラップ用。カンマ区切り) | なし | SSM |
| `API_ROUTE_MODE` | 任意 (`full` \| `review-sidecar`) | `full` | タスク定義。`review-sidecar` はレビュー／フィードバック系ルートと `/api/me` だけを公開し、分析ランナーを起動しない |
| `ANALYSIS_RUNNER_MODE` | 任意 (**本番は `external` 推奨** — 分析ランナーを独立サービスへ分離。`in-process` \| `external` 以外は起動失敗) | `in-process` (API 内デーモンスレッド) | タスク定義。詳細は [jobs-architecture.md](jobs-architecture.md) |
| `JOB_QUEUE_MODE` | 任意 (**本番は `sqs` 推奨**。`polling` \| `sqs` 以外は起動失敗) | `polling` (ワーカーの DB ポーリング) | タスク定義。詳細は [jobs-architecture.md](jobs-architecture.md) |
| `SQS_ANALYSIS_QUEUE_URL` | `JOB_QUEUE_MODE=sqs` のとき**必須** (未設定は起動失敗) | なし (compose の sqs プロファイルは ElasticMQ の URL) | タスク定義 / SSM |
| `SQS_IMPORT_QUEUE_URL` | `JOB_QUEUE_MODE=sqs` のとき**必須** (未設定は起動失敗) | なし (同上) | タスク定義 / SSM |
| `SQS_REGION` | 任意 (未設定時は SDK 既定チェーン: `AWS_REGION` 等) | なし | タスク定義 |
| `SQS_ENDPOINT_URL` | 任意 (**dev の ElasticMQ 専用**。本番では設定しない) | なし (compose の sqs プロファイルは `http://elasticmq:9324`) | — |
| `ANALYSIS_POLL_INTERVAL_SECONDS` | 任意 (polling モードのポーリング間隔) | `2` | タスク定義 |
| `ANALYSIS_JOB_STALE_SECONDS` | 任意 (running 行のハートビート途絶とみなす閾値。実行中は 15 秒ごとに更新されるため長時間ジョブの誤回収はない) | `1800` | タスク定義 |
| `ANALYSIS_JOB_HEARTBEAT_SECONDS` | 任意 (実行中の heartbeat_at 更新間隔) | `15` | タスク定義 |
| `ANALYSIS_JOB_MAX_ATTEMPTS` | 任意 (claim 試行回数の上限。途絶再発時に failed 化して収束させる) | `5` | タスク定義 |
| `ANALYSIS_SWEEP_INTERVAL_SECONDS` | 任意 (stale 回収 + 補完スキャンの間隔) | `60` | タスク定義 |
| `ANALYSIS_JOB_REENQUEUE_SECONDS` | 任意 (pending 滞留を補完スキャンが再 enqueue する閾値。sqs モードのみ) | `300` | タスク定義 |
| `ANALYSIS_RECEIVE_WAIT_SECONDS` | 任意 (SQS long polling の待ち時間) | `10` | タスク定義 |
| `ANALYSIS_VISIBILITY_EXTENSION_SECONDS` | 任意 (ハートビートごとに延長する visibility timeout) | `120` | タスク定義 |
| `ANALYSIS_TEST_CLAIM_HOLD_MILLIS` | **テスト専用** (claim 直後に実行を保留する。kill 回復の統合テスト用 — 本番で設定しない) | `0` | — |

| `LOG_FORMAT` | 任意 (**本番は `json` 必須** — CloudWatch Logs Insights でのフィールド検索の前提。`text` \| `json` 以外は起動失敗) | `text` (人間可読) | タスク定義。詳細は [observability.md](observability.md) |
| `HEALTH_READINESS_TIMEOUT_MS` | 任意 (`/health/ready` の DB 疎通確認の応答期限。ALB ヘルスチェックのタイムアウトより短くする) | `2000` | タスク定義 |

`WEB_ORIGINS` / `WEB_ORIGIN` は `scheme://host[:port]` だけを受け付ける。path、query、userinfo、
`http` / `https` 以外のscheme、不完全なURLは起動時に拒否する。例:

```text
WEB_ORIGINS=https://sales.example.com,https://assets.example.com
```

両方を設定した場合は `WEB_ORIGINS` が許可リストのSSoTとなる。通知リンクは複数候補から
決められないため、複数SPA構成では `REVIEW_APP_URL` も明示する。

`ANALYSIS_*` / `JOB_QUEUE_MODE` / `SQS_*` は分析ワーカー (`bin/analysis-worker` — api と
同イメージの別エントリポイント) にも同じ名前で適用される。API 側は `ANALYSIS_RUNNER_MODE=external`
のとき `ANALYSIS_*` を読まない (ジョブ実行の設計は [jobs-architecture.md](jobs-architecture.md))。

`API_ROUTE_MODE=review-sidecar` は透過プロキシではない。同じAPIイメージを別コンテナとして起動し、
Gatewayのpath routingまたはSDKの `apiBaseUrl` で明示的に送る。JWT検証・DBメンバーシップ認可・
監査・証跡保管は通常APIと同じ実装を使う。通常APIと同時起動する場合、通知outboxを二重にpoll
しないよう通常API側を `REVIEW_NOTIFICATION_RUNNER_MODE=external` にし、sidecar側だけを
`in-process` にするか、両方を `external` にして専用通知workerを1つ起動する。

## feedback-service (apps/feedback-service-go — Go)

Feedback Service は Web GIS API と別プロセス・別 PostgreSQL・別 Flyway history で動作する。
`DATABASE_*` や `OIDC_*` は共有せず、すべて `FEEDBACK_*` の独立設定を使う。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `FEEDBACK_PORT` | 任意 | `8090` | タスク定義 |
| `FEEDBACK_DATABASE_URL` | 任意 (本番は明示) | `jdbc:postgresql://localhost:5432/feedback` | タスク定義 (専用 RDS/PostgreSQL) |
| `FEEDBACK_DATABASE_USER` | 任意 (本番は明示) | `PGUSER` → `feedback` | Secrets Manager |
| `FEEDBACK_DATABASE_PASSWORD` | **必須** (`PGPASSWORD` でも可。既定値なし) | なし (compose が注入) | **Secrets Manager** |
| `FEEDBACK_DATABASE_POOL_SIZE` | 任意 | `10` | タスク定義 |
| `FEEDBACK_DATABASE_CONNECTION_TIMEOUT_MS` | 任意 | `10000` | タスク定義 |
| `FEEDBACK_DATABASE_STATEMENT_TIMEOUT_MS` | 任意 | `30000` | タスク定義 |
| `FEEDBACK_OIDC_ISSUER` | **API では必須** | なし (compose が注入) | タスク定義 / SSM |
| `FEEDBACK_OIDC_AUDIENCE` | **API では必須** | なし (compose は `feedback-service`) | タスク定義 / SSM |
| `FEEDBACK_OIDC_JWKS_URL` | 任意 | `$issuer/.well-known/jwks.json` | タスク定義 / SSM |
| `FEEDBACK_OIDC_SUBJECT_CLAIM` | 任意 | `sub` | タスク定義 |
| `FEEDBACK_OIDC_DISPLAY_NAME_CLAIM` | 任意 | `name` | タスク定義 |
| `FEEDBACK_OIDC_EMAIL_CLAIM` | 任意 | `email` | タスク定義 |
| `FEEDBACK_ALLOW_INSECURE_HTTP` | 任意 (**dev 専用**) | 未設定 (`https` 必須、`localhost` だけ例外) | —。本番で `1` にしない |
| `FEEDBACK_TOKEN_EXCHANGE_ISSUER` | broker token 検証を有効にするとき必須 | なし (未設定なら直接 OIDC のみ) | タスク定義 / SSM |
| `FEEDBACK_TOKEN_EXCHANGE_AUDIENCE` | exchange issuer 設定時**必須** | なし | タスク定義 / SSM |
| `FEEDBACK_TOKEN_EXCHANGE_JWKS_URL` | 任意 | `$exchangeIssuer/.well-known/jwks.json` | タスク定義 / SSM |
| `FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS` | exchange issuer 設定時**必須** | なし | 許可する元 IdP issuer のカンマ区切り |
| `FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS` | 任意 | `300` (許容範囲 30..900) | タスク定義 |
| `FEEDBACK_EVIDENCE_MAX_BYTES` | 任意 | `10485760` (10MiB) | タスク定義 |
| `FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE` | 任意 | `1000` (workspace単位、1..1000000) | タスク定義 |
| `FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE` | 任意 | `120` (principal単位、1..10000) | タスク定義 |
| `FEEDBACK_WRITE_RATE_LIMIT_PER_TENANT_PER_MINUTE` | 任意 | `1200` (tenant単位、1..100000) | タスク定義 |
| `FEEDBACK_WRITE_RATE_LIMIT_PER_IP_PER_MINUTE` | 任意 | `240` (IPはSHA-256のみ保存、1..100000) | タスク定義 |
| `FEEDBACK_EVIDENCE_STORAGE` | 任意 (**本番は `s3`**) | `local` | タスク定義 |
| `FEEDBACK_EVIDENCE_DIR` | `local` のとき任意 | `/data/evidence` | タスク定義 / volume |
| `FEEDBACK_S3_BUCKET` | `s3` のとき**必須** | なし | タスク定義 / SSM |
| `FEEDBACK_S3_REGION` | 任意 | AWS SDK 既定チェーン | タスク定義 |
| `FEEDBACK_S3_ENDPOINT_URL` | 任意 (**dev の S3 互換 storage 専用**) | なし | — |
| `FEEDBACK_S3_KEY_PREFIX` | 任意 | `evidence/` | タスク定義 |
| `FEEDBACK_EXPORT_STORAGE` | 任意 (**本番は `s3`**) | `local` | タスク定義 |
| `FEEDBACK_EXPORT_DIR` | `local` のとき任意 | `/data/exports` | タスク定義 / private volume |
| `FEEDBACK_EXPORT_S3_BUCKET` | `s3` のとき**必須** | なし | タスク定義 / SSM |
| `FEEDBACK_EXPORT_S3_REGION` | 任意 | AWS SDK 既定チェーン | タスク定義 |
| `FEEDBACK_EXPORT_S3_ENDPOINT_URL` | 任意 (**dev の S3 互換 storage 専用**) | なし | — |
| `FEEDBACK_EXPORT_KEY_PREFIX` | 任意 | `exports/` | タスク定義 |
| `FEEDBACK_EXPORT_POLL_MS` | export worker で任意 | `2000` | タスク定義 |
| `FEEDBACK_BACKUP_KEY_PREFIX` | export/retention worker で任意 | `backups/` | タスク定義 |
| `FEEDBACK_BACKUP_MAX_ATTEMPTS` | export worker で任意 | `5` | タスク定義 |
| `FEEDBACK_NOTIFICATION_POLL_MS` | notification worker で任意 | `2000` | タスク定義 |
| `FEEDBACK_NOTIFICATION_MAX_ATTEMPTS` | notification worker で任意 | `5` | タスク定義 |
| `FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP` | 任意 (**ローカル fixture 専用**) | 未設定 (`https` と public address のみ) | —。API、notification worker、connector register/runtimeへ設定し、本番で `1` にしない |
| `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY` | API/notification worker で**必須** | なし (base64 で 32 byte) | **Secrets Manager** |
| `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS` | key rotation 中だけ任意 | なし (base64 で 32 byte) | **Secrets Manager** |
| `FEEDBACK_RETENTION_POLL_MS` | retention worker で任意 | `3600000` | タスク定義 |
| `FEEDBACK_ORPHAN_GRACE_SECONDS` | retention worker で任意 | `3600` (最小 300) | タスク定義 |

### 自動バックアップ搬送CLI

| 変数 | 必須 | 説明 |
|---|---:|---|
| `FEEDBACK_PULL_API_BASE_URL` | 必須 | `/feedback/v1`までを含むFeedback Service URL |
| `FEEDBACK_PULL_TOKEN_URL` | 必須 | OAuth 2.0 client credentialsのtoken endpoint |
| `FEEDBACK_PULL_CLIENT_ID` | 必須 | `feedback.manage` membershipを付与したservice principalのclient ID |
| `FEEDBACK_PULL_CLIENT_SECRET` | 必須 | **Secrets Manager**から注入するclient secret |
| `FEEDBACK_PULL_SCOPE` | 任意 | `feedback.manage`。追加scopeが必要なIdPでは空白区切りで加える (`feedback.manage`は必須) |
| `FEEDBACK_PULL_APPLICATION_KEY` | 必須 | 搬送対象application |
| `FEEDBACK_PULL_EXTERNAL_WORKSPACE_KEY` | 必須 | 搬送対象workspace |
| `FEEDBACK_PULL_DESTINATION_DIR` | 必須 | OS側でマウント済みの共有フォルダ。filesystem rootは拒否する |

### 別プロセス通知コネクタ

登録CLI (`bin/feedback-connector-register`) と参照runtime
(`bin/feedback-connector-runtime`) は次を使う。接続先URL、SMTP資格情報、宛先はFeedback Serviceへ渡さず、
各connector processのsecretとして管理する。

| 変数 | 対象 | 必須・既定 |
|---|---|---|
| `FEEDBACK_CONNECTOR_KEY` | register | 必須。installationの安定key |
| `FEEDBACK_CONNECTOR_DISPLAY_NAME` | register/runtime | registerで必須、runtimeはprovider名 |
| `FEEDBACK_CONNECTOR_DESCRIPTOR_URL` | register | 必須。内部HTTPSの`/connector/v1/manifest` |
| `FEEDBACK_CONNECTOR_DELIVERY_URL` | register | 必須。内部HTTPSの`/connector/v1/deliveries` |
| `FEEDBACK_CONNECTOR_ALLOWED_HOSTS` | register | 任意。追加で許可する内部hostのカンマ区切り。descriptor/delivery/healthのhostは自動追加 |
| `FEEDBACK_CONNECTOR_SUPPORTED_EVENTS` | register | 任意。既定は4種類すべて |
| `FEEDBACK_CONNECTOR_ENABLED` | register | 任意。`0`で無効 |
| `FEEDBACK_CONNECTOR_LEGACY_REF_MAP` | register (`webhook`) | 任意。旧Webhook endpointのSHA-256から`destinationRef`へのJSON object。旧設定を有効なままbackfillするとき必須 |
| `FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK` | notification worker | 内部HTTPS connectorをprivate networkで動かす場合のみ`1`。HTTPは許可しない |
| `FEEDBACK_CONNECTOR_PROVIDER` | runtime | 必須。`webhook` / `teams` / `slack` / `smtp-mail` |
| `FEEDBACK_CONNECTOR_PORT` | runtime | `8091` |
| `FEEDBACK_CONNECTOR_SHARED_SECRET` | 両方 | 必須、32文字以上。**Secrets Manager** |
| `FEEDBACK_CONNECTOR_DESTINATIONS` | runtime | 必須。`destinationRef`から送信先へのJSON object。secret扱い |
| `FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE` | runtime | 必須。delivery IDを永続化する専用volume上のファイル。複数runtimeで共有しない |
| `FEEDBACK_WEBHOOK_SIGNING_SECRET` | webhook runtime | 必須、32文字以上。外部Webhookへのtimestamp付きHMAC鍵。**Secrets Manager** |
| `FEEDBACK_SMTP_HOST` / `FEEDBACK_SMTP_FROM` | smtp-mail | 必須 |
| `FEEDBACK_SMTP_PORT` | smtp-mail | `587` |
| `FEEDBACK_SMTP_USERNAME` / `FEEDBACK_SMTP_PASSWORD` | smtp-mail | SMTP AUTH利用時に注入。passwordはsecret |

`application_environments.allowed_origins` が CORS allowlist の正本であり、API 起動環境変数で
origin を上書きしない。S3 認証は AWS SDK の既定チェーン (本番は ECS タスクロール) を使う。
API、notification worker、export worker、retention worker は同じ image から、それぞれ
`bin/feedback-service`、`bin/feedback-notification-worker`、`bin/feedback-export-worker`、
`bin/feedback-retention-worker` を command で選ぶ。export file は認可付き download API だけで配信する。
同じ配布物に`bin/feedback-backup-pull`、`bin/feedback-connector-register`、
`bin/feedback-connector-runtime`、`bin/feedback-bootstrap`、`bin/feedback-legacy-migration`、
`bin/feedback-migrate`も含む。自動backup ZIPも認可付きdownload APIだけで配信する。
local modeはAPI、export worker、retention workerでprivate volumeを共有し、分散配備は専用S3 bucketを共有する。

standalone Composeは`apps/feedback-service-go/Dockerfile`を既定runtime imageとする。
`FEEDBACK_SERVICE_DOCKERFILE`は過去のrollback artifactを明示検証するときだけ使うCompose build選択変数で、
本番runtimeへ注入しない。空DBは`feedback-migrate`が埋め込みclean V1とV6 handoff markerをtransaction適用してから
Go API/workerを起動する。

`assemble-feedback-repository --go-only`で作る最終候補はKotlin/JDK/Gradleを含まず、Compose既定をGoへ固定する。
この形状の空DBだけは`feedback-migrate`が埋め込みclean V1をtransaction適用し、Flyway互換V1履歴とV6 markerを作る。
既存V1〜V6 DBへbaselineを再適用せず、従来のhandoff/fingerprint検証だけを行う。

### Feedback build・release・smoke制御

次はbuild/品質ゲート専用で、本番runtimeへ注入しない。`SKIP`変数は局所切り分け用であり、release/CIの合格証跡では
未設定のまま全gateを実行する。

| 名称 | 既定 | 説明 |
|---|---:|---|
| `FEEDBACK_VERIFY_SKIP_NPM_CI` | `0` | `1`で親が実行済みの`npm ci`を再利用する。clean verifyでは使わない |
| `FEEDBACK_VERIFY_SKIP_PACKAGE_CONSUMERS` | `0` | `1`でpackage consumer testを省略する。合格証跡では使わない |
| `FEEDBACK_EXTRACTION_SKIP_DOCKER_BUILD` | `0` | extractionの局所切り分けでimage buildだけを省略する |
| `FEEDBACK_EXTRACTION_SKIP_STANDALONE_SMOKE` | `0` | extractionの局所切り分けでstandalone smokeだけを省略する |
| `FEEDBACK_SMOKE_MANAGE_COMPOSE` | `1` | `1`でsmoke自身がComposeを起動・破棄する。`0`は起動済み専用stackの診断用 |
| `FEEDBACK_SMOKE_PROJECT` | `feedback-system-smoke` | 衝突を避ける専用Compose project名 |
| `FEEDBACK_SMOKE_RUNTIME` | 抽出形状により`kotlin`または`go` | smoke対象runtime。Go-only抽出物では`go`だけを許可する |
| `FEEDBACK_SMOKE_ROLLBACK` | Go/Kotlin併存・Compose管理時は`1` | GoからKotlinへのrole別rollback/restore演習を明示制御する |
| `FEEDBACK_RELEASE_VERSION` | なし | release scriptの`--version`未指定時に使うversion。secretではない |
| `FEEDBACK_RELEASE_BUILDER` | scriptが一時builderを作成 | CIが作成済みBuildx builder名を渡す。指定時はscriptが削除しない |

### Feedback移行テスト専用

次は本番runtimeへ設定しない。integration/differential testだけが使用する。

| 名称 | 必須 | 説明 |
|---|---:|---|
| `FEEDBACK_TEST_RUN_ID` | migration integrationで必須 | 小文字英数字始まり、最大32文字の小文字英数字・hyphen。並行test用の一時DB名を分離する |
| `FEEDBACK_DIFFERENTIAL_KOTLIN_URL` | live differentialで必須 | Kotlin版の分離DB/Object Storageへ接続したHTTP origin |
| `FEEDBACK_DIFFERENTIAL_GO_URL` | live differentialで必須 | Go版の別DB/Object Storageへ接続したHTTP origin。同じwriteをKotlin版と共有DBへ二重実行しない |
| `FEEDBACK_GO_INTEGRATION_DATABASE_URL` | Go integrationで必須 | Kotlin/Flyway V6適用済みの専用PostgreSQL URL。通常unit/raceからは明示的に隔離する |
| `FEEDBACK_GO_INTEGRATION_DATABASE_USER` | Go integrationで必須 | 上記専用PostgreSQLのuser |
| `FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD` | Go integrationで必須 | 上記専用PostgreSQLのpassword。secretとして扱う |
| `FEEDBACK_GO_INTEGRATION_LEGACY_DATABASE_URL` | Go legacy migration integrationで必須 | 通常DBから複製した専用PostgreSQL。testが`feedback_migration`をDROPして初回作成・冪等性を検証するため、他用途と共有しない |
| `FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL` | Go MinIO integrationで必須 | 専用S3互換endpoint |
| `FEEDBACK_GO_INTEGRATION_S3_BUCKET` | Go MinIO integrationで必須 | 専用bucket。bucket名とobject prefixはtest側のrun ID guardで制限する |
| `FEEDBACK_GO_INTEGRATION_S3_CREATE_BUCKET` | CI setupだけ任意 | `1`で専用bucket `feedback-go-w2-evidence` を作成する。他bucketの自動作成は拒否する |
| `FEEDBACK_GO_INTEGRATION_S3_INTEROP_PHASE` | Kotlin/Go object相互運用で必須 | `write` / `read-cleanup`。`w2-interop` run IDと専用固定key以外では起動を拒否する |
| `FEEDBACK_S3_INTEROP` | Kotlin/Go object相互運用で必須 | `1`のときだけKotlin側のMinIO相互運用testを実行する |
| `FEEDBACK_TEST_S3_ENDPOINT` | Kotlin integrationで必須 | 専用MinIO endpoint |
| `FEEDBACK_TEST_S3_REGION` | Kotlin integrationで必須 | 専用MinIO region |
| `FEEDBACK_TEST_S3_BUCKET` | Kotlin integrationで必須 | 専用bucket |
| `FEEDBACK_TEST_S3_ACCESS_KEY` | Kotlin integrationで必須 | 専用MinIO access key |
| `FEEDBACK_TEST_S3_SECRET_KEY` | Kotlin integrationで必須 | 専用MinIO secret key |

`FEEDBACK_CONNECTOR_CHILD`、`FEEDBACK_CONNECTOR_ADDRESS_FILE`、`FEEDBACK_CONNECTOR_ID_FILE`、
`FEEDBACK_CONNECTOR_MARKER`はconnectorの別process unit testが子processと一時fileを受け渡す内部protocolである。
CI/運用者が設定せず、test自身が専用一時directoryだけへ設定する。

exchange token は別 issuer/audience の署名・`iat`/`exp` と最大 lifetime を検証し、
`actor_issuer` / `actor_sub`、`feedback_tenant/application/environment/workspace`、
`feedback_permissions` claim を必須とする。実効権限は DB membership と token permission の積集合であり、
token scope 外の resource は許可しない。broker でのホスト session 検証・mTLS・token 発行鍵の保護は
broker 側の責務であり、業務 API token を Feedback Service へ転送しない。

## token broker reference

`POST /v1/exchanges` はmTLS必須。次のファイル設定にsecretや秘密鍵の内容を直接埋め込まず、
orchestratorのsecret mountを使用する。

| 名称 | 必須 | 説明 |
|---|---|---|
| `FEEDBACK_BROKER_ISSUER` / `FEEDBACK_BROKER_AUDIENCE` | 必須 | 発行JWTのissuer/audience |
| `FEEDBACK_BROKER_TLS_CERT_FILE` / `FEEDBACK_BROKER_TLS_KEY_FILE` | 必須 | broker server証明書と秘密鍵 |
| `FEEDBACK_BROKER_CLIENT_CA_FILE` | 必須 | mTLS clientを検証するCA |
| `FEEDBACK_BROKER_SIGNING_PRIVATE_KEY_FILE` | 必須 | JWT署名秘密鍵 |
| `FEEDBACK_BROKER_SIGNING_PUBLIC_KEY_FILE` | 任意 | JWKS公開鍵。未指定時は秘密鍵から導出 |
| `FEEDBACK_BROKER_CLIENT_POLICIES_FILE` | 必須 | mTLS identity別scope上限allowlist |
| `FEEDBACK_BROKER_MAX_LIFETIME_SECONDS` | 任意 | `300`、最大300秒 |
| `FEEDBACK_BROKER_PORT` | 任意 | `8443`。mTLS exchange server port |
| `FEEDBACK_BROKER_JWKS_PORT` | 任意 | `8081`。service network内JWKS HTTP port |

conformance consumerは次の4変数だけを使う。client keyはsecret mountで供給し、Feedback Serviceへ転送しない。

| 名称 | 必須 | 説明 |
|---|---:|---|
| `FEEDBACK_BROKER_URL` | 必須 | brokerのmTLS `/v1/exchanges` URL |
| `FEEDBACK_BROKER_CA_FILE` | 必須 | broker CA certificate path |
| `FEEDBACK_BROKER_CLIENT_CERT_FILE` | 必須 | conformance consumer client certificate path |
| `FEEDBACK_BROKER_CLIENT_KEY_FILE` | 必須 | conformance consumer client private key path。secret mount |

Phase 3 の管理 UI/API が完成するまで、初期 tenant/application/environment/workspace/membership は
one-shot の `bin/feedback-bootstrap` で登録する。次の変数は bootstrap command だけが読む。

| 名称 | 必須 | 説明 |
|---|---|---|
| `FEEDBACK_BOOTSTRAP_TENANT_KEY` / `FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME` | 必須 | tenant の安定 key と表示名 |
| `FEEDBACK_BOOTSTRAP_APPLICATION_KEY` / `FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME` | 必須 | application の安定 key と表示名 |
| `FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY` / `FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL` | 必須 | environment key と deep link の基底 URL |
| `FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS` | 必須 | CORS 許可 origin (カンマ区切り) |
| `FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY` / `FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME` | 必須 | ホスト側 workspace key と表示名 |
| `FEEDBACK_BOOTSTRAP_ISSUER` / `FEEDBACK_BOOTSTRAP_SUBJECT` | 必須 | 最初の管理主体を特定する OIDC issuer/subject |
| `FEEDBACK_BOOTSTRAP_EMAIL` / `FEEDBACK_BOOTSTRAP_DISPLAY_NAME` | 任意 | 管理主体の表示属性 |
| `FEEDBACK_BOOTSTRAP_PERMISSIONS` | 必須 | `feedback.read/comment/manage/admin` のカンマ区切り |

bootstrap は冪等だが、同じ `applicationKey` を別 tenant に割り当てる操作は拒否する。production では
one-shot task の環境変数として渡し、常駐 API タスクへ `FEEDBACK_BOOTSTRAP_*` を設定しない。

## worker-gis (apps/worker-gis — Python)

ソース: `src/worker.py` の `os.getenv`。DB 接続は libpq 標準の `PG*` 変数。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `PGHOST` | 任意 (本番は明示) | `localhost` | タスク定義 (RDS エンドポイント) |
| `PGPORT` | 任意 | `5432` | タスク定義 |
| `PGDATABASE` | 任意 (本番は明示) | `gis` | タスク定義 |
| `PGUSER` | 任意 (本番は明示) | `gis` | Secrets Manager (RDS シークレットの `username`) |
| `PGPASSWORD` | **必須** (既定へのフォールバックなし — 未設定は起動失敗) | なし (compose が注入) | **Secrets Manager** (RDS シークレットの `password`) |
| `JOB_QUEUE_MODE` | 任意 (**本番は `sqs` 推奨**。`polling` \| `sqs` 以外は起動失敗) | `polling` (DB ポーリング) | タスク定義。詳細は [jobs-architecture.md](jobs-architecture.md) |
| `SQS_IMPORT_QUEUE_URL` | `JOB_QUEUE_MODE=sqs` のとき**必須** (未設定は起動失敗) | なし (compose の sqs プロファイルは ElasticMQ の URL) | タスク定義 / SSM |
| `SQS_ENDPOINT_URL` | 任意 (**dev の ElasticMQ 専用**。本番では設定しない) | なし (compose の sqs プロファイルは `http://elasticmq:9324`) | — |
| `SQS_REGION` | 任意 (未設定時は `AWS_REGION` → boto3 既定チェーンの順で解決) | なし | タスク定義 |
| `SQS_RECEIVE_WAIT_SECONDS` | 任意 (SQS long polling の待ち時間) | `10` | タスク定義 |
| `POLL_INTERVAL_SECONDS` | 任意 (polling モードのポーリング間隔 / sqs モードの障害時バックオフ) | `2` | タスク定義 |
| `IMPORT_JOB_STALE_SECONDS` | 任意 (running 行のハートビート途絶とみなす閾値。実行中は 15 秒ごとに更新されるため長時間取込の誤回収はない) | `1800` | タスク定義 |
| `IMPORT_JOB_HEARTBEAT_SECONDS` | 任意 (実行中の heartbeat_at 更新間隔) | `15` | タスク定義 |
| `IMPORT_JOB_MAX_ATTEMPTS` | 任意 (claim 試行回数の上限。途絶再発時に failed 化して収束させる) | `5` | タスク定義 |
| `SWEEP_INTERVAL_SECONDS` | 任意 (stale 回収 + 補完スキャンの間隔) | `60` | タスク定義 |
| `IMPORT_JOB_REENQUEUE_SECONDS` | 任意 (pending 滞留を補完スキャンが再 enqueue する閾値。sqs モードのみ) | `300` | タスク定義 |
| `IMPORT_VISIBILITY_EXTENSION_SECONDS` | 任意 (ハートビートごとに延長する visibility timeout) | `120` | タスク定義 |
| `IMPORT_TEST_CLAIM_HOLD_SECONDS` | **テスト専用** (claim 直後に実行を保留する。kill 回復の統合テスト用 — 本番で設定しない) | `0` | — |
| `IMPORT_ZIP_MAX_ENTRIES` | 任意 (shapefile zip の展開前検査: エントリ数上限) | `100` | タスク定義。詳細は [worker-isolation.md](worker-isolation.md) |
| `IMPORT_ZIP_MAX_TOTAL_BYTES` | 任意 (同: 合計展開サイズ上限。宣言展開サイズで判定 — zip 爆弾対策) | `2147483648` (2GiB) | タスク定義。詳細は [worker-isolation.md](worker-isolation.md) |
| `S3_ENDPOINT_URL` | 任意 (**dev の MinIO 専用**。`upload_path` が `s3://` のジョブの取得先を上書き。本番では設定しない) | なし (compose の s3 プロファイルは `http://minio:9000`) | — |
| `AWS_REGION` | 任意 (`s3://` 参照の取得に使用。ECS では自動注入される) | なし | タスク定義 (自動) |
| `LOG_FORMAT` | 任意 (**本番は `json` 必須**。`text` \| `json` 以外は起動失敗。api と同じ規約) | `text` (人間可読) | タスク定義。詳細は [observability.md](observability.md) |

S3 への認証は api / worker とも AWS SDK / boto3 の**既定チェーン** (本番: ECS タスクロール、
dev: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — compose では MinIO のルート資格情報を配線)。
アクセスキーを Secrets Manager に置く必要はない (タスクロールを使う)。

## web (apps/web — ビルド時のみ)

ソース: `src/api.ts` / `src/auth.ts` / `src/App.tsx` の `import.meta.env`。Vite の `VITE_*` は
**ビルド時に JS へ埋め込まれる**ため、実行時の環境変数では変更できない。
環境ごとにイメージを分けるか、ビルドパイプラインで環境別に `--build-arg` /
`.env.production` を与える。**シークレットを `VITE_*` に入れないこと** (配布物に平文で残る)。

| 名称 | 必須 | dev 既定 (未設定時) | 本番の供給元 |
|---|---|---|---|
| `VITE_API_BASE` | 任意 | `""` (同一オリジン相対パス) | ビルド引数 |
| `VITE_OIDC_AUTHORITY` | 任意 (本番は明示) | `http://localhost:8081/realms/gis` | ビルド引数 |
| `VITE_OIDC_CLIENT_ID` | 任意 | `gis-web` | ビルド引数 |
| `VITE_APP_VERSION` | 任意 (レビュー基盤を使うなら必須) | `"dev"` | ビルド引数 (git SHA / ビルド番号) |
| `VITE_FEEDBACK_API_MODE` | 任意 | `legacy` (`feedback-v1`、互換期間は `feedback-v1-dual-read`) | ビルド引数 |
| `VITE_FEEDBACK_API_BASE` | `feedback-v1` のとき必須 | `/feedback/v1` (同一 origin proxy) | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_URL` | `feedback-v1` のとき必須 | `http://localhost:5174/` | ビルド引数 |
| `VITE_FEEDBACK_APPLICATION_KEY` | `feedback-v1` のとき必須 | `web-gis` | ビルド引数 |
| `VITE_FEEDBACK_ENVIRONMENT_KEY` | `feedback-v1` のとき必須 | `local` | ビルド引数 |

`VITE_APP_VERSION` はレビュー証跡 (`docs/prototype-review.md`) に「どのプロトタイプへの
指摘か」を残すための識別子。未設定でも動くが `dev` 固定になり、後から対象ビルドを
追跡できなくなる。

`feedback-v1` は SDK overlay と管理画面の通信先を切り替える Phase 4 の rollback 可能な flag である。
切替前に対象 application manifest、workspace membership、open session を Feedback DB へ provisioning する。
問題時は同じ build pipeline で `legacy` に戻し、旧 API/DB を再選択する。
`feedback-v1-dual-read` は新 API へだけ書き込み、一覧・詳細・履歴の読み取りだけ旧 API と統合する。
新 API の 401/403/429 は旧 API へ fallback しない。

## feedback-admin (apps/feedback-admin — ビルド時のみ)

独立 Feedback Admin Console の `VITE_*` もビルド時に公開 bundle へ埋め込まれる。secret は設定しない。
Web GIS と異なる OIDC client を使い、Feedback Service audience だけを取得する。

| 名称 | 必須 | dev 既定 (compose) | 本番の供給元 |
|---|---|---|---|
| `VITE_FEEDBACK_API_BASE` | **必須** | `http://localhost:8090/feedback/v1` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY` | **必須** | `http://localhost:8081/realms/gis` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID` | **必須** | `feedback-admin` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_OIDC_REDIRECT_URI` | 任意 | `window.location.origin + /` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_OIDC_SCOPE` | 任意 | `openid profile email` | ビルド引数。Keycloakに追加scopeを定義した場合だけ拡張する |
| `VITE_FEEDBACK_ADMIN_APPLICATION_KEY` | **必須** | `web-gis` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY` | **必須** | `local` | ビルド引数 |
| `VITE_FEEDBACK_ADMIN_WORKSPACE_KEY` | **必須** | ローカル fixture UUID | ビルド引数 |

Docker build内部では公開bundle用の上記3値を、それぞれ`FEEDBACK_ADMIN_APPLICATION`、
`FEEDBACK_ADMIN_ENVIRONMENT`、`FEEDBACK_ADMIN_WORKSPACE` build argumentから受け取る。これらはsecretではなく、
container runtimeへ注入しない。

## martin (タイルサーバー)

| 名称 | 必須 | dev 既定 | 本番の供給元 |
|---|---|---|---|
| `DATABASE_URL` | **必須** (`postgres://user:pass@host:5432/db` 形式。資格情報を含む) | compose が `POSTGRES_*` から組み立て | **Secrets Manager** (接続文字列全体を 1 シークレットとして注入。パスワード単体のローテーションと整合させるため、RDS シークレットから接続文字列を生成するローテーション Lambda / デプロイ手順に含める) |

## keycloak (dev 専用の IdP コンテナ)

compose 内の Keycloak はローカル開発専用 (`start-dev` + realm import)。本番は
Keycloak の本番モード運用 (ECS) か Cognito への移行を別途判断する (issue #16)。

| 名称 | 必須 | dev 既定 | 本番の供給元 |
|---|---|---|---|
| `KC_BOOTSTRAP_ADMIN_USERNAME` | 任意 | `admin` (`infra/.env`) | (本番で Keycloak を使う場合) Secrets Manager |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | **必須** (compose では `infra/.env` から) | `admin` (`infra/.env`) | (同上) **Secrets Manager** |
| `KC_HTTP_PORT` | 任意 | `8080` | タスク定義 |

## compose 専用 (infra/.env — ローカル開発のみ)

| 名称 | 説明 | dev 既定 |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | 開発 PostgreSQL の資格情報。api / worker / martin / seed にも同じ値が配線される | `gis` / `gis` / `gis` |
| `FEEDBACK_POSTGRES_DB` / `FEEDBACK_POSTGRES_USER` / `FEEDBACK_POSTGRES_PASSWORD` | `--profile feedback` の専用通常 PostgreSQL。Web GIS DB と共有しない | `feedback` / `feedback` / `feedback` |
| `FEEDBACK_WEBHOOK_SIGNING_SECRET` | standalone Webhook connectorと受信fixtureが共有する外向きHMAC鍵 (Feedback Service workerは使用しない) | `feedback-local-webhook-secret-0000` |
| `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY` | dev notification endpoint の暗号鍵 (base64) | `infra/.env.example` の開発専用値 |
| `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` | 開発 Keycloak の管理者 | `admin` / `admin` |
| `UPLOAD_STORAGE` / `S3_BUCKET` / `S3_REGION` | アップロード保存先の切替。`s3` にする場合は `--profile s3` で MinIO を同時起動する | `local` / `gis-uploads` / `us-east-1` |
| `JOB_QUEUE_MODE` / `ANALYSIS_RUNNER_MODE` | ジョブ実行基盤の切替 ([jobs-architecture.md](jobs-architecture.md))。`sqs` / `external` にする場合は `--profile sqs` で ElasticMQ と analysis-worker を同時起動する | `polling` / `in-process` |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | 開発 MinIO のルート資格情報 (`--profile s3` のときのみ使用。api / worker の `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` としても配線) | `minio` / `minio-secret` |
| `POSTGRES_HOST_PORT` / `MARTIN_HOST_PORT` / `WEB_HOST_PORT` / `FEEDBACK_ADMIN_HOST_PORT` | ホスト側ポートの競合回避。`MARTIN_HOST_PORT` を変えてもコンテナ間の `martin:3000` は変わらない | `5432` / `3000` / `5173` / `5174` |

CI / verify 用の変数 (`VERIFY_*`, `SMOKE_*`, `FUZZ_*`) は各スクリプトのヘッダコメントを参照。
`FEEDBACK_CANARY_BEARER_TOKEN`は`measure-feedback-canary.sh`だけが読む短時間の検証tokenであり、canary実行時に
承認済みIdPから環境変数へ注入する。本番task定義、shell引数、証跡JSON、repositoryへ保存しない。

## シークレットローテーションの運用

DB 資格情報は Secrets Manager の RDS 統合ローテーションを使う。ただし
**api の HikariCP・worker の psycopg・martin はいずれも起動時に資格情報を読み込む**
ため、ローテーションは次の手順で反映する:

1. Secrets Manager がシークレットをローテーション (RDS 統合)。**alternating users 戦略**
   (2 ユーザーを交互に切替) を使い、旧資格情報がローテーション直後も有効な期間を確保する
2. ローテーション完了イベント (EventBridge) またはローテーション後の運用手順として、
   対象 ECS サービスに **`aws ecs update-service --force-new-deployment`** で
   ローリング再起動をかける。新タスクは起動時に新しいシークレットを注入されて立ち上がり、
   旧タスクはドレイン後に停止する
3. single user 戦略を使う場合、ローテーション瞬間から旧パスワードが無効になるため、
   既存プールの**確立済み接続は生き続ける** (PostgreSQL は接続時のみ認証) が、
   再接続 (`DATABASE_MAX_LIFETIME_MS` 既定 25 分での入替や障害時) に失敗し始める。
   この場合はローテーション → 再デプロイを 1 つの自動化された手順にすること

補足:

- ECS の `secrets` 注入は**タスク起動時**に解決される。シークレット変更は自動では
  反映されず、必ず新タスクの起動 (= ローリング再起動) が必要
- アプリ側にシークレット再読込の仕組みを追加する必要はない (起動時読込 + 再起動反映を正とする)
- OIDC まわり (`OIDC_*`) はシークレットではなく、鍵は JWKS (`OIDC_JWKS_URL`) から
  動的に取得されるため、IdP 側の署名鍵ローテーションに API の再起動は不要

## dev シードの本番混入ガード

開発専用の弱い資格情報・固定ユーザーは以下の 2 か所にのみ存在する:

- `infra/keycloak/realm-gis.json` — 開発 realm (ユーザー `gis-admin` / `gis-editor` / `gis-viewer`、パスワードはユーザー名と同じ)
- `infra/postgres/070-seed-dev-users.sql` — 上記ユーザーの DB 側メンバーシップ (compose の `seed` サービスが投入)

構造上のガード:

- 本番用イメージ (apps/api / apps/worker-gis / apps/web の Dockerfile) は `infra/` を
  一切 COPY しない。realm import・seed サービスは compose のボリュームマウント /
  one-shot サービスであり、イメージには焼き込まれない
- `scripts/check-dev-seed-isolation.sh` が「本番 Dockerfile が infra/ の
  シード・realm を参照しないこと」「開発ユーザーの識別子がアプリ本体コード
  (Flyway マイグレーション含む) に現れないこと」「`infra/.env` がコミットされないこと」を
  検査する。`scripts/verify.sh` に組み込まれており、CI でも毎回実行される
- 本番の初期管理者は seed ではなく `AUTH_ADMIN_EMAILS` による JIT ブートストラップで
  作成し、メンバーシップは管理 API で付与する

## ROPC (Resource Owner Password Credentials) の扱い

開発 realm (`infra/keycloak/realm-gis.json`) の `gis-web` クライアントは
`directAccessGrantsEnabled: true` (ROPC 有効) になっている。これは
`scripts/smoke-e2e.sh` (nightly のスモーク E2E) がヘッドレスで
`grant_type=password` によりアクセストークンを取得するための **dev 専用の妥協**であり、
ブラウザの web アプリ自体は Authorization Code + PKCE のみを使う。

- **本番 realm では `directAccessGrantsEnabled: false` を必須とする** (パスワードが
  クライアント経由で IdP に渡る経路を残さない。フィッシング耐性・MFA 適用の観点でも不可)
- 開発 realm で無効化しない理由: スモーク E2E のトークン取得が ROPC に依存しており、
  代替 (Authorization Code のヘッドレス自動化、またはテスト専用 confidential client +
  client_credentials + ユーザー偽装) は smoke の複雑化に見合わない。dev realm は
  ループバックのみで到達可能な compose 内 Keycloak であり、露出は限定的
- Cognito へ移行する場合も同様に、`ALLOW_USER_PASSWORD_AUTH` を本番 App client で
  有効化しないこと
