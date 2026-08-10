# 独立 Feedback Service 運用ガイド

`apps/feedback-service-go` は Web GIS の `apps/api` から分離したGo applicationである。
公開契約は `contracts/feedback/openapi.yaml`、fresh install DDLは
`apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql`を正本とする。旧V1〜V6のchecksum照合用SQLは
`apps/feedback-service-go/migrations/flyway-v1-v6`へ読取専用で保存し、Flyway historyは`feedback` schema内で維持する。

## 境界

- 通常 PostgreSQL だけを使用し、PostGIS、`gis_data`、`app.projects`、`app.users` を参照しない。
- host の project ID は `external_workspace_key` という長さ制限付き文字列として保持し、外部 DB へ FK を張らない。
- 直接 OIDC token は `FEEDBACK_OIDC_AUDIENCE` 専用 audience で検証し、environment の
  `allowed_issuers` と一致する範囲だけを許可する。user の JIT 更新は membership を付与しない。
- token broker を使う場合は別 issuer/audience の短寿命 JWT を検証し、DB membership、token permission、
  tenant/application/environment/workspace claim のすべてを満たす範囲だけを許可する。
- permission は `feedback.read`、`feedback.comment`、`feedback.manage`、`feedback.admin` の固定語彙だけを使う。
- evidence は DB に公開 URL や blob を置かず、private object key、SHA-256、metadata だけを保存する。
- API と notification worker は同一 image だが command を分け、API transaction 内で外部 HTTP を呼ばない。
- thread/message/export の write は tenant/principal/IP 単位の DB counter で rate limit し、超過時は 429 と
  `Retry-After` を返す。principal と IP は SHA-256 だけを counter に保存し、evidence は workspace 単位の
  size/count quota を別に強制する。
- notification webhook endpoint は AES-256-GCM で暗号化して DB に保存し、API/worker だけが Secrets Manager の鍵で復号する。

## ローカル起動

`infra/.env.example` の追加値を既存の `infra/.env` へ反映した後、次を実行する。

```bash
docker compose -f infra/docker-compose.yml --profile feedback up --build
```

この profile は通常の `postgres` とは別に `feedback-postgres` (`postgres:16-alpine`) を起動し、
one-shot `feedback-migrate`の完了後、`feedback-bootstrap`でlocal tenant/application/environment/workspaceと管理membershipを登録する。
Feedback API は `http://localhost:8090/feedback/v1`、health は `/health/live` と `/health/ready` で確認できる。
`/health/ready` はDB/Evidence storage/Export storageを個別の必須依存、notification backlog/failureを
degradedな任意依存として区別する。
`/metrics` は Prometheus text を返す内部運用 endpoint なので、公開 ingress へ露出させない。

既存 volume を持つ Keycloak は realm import の mapper 追加を自動反映しない。その場合は dev realm を作り直すか、
`gis-web` client に `feedback-service` audience mapper を手動追加する。

## 初期 provisioning

管理 API/UI を実装する Phase 3 までは、配布物の `bin/feedback-bootstrap` を one-shot task として実行する。
必要な変数は `docs/environment-variables.md` を参照する。CLI は次を同一 transaction で冪等に登録する。

1. tenant
2. application と environment/allowed origins
3. workspace と `externalWorkspaceKey`
4. OIDC issuer/subject の user
5. application/workspace membership

application manifest 自体は管理主体の token で `PUT /feedback/v1/applications/{applicationKey}/manifest` へ登録する。
同じ `manifestVersion` の内容は不変で、変更時は新しい version を指定する。

## deployment command

| process | command | 必須依存 |
|---|---|---|
| HTTP API | `/app/bin/feedback-service` | PostgreSQL、OIDC JWKS、private object storage |
| notification worker | `/app/bin/feedback-notification-worker` | PostgreSQL、`FEEDBACK_NOTIFICATION_ENCRYPTION_KEY`、内部connector endpoint |
| export/backup worker | `/app/bin/feedback-export-worker` | PostgreSQL、Evidence/Export storage |
| retention worker | `/app/bin/feedback-retention-worker` | PostgreSQL、Evidence/Export storage |
| provisioning | `/app/bin/feedback-bootstrap` | PostgreSQL、`FEEDBACK_BOOTSTRAP_*` |

notification worker は outbox を `FOR UPDATE SKIP LOCKED` で claim し、delivery ID、timestamp、
`v1=<HMAC-SHA256>` 署名を付ける。API の request ID は outbox payload へ引き継ぐ。本文はconnectorで
明示的に許可した場合だけ送り、evidence、object key、tokenは常に送らない。

自動証跡バックアップと別プロセス通知コネクタは
[`feedback-backup-and-connectors.md`](feedback-backup-and-connectors.md)を参照する。従来の単一Webhook設定は
互換用として残るが、新規連携はconnector installationを使用する。

暗号鍵を更新するときは、新しい鍵を `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY`、直前の鍵を
`FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS` に設定して API/worker を同時に更新する。既存 endpoint は
次回の notification setting 更新時に新しい鍵で再暗号化される。全 workspace の更新完了を確認してから旧鍵を外す。

retention worker は policy 行と evidence 行を同じ transaction で lockし、policy延長とpurgeの競合を防ぐ。
期限切れmetadataと監査を先にcommitし、Object Storage削除はtransaction外で行う。削除に失敗したobjectは参照なしの
orphanとして残し、次cycle以降にevidence/export/backup別prefixをDB参照と照合して再試行する。作成transaction中のobjectを
誤削除しないため、`FEEDBACK_ORPHAN_GRACE_SECONDS` は300秒未満にできない。exportとbackupは同じstorageを使うため、
`FEEDBACK_EXPORT_KEY_PREFIX`と`FEEDBACK_BACKUP_KEY_PREFIX`を包含関係にしてはならない。

## 検証

軽量ゲート:

```bash
VERIFY_SCOPE=feedback bash scripts/verify.sh
```

通常 PostgreSQL を指定する統合ゲート:

```bash
VERIFY_SCOPE=feedback VERIFY_INTEGRATION=1 \
FEEDBACK_DATABASE_URL=jdbc:postgresql://localhost:5433/feedback \
FEEDBACK_DATABASE_USER=feedback \
FEEDBACK_DATABASE_PASSWORD=... \
bash scripts/verify.sh
```

統合テストは接続先の `feedback` schema を DROP して作り直す。開発・本番 DB へ向けてはならない。
CI は PostGIS を含まない `postgres:16-alpine` service container でこの経路を毎回実行する。
