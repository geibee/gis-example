# 環境変数

## Service storage

- `FEEDBACK_EVIDENCE_STORAGE=local|s3`。S3時は `FEEDBACK_S3_BUCKET` 必須、任意で
  `FEEDBACK_S3_REGION`、`FEEDBACK_S3_ENDPOINT_URL`、`FEEDBACK_S3_KEY_PREFIX`。
- `FEEDBACK_EXPORT_STORAGE=local|s3`。S3時は `FEEDBACK_EXPORT_S3_BUCKET` 必須、任意で
  `FEEDBACK_EXPORT_S3_REGION`、`FEEDBACK_EXPORT_S3_ENDPOINT_URL`、`FEEDBACK_EXPORT_KEY_PREFIX`。
- local時は `FEEDBACK_EVIDENCE_DIR` / `FEEDBACK_EXPORT_DIR` を使用する。

DB password、notification暗号鍵、webhook署名secretに既定値はない。notification暗号鍵は
base64 decode後32 byte、webhook署名secretと参照consumerのfixture session署名secretは32文字以上とする。OIDCとtoken exchangeの変数は
`apps/feedback-service/src/main/kotlin/feedback/service/Configuration.kt`、brokerの変数は
`apps/feedback-token-broker-reference/README.md` を参照する。productionではsecret managerまたは
orchestratorのsecret注入を使用し、ファイルやimageへ埋め込まない。
