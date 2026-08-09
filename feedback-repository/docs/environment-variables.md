# 環境変数

## Service storage

- `FEEDBACK_EVIDENCE_STORAGE=local|s3`。S3時は `FEEDBACK_S3_BUCKET` 必須、任意で
  `FEEDBACK_S3_REGION`、`FEEDBACK_S3_ENDPOINT_URL`、`FEEDBACK_S3_KEY_PREFIX`。
- `FEEDBACK_EXPORT_STORAGE=local|s3`。S3時は `FEEDBACK_EXPORT_S3_BUCKET` 必須、任意で
  `FEEDBACK_EXPORT_S3_REGION`、`FEEDBACK_EXPORT_S3_ENDPOINT_URL`、`FEEDBACK_EXPORT_KEY_PREFIX`。
- local時は `FEEDBACK_EVIDENCE_DIR` / `FEEDBACK_EXPORT_DIR` を使用する。

自動backupはexport workerが同じExport storageへ`FEEDBACK_BACKUP_KEY_PREFIX` (既定`backups/`)で保存し、
`FEEDBACK_BACKUP_MAX_ATTEMPTS` (既定`5`)まで再試行する。共有フォルダ搬送CLIは
`FEEDBACK_PULL_API_BASE_URL`、`FEEDBACK_PULL_TOKEN_URL`、client ID/secret、対象application/workspace、
マウント済み`FEEDBACK_PULL_DESTINATION_DIR`を使用する。scopeの既定は`feedback.manage`。

別プロセスconnectorの登録には`FEEDBACK_CONNECTOR_KEY`、descriptor/delivery URL、共有secret、表示名を使う。
runtimeにはprovider、`destinationRef` mapping、共有secret、永続的な`FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE`が必須。
Webhook runtimeは外向き署名用`FEEDBACK_WEBHOOK_SIGNING_SECRET`、SMTP runtimeは`FEEDBACK_SMTP_*`を追加で使う。
実URL、宛先、SMTP資格情報はFeedback Serviceへ渡さない。

DB password、notification暗号鍵、connector/Webhook署名secretに既定値はない。notification暗号鍵は
base64 decode後32 byte、署名secretと参照consumerのfixture session署名secretは32文字以上とする。OIDCとtoken exchangeの変数は
`apps/feedback-service/src/main/kotlin/feedback/service/Configuration.kt`、brokerの変数は
`apps/feedback-token-broker-reference/README.md` を参照する。productionではsecret managerまたは
orchestratorのsecret注入を使用し、ファイルやimageへ埋め込まない。
