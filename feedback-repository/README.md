# Feedback System

React 18/19 SPAへ組み込めるフィードバックSDK、独立Feedback Service、Admin Console、
token exchange参照broker、consumer適合fixtureをまとめた自己完結リポジトリ。

## Quickstart

基準環境はNode.js 22、Go 1.26.5、PostgreSQL 16、S3互換object storage。BackendはGo-onlyで、JDK、Gradle、
Feedback専用Kotlin sourceを含まない。

```bash
npm ci
bash scripts/verify-feedback.sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Goが既定runtimeであり、`feedback-migrate`が空DBへclean V1を適用する。
`bash scripts/smoke-feedback-standalone.sh`はmigrationから全経路を自動検証する。

- Feedback API: `http://localhost:8090/feedback/v1`
- Admin Console: `http://localhost:5174`
- conformance consumer: `http://localhost:5175`
- local OIDC: `http://localhost:8180`

公開境界は `@feedback/contracts`、`@feedback/core`、`@feedback/react`、任意の
`@feedback/maplibre` / `@feedback/admin-react` と `/feedback/v1`。ホスト固有の旧APIは含めず、
`feedback-legacy-migration` は旧snapshot取込時だけ使う非公開運用CLIとして分離する。CLI専用journal migrationは
binaryへ埋め込み、本体clean baselineへ旧consumer台帳を含めない。

詳細は `docs/quickstart.md`、`docs/react-integration.md`、`docs/authentication.md`、
`docs/operations.md`、`docs/backup-and-connectors.md`、`docs/upgrade.md`、`docs/api-compatibility.md`、
`docs/release.md`、`docs/canary-and-rollback.md` を参照する。
