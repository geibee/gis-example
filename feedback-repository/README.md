# Feedback System

React 18/19 SPAへ組み込めるフィードバックSDK、独立Feedback Service、Admin Console、
token exchange参照broker、consumer適合fixtureをまとめた自己完結リポジトリ。

## Quickstart

基準環境はNode.js 22、JDK 21、PostgreSQL 16、S3互換object storage。

```bash
npm ci
bash scripts/verify-feedback.sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

- Feedback API: `http://localhost:8090/feedback/v1`
- Admin Console: `http://localhost:5174`
- conformance consumer: `http://localhost:5175`
- local OIDC: `http://localhost:8180`

公開境界は `@feedback/contracts`、`@feedback/core`、`@feedback/react`、任意の
`@feedback/maplibre` / `@feedback/admin-react` と `/feedback/v1`。ホスト固有の旧APIや移行CLIは含まない。

詳細は `docs/quickstart.md`、`docs/react-integration.md`、`docs/authentication.md`、
`docs/operations.md`、`docs/upgrade.md`、`docs/api-compatibility.md` を参照する。
