# Quickstart

`npm ci` 後に `bash scripts/verify-feedback.sh` を実行する。Feedback Serviceは同梱Gradle wrapperを使うため、
JDK 21以外のグローバルGradleを必要としない。standalone composeはPostgreSQL 16、MinIO、local OIDC、API、
notification/export/retention worker、Admin Console、reference broker、consumer fixtureだけを起動する。

`deploy/.env.example` を `deploy/.env` へコピーしてから `docker compose --env-file deploy/.env -f deploy/compose.yaml up --build`
を実行する。例示credentialはローカル専用で、本番へ転用しない。

全containerを使う投稿・返信・編集・resolve・Evidence・Export・retention・通知・mTLS brokerの確認は
`bash scripts/smoke-feedback-standalone.sh` で実行する。scriptが作ったcontainerとvolumeは終了時に削除する。
