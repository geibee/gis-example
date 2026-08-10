# Quickstart

`npm ci` 後に `bash scripts/verify-feedback.sh` を実行する。Go 1.26.5だけでbackendを検証し、JDK/Gradleを要求しない。
standalone composeは
PostgreSQL 16、MinIO、local OIDC、API、notification/export/retention worker、Admin Console、reference broker、
consumer fixtureだけを起動する。

`deploy/.env.example` を `deploy/.env` へコピーしてから `docker compose --env-file deploy/.env -f deploy/compose.yaml up --build`
を実行する。例示credentialはローカル専用で、本番へ転用しない。

ComposeはAPI/workerより先にone-shot migrationを依存関係として完了する。migrationだけを手動確認する場合は次を使う。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml \
  run --rm --build feedback-migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

全containerを使う投稿・返信・編集・resolve・Evidence・Export・retention・通知・mTLS brokerの確認は
`bash scripts/smoke-feedback-standalone.sh` で実行する。scriptが作ったcontainerとvolumeは終了時に削除する。
稼働済み環境へ移行する前の24時間lease/cursor/idempotency fault検証は、Go-only形状で
`scripts/soak-feedback-go.sh --output <new-summary.json>`を実行する。未投入環境の初回導入では短縮実行を選べる。
