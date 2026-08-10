# Feedback Go v1 機能 inventory（W0）

## 0. 目的と固定点

本書は、Feedback Service の Go v1 完全互換移行で比較対象にする公開契約、実装、運用 interface を、機械的に追跡できる形で固定する。製品仕様を再定義する文書ではない。

- contract/interface 固定 commit: `7026ac58ce91e9c6f3291c94fac4fe69bd528def`
- 計画書が示す基準実装 commit: `afe6d04`
- HTTP API SSoT: `contracts/feedback/openapi.yaml`
- token exchange SSoT: `contracts/feedback/token-exchange.openapi.yaml`
- Connector Protocol v1 SSoT: `contracts/feedback/schemas/connector-protocol.schema.json`
- DB DDL SSoT: 固定対象の `V1__*.sql` から `V5__*.sql` と、handoff専用の `V6__go_migration_handoff.sql`
- 環境変数 SSoT: `docs/environment-variables.md`
- 実装・テスト参照は、上記固定 commit の Kotlin/TypeScript/shell source を指す。

集計方法は次のとおり。

1. OpenAPI の `paths` から HTTP method を持つ operation を列挙する。
2. Ktor routing tree との双方向同期、および `feedbackRoutePolicies` との対応を確認する。
3. entrypoint は Gradle `CreateStartScripts`、Docker/Compose command、各 `*Main.kt` から列挙する。
4. 環境変数は `System.getenv`、`requiredEnv`、`process.env`、shell/Compose の `${...}`、Dockerfile の `ARG`/`ENV` から実参照名だけを抽出する。
5. metric は `OperationalMetrics.kt` の固定名と `incrementOperationalMetric` の呼出し文字列を列挙する。
6. migration checksum は固定 commit の blob 内容（末尾改行を含む）へ SHA-256 を適用する。

## 1. HTTP interface

### 1.1 Feedback API: 42 operation

すべての path は OpenAPI `servers.url` の `/feedback/v1` に対する相対 path である。認可欄は `Authorization.kt` の `feedbackRoutePolicies` を示す。

テスト記号:

- **C**: `OpenApiContractSyncTest.kt` が OpenAPI ↔ routing tree を双方向照合し、resource route ↔ permission/scope を照合する。
- **H**: `StandaloneMigrationIntegrationTest.kt` の「実 HTTP は…」試験が当該 HTTP interface を直接呼ぶ。
- **I**: 同 test または `BackupConnectorIntegrationTest.kt` が同じ query/use-case の DB 副作用を統合試験する。
- **S**: `scripts/smoke-feedback-standalone.sh` の standalone 実 HTTP flow に含まれる。

`C` は登録・認可宣言の存在を証明するが、status/header/body/副作用の個別挙動を証明しない。この区別を differential fixture の優先順位へ使う。

| # | method / path | `operationId` | 認可 / scope | Kotlin実装 | 既存テスト |
|---:|---|---|---|---|---|
| 1 | `GET /capabilities` | `getFeedbackCapabilities` | 認証不要 | `Routes.kt:102` | C, H, S |
| 2 | `GET /me` | `getFeedbackMe` | 認証のみ（resource policy対象外） | `Routes.kt:133` | C, H |
| 3 | `GET /applications/{applicationKey}/manifest` | `getFeedbackApplicationManifest` | read / application | `Routes.kt:138-146` | C |
| 4 | `PUT /applications/{applicationKey}/manifest` | `putFeedbackApplicationManifest` | admin / application / mutate | `Routes.kt:147-165` | C, H, S; `ValidationTest.kt` |
| 5 | `GET /review-context` | `getFeedbackReviewContext` | read / workspace | `Routes.kt:168-207` | C; `ValidationTest.kt`（入力規則） |
| 6 | `GET /sessions` | `listFeedbackSessions` | read / workspace | `Routes.kt:209-223` | C |
| 7 | `POST /sessions` | `createFeedbackSession` | manage / workspace / mutate | `Routes.kt:224-245` | C, H, S, I |
| 8 | `GET /sessions/{sessionId}` | `getFeedbackSession` | read / session | `Routes.kt:248-257` | C, I |
| 9 | `PATCH /sessions/{sessionId}` | `patchFeedbackSession` | manage / session / mutate | `Routes.kt:258-268` | C, H, S, I |
| 10 | `GET /sessions/{sessionId}/threads` | `listFeedbackThreads` | read / session | `Routes.kt:271-286` | C, H, I |
| 11 | `POST /sessions/{sessionId}/threads` | `createFeedbackThread` | comment / session / mutate | `Routes.kt:287-311` | C, H, S, I |
| 12 | `GET /threads/{threadId}` | `getFeedbackThread` | read / thread | `Routes.kt:314-322` | C, S, I |
| 13 | `GET /threads/{threadId}/deep-link` | `getFeedbackThreadDeepLink` | read / thread | `Routes.kt:324-330` | C, H; `ExportSupportTest.kt` |
| 14 | `POST /threads/{threadId}/messages` | `createFeedbackMessage` | comment / thread / mutate | `Routes.kt:332-352` | C, H, S, I |
| 15 | `PATCH /messages/{messageId}` | `patchFeedbackMessage` | comment / message / mutate | `Routes.kt:354-370` | C, S, I |
| 16 | `GET /messages/{messageId}/versions` | `listFeedbackMessageVersions` | read / message | `Routes.kt:372-378` | C, I |
| 17 | `PATCH /threads/{threadId}/status` | `patchFeedbackThreadStatus` | manage / thread / mutate | `Routes.kt:380-397` | C, S, I |
| 18 | `GET /threads/{threadId}/evidence` | `getFeedbackEvidence` | read / thread | `Routes.kt:399-426` | C, H, S, I; `ValidationTest.kt` |
| 19 | `POST /exports` | `createFeedbackExport` | manage / workspace / mutate | `Routes.kt:428-449` | C, H, S, I |
| 20 | `GET /exports/{exportId}` | `getFeedbackExport` | manage / export | `Routes.kt:451-457` | C, H, S, I |
| 21 | `GET /exports/{exportId}/download` | `downloadFeedbackExport` | manage / export | `Routes.kt:459-473` | C, H, S; `ExportSupportTest.kt` |
| 22 | `GET /backup-policy` | `getFeedbackBackupPolicy` | admin / workspace | `Routes.kt:475-478` | C, H, I |
| 23 | `PATCH /backup-policy` | `patchFeedbackBackupPolicy` | admin / workspace / mutate | `Routes.kt:475-478` | C, H, I |
| 24 | `GET /backups` | `listFeedbackBackups` | manage / workspace | `Routes.kt:480-489` | C, H, I |
| 25 | `GET /backups/{backupId}` | `getFeedbackBackup` | manage / backup | `Routes.kt:491-497` | C, H（404）, I |
| 26 | `GET /backups/{backupId}/download` | `downloadFeedbackBackup` | manage / backup | `Routes.kt:499-512` | C; `BackupSupportTest.kt`, `BackupPullTest.kt`（成果物） |
| 27 | `POST /backups/{backupId}/retry` | `retryFeedbackBackup` | admin / workspace / mutate | `Routes.kt:514-520` | C, H（404）, I |
| 28 | `GET /retention-policy` | `getFeedbackRetentionPolicy` | manage / workspace | `Routes.kt:522-525` | C, H, S, I |
| 29 | `PATCH /retention-policy` | `patchFeedbackRetentionPolicy` | manage / workspace / mutate | `Routes.kt:522-525` | C, H, S, I |
| 30 | `GET /notification-settings` | `getFeedbackNotificationSettings` | admin / workspace | `Routes.kt:527-530` | C, I |
| 31 | `PATCH /notification-settings` | `patchFeedbackNotificationSettings` | admin / workspace / mutate | `Routes.kt:527-530` | C, I; `NotificationCipherTest.kt` |
| 32 | `GET /connector-types` | `listFeedbackConnectorTypes` | admin / workspace | `Routes.kt:532-535` | C, H, S, I |
| 33 | `GET /notification-connectors` | `listFeedbackNotificationConnectors` | admin / workspace | `Routes.kt:537-541` | C, H, I |
| 34 | `POST /notification-connectors` | `createFeedbackNotificationConnector` | admin / workspace / mutate | `Routes.kt:542-552` | C, H, S, I |
| 35 | `PATCH /notification-connectors/{connectorId}` | `patchFeedbackNotificationConnector` | admin / workspace / mutate | `Routes.kt:555-568` | C, H, I |
| 36 | `DELETE /notification-connectors/{connectorId}` | `deleteFeedbackNotificationConnector` | admin / workspace / mutate | `Routes.kt:569-579` | C, H, I |
| 37 | `GET /memberships` | `listFeedbackWorkspaceMemberships` | admin / workspace | `Routes.kt:582-586` | C, H, I |
| 38 | `POST /memberships` | `createFeedbackWorkspaceMembership` | admin / workspace / mutate | `Routes.kt:587-601` | C, I |
| 39 | `PATCH /memberships/{userId}` | `patchFeedbackWorkspaceMembership` | admin / workspace / mutate | `Routes.kt:604-617` | C, I |
| 40 | `DELETE /memberships/{userId}` | `deleteFeedbackWorkspaceMembership` | admin / workspace / mutate | `Routes.kt:618-628` | C, I |
| 41 | `GET /notification-deliveries` | `listFeedbackNotificationDeliveries` | admin / workspace | `Routes.kt:631-641` | C, H, I |
| 42 | `POST /notification-deliveries/{deliveryId}/retry` | `retryFeedbackNotificationDelivery` | admin / workspace / mutate | `Routes.kt:643-649` | C, I |

OpenAPIの全42 operationは分類済みである。個別の実HTTP挙動試験がない operation は未分類ではなく、`C` のみまたは `C, I` として意図的に区別した。

### 1.2 Token Exchange API: 2 operation

Token broker は Kotlin Feedback Service の置換対象ではないが、Go版が検証するexchange JWTを発行する隣接trust boundaryなので比較対象へ含める。

| method / path | `operationId` | SSoT | 実装 | 既存テスト |
|---|---|---|---|---|
| `POST /v1/exchanges` | `exchangeFeedbackToken` | `contracts/feedback/token-exchange.openapi.yaml` | `apps/feedback-token-broker-reference/src/server.ts:33-49` | `policy.test.ts`（policy/JWT入力）、`scripts/smoke-feedback-standalone.sh`（実exchange） |
| `GET /.well-known/jwks.json` | `getFeedbackTokenBrokerJwks` | 同上 | `server.ts:30-32,59-66`（TLS portとservice-network HTTP port） | standalone smokeからのGo/Kotlin verifier接続（直接response goldenなし） |

### 1.3 公開OpenAPI外の運用・Connector HTTP

| process | method / path | 契約上の意味 | SSoT / 実装 | 既存テスト |
|---|---|---|---|---|
| `feedback-service` | `GET /health/live` | process liveness | `docs/feedback-operations-guide.md`; `Routes.kt:52` | `OpenApiContractSyncTest.kt` の理由付き除外、standalone smoke |
| `feedback-service` | `GET /health/ready` | DB/evidence/export必須、notificationはdegraded任意依存 | 同文書; `Routes.kt:53-92` | `StandaloneMigrationIntegrationTest.kt:783` |
| `feedback-service` | `GET /metrics` | Prometheus text 0.0.4 | 同文書; `Routes.kt:93-96` | `StandaloneMigrationIntegrationTest.kt:783` |
| `feedback-connector-runtime` | `GET /connector/v1/manifest` | Connector Protocol v1 manifest | `connector-protocol.schema.json`; `ConnectorRuntimeMain.kt:103-111` | `schema.test.ts`; register/standalone smoke |
| 同上 | `GET /health/live` | connector liveness | manifestの`healthPath`運用契約; `ConnectorRuntimeMain.kt:112` | route単体の直接試験なし |
| 同上 | `GET /health/ready` | connector readiness/health check target | 同上; `ConnectorRuntimeMain.kt:113` | `ConnectorDispatcherTest.kt`, `BackupConnectorIntegrationTest.kt` |
| 同上 | `POST /connector/v1/deliveries` | HMAC付きdelivery request、accepted/duplicate result | `connector-protocol.schema.json`; `ConnectorRuntimeMain.kt:114-184` | `ConnectorRuntimeTest.kt`, `ConnectorDispatcherTest.kt`, `BackupConnectorIntegrationTest.kt` |

`apps/feedback-conformance-consumer/src/server.ts` の `/fixture-*` はテストfixture専用、Feedback本番interfaceではない。Token brokerとConnector runtimeのHTTP操作はFeedback OpenAPI 42件へ混ぜず、上表で隣接interfaceとして分類した。

### 1.4 JSON schema資産

| 資産 | SSoT | 実装利用 | テスト |
|---|---|---|---|
| application manifest v1 | `schemas/application-manifest.schema.json` | `Validation.kt`, manifest route | `schema.test.ts`, `ValidationTest.kt`, standalone integration |
| location v1 | `schemas/location.schema.json` | `Validation.kt`, review-context/thread | 同上 |
| target v1 | `schemas/target.schema.json` | `Validation.kt`, thread create | 同上（全variant） |
| webhook event v1 | `schemas/webhook-event.schema.json` | notification worker/runtime | `schema.test.ts`, connector tests |
| Connector Protocol v1 | `schemas/connector-protocol.schema.json` | register, worker dispatcher, reference runtime | `schema.test.ts`, connector tests |
| token exchange JWT | `schemas/token-exchange-jwt.schema.json` | `Auth.kt` exchange principal | `schema.test.ts`, `PermissionMatrixTest.kt`, standalone HTTP auth test |

## 2. Process / CLI inventory

既存entrypointは9本。計画で新設する `feedback-migrate` を加えた10本を移行対象とする。`BackupWorker` は独立entrypointではなく、現行 `feedback-export-worker` 内でexportより先に実行される。

| entrypoint | 現行責務 | packaging / 実装 | 既存テスト・運用参照 | Go v1状態 |
|---|---|---|---|---|
| `feedback-service` | HTTP API、起動時Flyway、health/metrics | `build.gradle.kts` default application; `Application.kt` | OpenAPI sync、standalone integration/smoke | 同名symlink/subcommand必須 |
| `feedback-notification-worker` | outbox、connector queue claim/lease、health、retry | `NotificationWorkerMain.kt`; main distribution; Compose | `ConnectorDispatcherTest.kt`, standalone/backup connector integration | 分離維持 |
| `feedback-export-worker` | backup scheduler/claim/buildを優先し、次にexport claim/build | `ExportWorkerMain.kt`, `BackupWorkerMain.kt`; main distribution; Compose | `ExportSupportTest.kt`, `BackupSupportTest.kt`,両integration | 1 process内の現行責務順を維持 |
| `feedback-retention-worker` | evidence/export/backup retention、delete retry、orphan cleanup | `RetentionWorkerMain.kt`; main distribution; Compose | standalone integration/smoke | 分離維持 |
| `feedback-bootstrap` | tenant/application/environment/workspace/principal/membershipの冪等登録 | `BootstrapMain.kt`; main distribution; Compose one-shot | standalone integration/smoke（bootstrap結果を利用） | 同名CLI必須 |
| `feedback-connector-register` | descriptor取得・照合、Connector installation登録、legacy map | `ConnectorBootstrapMain.kt`; main distribution; Compose one-shot | `ConnectorDispatcherTest.kt`, standalone smoke | 同名CLI必須 |
| `feedback-connector-runtime` | Webhook/Teams/Slack/SMTP reference connector | `ConnectorRuntimeMain.kt`; main distribution; Compose | `ConnectorRuntimeTest.kt`, standalone smoke | 同名server必須 |
| `feedback-backup-pull` | OAuth client credentials、一覧pagination、checksum/manifest検証、atomic配置 | `BackupPullMain.kt`; main distribution（Compose常駐なし） | `BackupPullTest.kt`; `docs/feedback-backup-and-connectors.md` | 同名CLI必須 |
| `feedback-legacy-migration` | `dry-run` / `apply` / `reconcile` / `rollback` | Kotlinは`legacyMigration`別distribution。Goは単一image/binaryの専用symlink/subcommand | Kotlin/Go legacy PostgreSQL integration; `docs/feedback-v1-copy-runbook.md` | 実装済み。専用journalをCLIだけが準備する |
| `feedback-migrate` | V6 handoff後のone-shot schema migration | 固定commitには未実装。Goは単一image/binaryの専用symlink/subcommand | handoff/convergence、fresh baseline、同時実行integration | 実装済み。V7以降の唯一のmigration owner |

CLI argument contract:

- `feedback-legacy-migration <dry-run|apply|reconcile|rollback> --input <snapshot.json> [--run-id <uuid>] [--confirm-copy|--confirm-rollback]`。`apply`/`rollback` は確認flag必須。
- 他の既存entrypointはcommand line optionを公開せず環境変数駆動。Go版でもsecretをCLI argumentへ移さない。

## 3. `FEEDBACK_*` 設定 inventory

### 3.1 集合と分類

固定commitの実参照125個にPhase 0で追加したtest専用3個を加え、現在の実参照は **128個**。内訳は次のとおり。

| 分類 | 個数 | 扱い |
|---|---:|---|
| Kotlin Feedback backend runtime/CLI | 88 | Go版が名前・必須性・default・範囲検証を維持する |
| reference token broker | 11 | broker自体はGo置換対象外。exchange検証fixtureとして維持する |
| conformance consumer固有 | 4 | test fixture設定。Go server runtimeへ取り込まない |
| Docker build / Compose / monorepo配線固有 | 11 | 配布・開発interfaceとして別管理する |
| verify / integration / smoke control | 14 | 品質ゲートinterface。production runtimeへ取り込まない |

`docs/environment-variables.md` はbackend 88個をすべて記載する。一方、adjunct/toolingの実参照24個は未記載である（§3.4）。`FEEDBACK_AUTH_NAME` / `FEEDBACK_EXCHANGE_AUTH_NAME`（Kotlin定数）、`FEEDBACK_THREAD` / `FEEDBACK_MESSAGE`（enum）、`FEEDBACK_BOOTSTRAP_` / `FEEDBACK_SMTP_`（文書上のprefix表記）は環境変数ではないため件数から除外した。

### 3.2 Go版へ引き継ぐbackend 88個

各行に含む全変数の必須/任意、default、範囲は `docs/environment-variables.md` がSSoT。実装欄はdecode/validation箇所、テスト欄は現行の検証強度を示す。

| 分類（個数） | 変数 | 実装 | 既存テスト |
|---|---|---|---|
| service共通 (1) | `FEEDBACK_PORT` | `Configuration.kt:190-216` | Compose config、standalone smoke |
| DB (6) | `FEEDBACK_DATABASE_URL`, `FEEDBACK_DATABASE_USER`, `FEEDBACK_DATABASE_PASSWORD`, `FEEDBACK_DATABASE_POOL_SIZE`, `FEEDBACK_DATABASE_CONNECTION_TIMEOUT_MS`, `FEEDBACK_DATABASE_STATEMENT_TIMEOUT_MS` | `Configuration.kt:9-34` | integrationでURL/user/password、設定decode個別testなし |
| direct OIDC (7) | `FEEDBACK_ALLOW_INSECURE_HTTP`, `FEEDBACK_OIDC_ISSUER`, `FEEDBACK_OIDC_AUDIENCE`, `FEEDBACK_OIDC_JWKS_URL`, `FEEDBACK_OIDC_SUBJECT_CLAIM`, `FEEDBACK_OIDC_DISPLAY_NAME_CLAIM`, `FEEDBACK_OIDC_EMAIL_CLAIM` | `Configuration.kt:36-69` | standalone HTTP auth/CORS、URL/default decode個別testなし |
| token exchange verifier (5) | `FEEDBACK_TOKEN_EXCHANGE_ISSUER`, `FEEDBACK_TOKEN_EXCHANGE_AUDIENCE`, `FEEDBACK_TOKEN_EXCHANGE_JWKS_URL`, `FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS`, `FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS` | `Configuration.kt:71-109`, `Auth.kt` | `PermissionMatrixTest.kt`, standalone HTTP auth、範囲decode個別testなし |
| evidence storage/quota (8) | `FEEDBACK_EVIDENCE_STORAGE`, `FEEDBACK_EVIDENCE_DIR`, `FEEDBACK_EVIDENCE_MAX_BYTES`, `FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE`, `FEEDBACK_S3_BUCKET`, `FEEDBACK_S3_REGION`, `FEEDBACK_S3_ENDPOINT_URL`, `FEEDBACK_S3_KEY_PREFIX` | `Configuration.kt:111-141,190-216`, `EvidenceStorage.kt` | `ValidationTest.kt`, standalone/MinIO integration |
| export storage/worker (7) | `FEEDBACK_EXPORT_STORAGE`, `FEEDBACK_EXPORT_DIR`, `FEEDBACK_EXPORT_S3_BUCKET`, `FEEDBACK_EXPORT_S3_REGION`, `FEEDBACK_EXPORT_S3_ENDPOINT_URL`, `FEEDBACK_EXPORT_KEY_PREFIX`, `FEEDBACK_EXPORT_POLL_MS` | `Configuration.kt:143-173`, `ExportWorkerMain.kt` | export unit/integration、poll範囲はconstructor経由のみ |
| backup worker (2) | `FEEDBACK_BACKUP_KEY_PREFIX`, `FEEDBACK_BACKUP_MAX_ATTEMPTS` | `ExportWorkerMain.kt:10-18`, `RetentionWorkerMain.kt` | backup unit/MinIO integration、env decode個別testなし |
| rate limit (3) | `FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE`, `FEEDBACK_WRITE_RATE_LIMIT_PER_TENANT_PER_MINUTE`, `FEEDBACK_WRITE_RATE_LIMIT_PER_IP_PER_MINUTE` | `Configuration.kt:198-209`, `Routes.kt:654-669` | standalone integration（3 dimension） |
| notification共通 (5) | `FEEDBACK_NOTIFICATION_POLL_MS`, `FEEDBACK_NOTIFICATION_MAX_ATTEMPTS`, `FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP`, `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY`, `FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS` | `NotificationWorkerMain.kt`, `NotificationCipher.kt`, `Validation.kt` | cipher/dispatcher unit、standalone integration |
| retention (2) | `FEEDBACK_RETENTION_POLL_MS`, `FEEDBACK_ORPHAN_GRACE_SECONDS` | `RetentionWorkerMain.kt:20-33` | standalone integration/smoke、env decode個別testなし |
| bootstrap (14) | `FEEDBACK_BOOTSTRAP_TENANT_KEY`, `FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME`, `FEEDBACK_BOOTSTRAP_APPLICATION_KEY`, `FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME`, `FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY`, `FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL`, `FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS`, `FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY`, `FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME`, `FEEDBACK_BOOTSTRAP_ISSUER`, `FEEDBACK_BOOTSTRAP_SUBJECT`, `FEEDBACK_BOOTSTRAP_EMAIL`, `FEEDBACK_BOOTSTRAP_DISPLAY_NAME`, `FEEDBACK_BOOTSTRAP_PERMISSIONS` | `BootstrapMain.kt` | Compose one-shot/standalone smoke、fromEnv個別testなし |
| connector register/runtime/worker (14) | `FEEDBACK_CONNECTOR_KEY`, `FEEDBACK_CONNECTOR_DISPLAY_NAME`, `FEEDBACK_CONNECTOR_DESCRIPTOR_URL`, `FEEDBACK_CONNECTOR_DELIVERY_URL`, `FEEDBACK_CONNECTOR_ALLOWED_HOSTS`, `FEEDBACK_CONNECTOR_SUPPORTED_EVENTS`, `FEEDBACK_CONNECTOR_ENABLED`, `FEEDBACK_CONNECTOR_LEGACY_REF_MAP`, `FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK`, `FEEDBACK_CONNECTOR_PROVIDER`, `FEEDBACK_CONNECTOR_PORT`, `FEEDBACK_CONNECTOR_SHARED_SECRET`, `FEEDBACK_CONNECTOR_DESTINATIONS`, `FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE` | `ConnectorBootstrapMain.kt`, `ConnectorRuntimeMain.kt`, `NotificationWorkerMain.kt` | connector unit/integration/smoke |
| Webhook connector (1) | `FEEDBACK_WEBHOOK_SIGNING_SECRET` | `ConnectorRuntimeMain.kt` | `ConnectorRuntimeTest.kt`, conformance/standalone smoke |
| SMTP connector (5) | `FEEDBACK_SMTP_HOST`, `FEEDBACK_SMTP_PORT`, `FEEDBACK_SMTP_USERNAME`, `FEEDBACK_SMTP_PASSWORD`, `FEEDBACK_SMTP_FROM` | `ConnectorRuntimeMain.kt:303-366` | `ConnectorRuntimeTest.kt`（mail sender差替え）、実SMTP smokeなし |
| backup pull (8) | `FEEDBACK_PULL_API_BASE_URL`, `FEEDBACK_PULL_TOKEN_URL`, `FEEDBACK_PULL_CLIENT_ID`, `FEEDBACK_PULL_CLIENT_SECRET`, `FEEDBACK_PULL_SCOPE`, `FEEDBACK_PULL_APPLICATION_KEY`, `FEEDBACK_PULL_EXTERNAL_WORKSPACE_KEY`, `FEEDBACK_PULL_DESTINATION_DIR` | `BackupPullMain.kt:109-153` | `BackupPullTest.kt`（HTTP/checksum/path/atomic）、fromEnv個別testなし |

上表の個数合計は88。`FEEDBACK_DATABASE_PASSWORD` は `PGPASSWORD`、`FEEDBACK_DATABASE_USER` は `PGUSER` も受け付けるが、Go移行時もsecretの既定値を追加してはならない。

### 3.3 隣接component / 開発・品質ゲート設定37個

| 分類（個数） | 変数 | SSoT / 実装 | テスト・扱い |
|---|---|---|---|
| token broker (11) | `FEEDBACK_BROKER_ISSUER`, `FEEDBACK_BROKER_AUDIENCE`, `FEEDBACK_BROKER_TLS_CERT_FILE`, `FEEDBACK_BROKER_TLS_KEY_FILE`, `FEEDBACK_BROKER_CLIENT_CA_FILE`, `FEEDBACK_BROKER_SIGNING_PRIVATE_KEY_FILE`, `FEEDBACK_BROKER_SIGNING_PUBLIC_KEY_FILE`, `FEEDBACK_BROKER_CLIENT_POLICIES_FILE`, `FEEDBACK_BROKER_MAX_LIFETIME_SECONDS`, `FEEDBACK_BROKER_PORT`, `FEEDBACK_BROKER_JWKS_PORT` | `docs/environment-variables.md`（port 2個を除く）; token broker `server.ts` | policy unit、standalone smoke。Go backend configへ混ぜない |
| conformance consumer固有 (4) | `FEEDBACK_BROKER_URL`, `FEEDBACK_BROKER_CA_FILE`, `FEEDBACK_BROKER_CLIENT_CERT_FILE`, `FEEDBACK_BROKER_CLIENT_KEY_FILE` | `apps/feedback-conformance-consumer/src/server.ts`, `deploy/compose.yaml` | conformance test/smoke。`FEEDBACK_WEBHOOK_SIGNING_SECRET` はbackend 88側と共有 |
| Docker build/Compose/monorepo配線 (11) | `FEEDBACK_ADMIN_APPLICATION`, `FEEDBACK_ADMIN_ENVIRONMENT`, `FEEDBACK_ADMIN_WORKSPACE`, `FEEDBACK_APPLICATION`, `FEEDBACK_ENVIRONMENT`, `FEEDBACK_ADMIN_HOST_PORT`, `FEEDBACK_POSTGRES_DB`, `FEEDBACK_POSTGRES_USER`, `FEEDBACK_POSTGRES_PASSWORD`, `FEEDBACK_POSTGRES_HOST_PORT`, `FEEDBACK_SERVICE_HOST_PORT` | admin/web Dockerfiles、`deploy/compose.yaml` / `infra/docker-compose.yml`; host/dbの一部だけ環境変数文書あり | Docker/Compose config、extraction image build。server runtime設定ではない |
| verify/integration/smoke (14) | `FEEDBACK_VERIFY_SKIP_NPM_CI`, `FEEDBACK_VERIFY_SKIP_PACKAGE_CONSUMERS`, `FEEDBACK_EXTRACTION_SKIP_DOCKER_BUILD`, `FEEDBACK_EXTRACTION_SKIP_STANDALONE_SMOKE`, `FEEDBACK_SMOKE_MANAGE_COMPOSE`, `FEEDBACK_SMOKE_PROJECT`, `FEEDBACK_TEST_S3_ENDPOINT`, `FEEDBACK_TEST_S3_REGION`, `FEEDBACK_TEST_S3_BUCKET`, `FEEDBACK_TEST_S3_ACCESS_KEY`, `FEEDBACK_TEST_S3_SECRET_KEY`, `FEEDBACK_TEST_RUN_ID`, `FEEDBACK_DIFFERENTIAL_KOTLIN_URL`, `FEEDBACK_DIFFERENTIAL_GO_URL` | `scripts/verify-feedback.sh`, `check-feedback-extraction.sh`, `smoke-feedback-standalone.sh`, integration/differential test | CI自身が利用。skipは明示時だけで通常gateを弱めず、Kotlin/Goは分離DB/Object Storageへ接続する |

### 3.4 文書SSoTとの差分（Go移行で解消）

実参照125個のうち、次の24個は固定commitの `docs/environment-variables.md` に項目がない。

- token broker/consumer: `FEEDBACK_BROKER_PORT`, `FEEDBACK_BROKER_JWKS_PORT`, `FEEDBACK_BROKER_URL`, `FEEDBACK_BROKER_CA_FILE`, `FEEDBACK_BROKER_CLIENT_CERT_FILE`, `FEEDBACK_BROKER_CLIENT_KEY_FILE`
- build/Compose: `FEEDBACK_ADMIN_APPLICATION`, `FEEDBACK_ADMIN_ENVIRONMENT`, `FEEDBACK_ADMIN_WORKSPACE`, `FEEDBACK_APPLICATION`, `FEEDBACK_ENVIRONMENT`, `FEEDBACK_POSTGRES_HOST_PORT`, `FEEDBACK_SERVICE_HOST_PORT`
- gate: `FEEDBACK_VERIFY_SKIP_NPM_CI`, `FEEDBACK_VERIFY_SKIP_PACKAGE_CONSUMERS`, `FEEDBACK_EXTRACTION_SKIP_DOCKER_BUILD`, `FEEDBACK_EXTRACTION_SKIP_STANDALONE_SMOKE`, `FEEDBACK_SMOKE_MANAGE_COMPOSE`, `FEEDBACK_SMOKE_PROJECT`, `FEEDBACK_TEST_S3_ENDPOINT`, `FEEDBACK_TEST_S3_REGION`, `FEEDBACK_TEST_S3_BUCKET`, `FEEDBACK_TEST_S3_ACCESS_KEY`, `FEEDBACK_TEST_S3_SECRET_KEY`

これはPhase 0時点ではinventory上の未分類ではなく、**既存SSoTの不足**として分類した。2026-08-10の親統合で
broker/consumer、build/release/smoke、integration内部変数を`docs/environment-variables.md`へ追記し、実参照との差分を0件にした。
`check-feedback-contracts.sh`は今後の未記載変数をfail-closedに検出する。`FEEDBACK_AUTH_NAME`と
`FEEDBACK_EXCHANGE_AUTH_NAME`はKotlinの認証provider定数であり、環境変数ではない。

## 4. Prometheus metric inventory

公開endpointは `/metrics`、formatは `text/plain; version=0.0.4; charset=utf-8`。固定名10個とDB counter由来3個、合計13個である。

| metric | 種別 / label | 増分・算出条件 | 実装 | 既存テスト |
|---|---|---|---|---|
| `feedback_api_requests_total` | process counter / labelなし | `/metrics` 自身を除く完了requestごとに+1 | `Application.kt:61-68`, `OperationalMetrics.kt:17` | metric名の直接assertなし |
| `feedback_api_errors_total` | process counter / labelなし | 上記requestのstatus >= 400で+1 | 同上 `:18` | 直接assertなし |
| `feedback_api_latency_seconds_count` | process counter / labelなし | request countと同値 | 同上 `:19` | 直接assertなし |
| `feedback_api_latency_seconds_sum` | process累積秒 / labelなし | 完了requestのnon-negative elapsed nanos合計 | 同上 `:20` | standalone integration |
| `feedback_posts_total{tenant}` | DB単調counter | thread初期messageまたはmessage投稿成功で+1 | `ThreadQueries.kt:273,329` | standalone integration |
| `feedback_storage_failures_total{tenant}` | DB単調counter | evidence read失敗またはSHA-256不一致で+1（metric記録自体はbest effort） | `ThreadQueries.kt:466-500` | 名前/増分の直接assertなし |
| `feedback_delivery_failures_total{tenant}` | DB単調counter | connector delivery attemptが成功以外で+1 | `NotificationWorkerMain.kt:223` | retry挙動はintegration、metric直接assertなし |
| `feedback_tenant_evidence_bytes{tenant}` | DB gauge | tenantのevidence `byte_size` 合計 | `OperationalMetrics.kt:49-83` | standalone integration |
| `feedback_tenant_thread_count{tenant}` | DB gauge | tenantのthread件数 | 同上 | 名前の直接assertなし |
| `feedback_tenant_export_count{tenant}` | DB gauge | tenantのexport job件数 | 同上 | 名前の直接assertなし |
| `feedback_delivery_failure_count{tenant}` | DB gauge | status=`failed`のnotification outbox件数 | 同上 | standalone integration |
| `feedback_outbox_lag_seconds{tenant}` | DB gauge | pending/processing outbox最古作成時刻から現在まで | 同上 | standalone integration |
| `feedback_purge_backlog{tenant}` | DB gauge | retention期限到達済みevidence件数 | 同上 | standalone integration |

`feedback_delivery_failures_total`（試行失敗の累積counter）と `feedback_delivery_failure_count`（現在failedのoutbox gauge）は別metricであり、Go版で統合・改名しない。全metricのHELP/TYPE行は現行実装にないため、互換移行中には追加しないか、dashboard/parserへの影響を別契約変更として扱う。

## 5. DB migration freeze

### 5.1 Feedback schema V1〜V6

| version | file | SHA-256（固定commit blob） | 主な責務 | runner / test |
|---:|---|---|---|---|
| V1 | `V1__feedback_baseline.sql` | `19bcdc24abc472af0eafe6d0234b5fc3003dc76609e1965b62244b46d9d6ae87` | 独立Feedback baseline | `internal/contract/freeze_test.go`、migration integration |
| V2 | `V2__export_delivery_admin.sql` | `7c69225866b02ec4c9aec322bfb685e2240defe391707799d21dcc16d4161961` | export/admin/delivery | 同上 |
| V3 | `V3__legacy_copy_journal.sql` | `77538b716dd5458a5e5151eed2e4ad6eeebe00e8f0a2bc1486a6a71de61947db` | legacy copy/change補助 | 同上; legacy integration |
| V4 | `V4__standalone_operational_guards.sql` | `827f25016745b50930de5bd4618bf4c128b591288ccb8e301698dcf0c3d117e9` | rate limit/operational counter等 | 同上 |
| V5 | `V5__backup_and_connector_foundation.sql` | `6fdb8666c9162baf01a0fcb422a1328488485e396556641c805ba2f75aec7f93` | backup/change journal/connector | 同上; backup connector integration |
| V6 | `V6__go_migration_handoff.sql` | `943413d193000d17b679738bf21ce53f43af2db0a2c974c2e814297ad30658bb` | Go migrator台帳とrestore安定化したV5業務schema fingerprint marker。業務table変更なし | Go handoff/migrator integration |

Flyway履歴は `feedback.flyway_schema_history`。Go版はこれを編集・削除せず監査証跡として読む。V1〜V5のchecksumはGo migratorの独自version tableへ再登録するための値ではなく、handoff前の改変検知基準である。

### 5.2 Legacy migration専用schema

`apps/feedback-service-go/migrations/legacyjournal/V1__feedback_v4_copy_journal.sql`の固定SHA-256は
`f6787f3795bac28e04432270ec812655f205f2bff30f056b2118600b18504fb0`。`feedback-legacy-migration`起動時の専用runnerが
`feedback_migration.flyway_schema_history`を使用し、
Feedback本体の履歴と分離する。本体clean V1へ旧consumer台帳を戻さず、CLIを実行したDBだけへtransaction適用する。
既存journalはFlyway script/description/CRC32とschema形状を照合し、部分適用やchecksum差分を拒否する。

### 5.3 Phase 0 handoff境界

- V6はGo migrator version table/baseline markerだけを追加し、既存業務tableを変えない。
- 通常のV1〜V6 upgradeに対するrestore安定canonical business schema fingerprintは
  `01d03abc057749179777853ca970bc220f1ee79d8b6fa98d0e0801ba5788e36d`。
- 独立repositoryのclean V1は旧consumer用`feedback.legacy_migration_*`だけを除外するため、
  Flyway履歴V1専用fingerprint `de8ba8a564a39b533e92b37ebffd32bc1a6fbfb66addaad4f56dbd78cb934259`を使う。
  Go版は履歴形状とfingerprintの組合せを固定し、相互流用を拒否する。
- CHECK/partial indexのtext-array castは`pg_dump`/`pg_restore`で同値の別表記になるため、column型、演算子、
  値集合を維持した表記へ正規化してからhashする。source/restoreは両履歴形状で同じfingerprintへ収束する。
- `pg_get_constraintdef`、`pg_indexes`、sequence defaultの表記は`search_path`依存のため、Go版は専用transaction内で
  `feedback, pg_catalog`へ固定する。DB ownerと別の実行roleでも同じfingerprintになることを実体試験で固定する。
- 適用済みV1〜V6は`apps/feedback-service-go/migrations/flyway-v1-v6`へchecksumを保ったまま保存する。
- Go migration integrationでfresh baseline、既存V1〜V6、既存data維持、schema fingerprint収束を検証済み。

## 6. Object Storage key / 成果物format

| 成果物 | key / filename contract | byte/entry contract | 実装 | 既存テスト |
|---|---|---|---|---|
| evidence | `${FEEDBACK_S3_KEY_PREFIX:-evidence/}{tenantId}/{workspaceId}/{threadId}` | `image/png` または `image/webp`原本、DBにcontent type/size/SHA-256。downloadはRange/Content-Range/Accept-Ranges | `ThreadQueries.kt:226-244,466-503`, `Routes.kt:399-426` | `ValidationTest.kt`, standalone/MinIO integration |
| legacy copy evidence | `evidence/migration/{runId}/{evidenceId}` | snapshot base64をdecodeした原本、apply失敗/rollbackで追跡削除 | `LegacyMigration.kt:183-203,710` | `LegacyMigrationIntegrationTest.kt` |
| export CSV | `${FEEDBACK_EXPORT_KEY_PREFIX:-exports/}{tenantId}/{workspaceId}/{exportId}-{claimToken}.csv`; download名 `feedback-{exportId}.csv` | UTF-8 BOM、CRLF、全cell quote/RFC 4180相当、式先頭へapostrophe、locale header、timezone時刻 | `ExportWorkerMain.kt:48-63`, `ExportSupport.kt:40-143`, `ExportQueries.kt:171-197` | `ExportSupportTest.kt`, standalone integration |
| export XLSX | 同prefix/patternの`.xlsx`; download名 `feedback-{exportId}.xlsx` | 最小OOXML ZIP、sheet名`Feedback`、inline string、式対策済み | `ExportSupport.kt:145-202` | `ExportSupportTest.kt`, standalone integration |
| full/incremental backup object | `${FEEDBACK_BACKUP_KEY_PREFIX:-backups/}{tenantId}/{workspaceId}/{yyyy}/{MM}/{scheduledFor-colon→hyphen}--{kind}-{runId}-attempt-{attempt}-{claimToken}.zip` | `application/zip`; entry timestamp 0; archive SHA-256/byte sizeをDBへ記録 | `BackupWorkerMain.kt:15-31` | `BackupSupportTest.kt`, `BackupConnectorIntegrationTest.kt`（MinIO） |
| backup ZIP CSV entries | `threads.csv`, `messages.csv`, `message_versions.csv`, `status_events.csv`, `audit_logs.csv`, `evidence.csv` | UTF-8 BOM、CRLF、全cell quote、式対策。queryのORDER BYを維持 | `BackupQueries.kt:646-725`, `BackupSupport.kt:125-145` | backup unit/integration |
| backup ZIP evidence entries | `evidence/{threadId}.png` または `.webp` | `includeEvidence=true`時のみ。元objectのSHA-256一致必須 | 同上 | backup unit/integration |
| backup manifest | `manifest.json` | `schemaVersion="1"`; run/kind/schedule/scope、change/audit cursor、history coverage、includeEvidence、counts、各entryのSHA-256/bytes/rows | `BackupSupport.kt:90-123` | `BackupSupportTest.kt`, `BackupPullTest.kt`, backup integration |
| backup pull local file | `{yyyyMMdd'T'HHmmss'Z'}-{full|incremental}-{runId}.zip` | 同directory `.part` temp、archive SHA-256とmanifest全entryを検証後atomic replace、追加entry/path traversal/root出力拒否。OAuth secret/Bearer token保護のためHTTP redirectは追跡しない | `BackupPullMain.kt:86-182`, Go `internal/backuppull` | `BackupPullTest.kt`, Go redirect negative test |
| connector delivery ID store | `${FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE}` | UTF-8、1行1 UUID、append-only。起動時に全量を行単位で走査して末尾100,000件だけをmemoryへ保持。不正UUID/200 bytes超の行はfail-closed。複数runtime共有禁止 | `ConnectorRuntimeMain.kt:460-488`、Go `internal/connector/runtime.go` | `ConnectorRuntimeTest.kt`、Go `protocol_test.go`（永続/並列重複排除/破損行/heap境界） |

Object keyのUUID/token部分は非決定値だが、prefix、segment順、extension、DB参照keyは互換契約である。Go移行だけを理由に既存objectをcopy/renameしない。

retentionは期限切れmetadataの削除（export/backupは`object_key=NULL`）と監査を同じDB transactionでcommitしてから、
Object Storageを削除する。外部削除失敗時は参照のなくなったobjectを残し、grace後にevidence/export/backupそれぞれの
prefixをDB参照と照合して回収する。exportとbackupは同じstorageを使うため、両prefixの包含関係を起動時に拒否する。
export/backup生成でupload後のDB完了結果が不明な場合も即時削除せず、commit済み参照の破壊を避ける。rollback済みobjectは
同じorphan sweepへ収束する。
backup workerは一時ZIPの既知byte数を伴うReaderでObject Storageへstreamし、archive全量をprocess heapへ複製しない。
export downloadもObject Storageの既知sizeをContent-Lengthに固定した直接streamとする。

## 7. 既存品質ゲート

| gate | 実行内容 | SSoT / 実装 | 検出対象・注意 |
|---|---|---|---|
| feedback軽量統合gate | Node >=22/Go 1.26.5 fail-closed、通常`npm ci`、5 packageと3 appのtypecheck/test/build、Go unit/race/vet、contract/package/conformance、Compose config | `scripts/verify-feedback.sh` | JDK/Gradleを使用しない |
| monorepo scope gate | `VERIFY_SCOPE=feedback bash scripts/verify.sh` が上記へ委譲 | `scripts/verify.sh:143-160` | path分類漏れはGo path追加時に更新必須 |
| Feedback integration tier | `VERIFY_INTEGRATION=1 VERIFY_SCOPE=feedback ...`、専用PostgreSQL/S3へGo integrationを実行 | `scripts/verify.sh`、`scripts/verify-feedback-go.sh` | schema/bucket破棄を伴う専用fixtureのみ |
| OpenAPI/routing/policy sync | 42 operation双方向、3 operational route理由付き除外、全resource policy一意 | Go `internal/contract` / `internal/httpapi` test | operation追加/未実装/認可宣言漏れ |
| contract drift/boundary | TS/Go生成差分、Spectral、JSON schema metadata、GIS/Web固有依存・CSP/package boundary、Go codegen再現 | `scripts/check-feedback-contracts.sh`, `scripts/verify-feedback-go.sh` | 42 operation、nullable/未指定を区別する生成設定を固定 |
| package consumer | tarball内容、optional dependency、React 18/19 clean Vite、SemVer stable候補 | `scripts/check-feedback-packages.sh` | backend置換でconsumer変更を要求しないこと |
| conformance static | consumer 2 dependency、Web GIS固有依存、fixture secret混入 | `scripts/check-feedback-conformance.sh` | 実HTTPはstandalone smoke側 |
| clean extraction | allowlist抽出、JDKなしでGo/Frontend verify、Go/admin/broker Docker build、standalone smoke | `scripts/check-feedback-extraction.sh` | repository外cache/生成物依存を検出 |
| standalone smoke | Compose起動、direct/exchange token、consumer flow、capability、evidence/export、retention cleanup | `scripts/smoke-feedback-standalone.sh` | Connector/workerを含むが全42 operationではない |
| CI extraction | Go 1.26.5/Node22、JDKなしclean extraction gate | `.github/workflows/verify.yml` | Feedback scope変更時に実行 |
| CI integration | PostgreSQL 16 + pinned MinIO、Go migration/integration | `.github/workflows/verify.yml` | S3 round tripとmigration convergence |

現行unit test群は permission、validation/range、Problem/OpenAPI schema helper、CSV/XLSX、backup ZIP/pull、cipher/key rotation、Connector HMAC/retry/SSRF境界、migration boundaryを担当する。integration群は standalone DB/HTTP、backup+MinIO+connector、legacy copyを担当する。

Phase 0では、既存Kotlin gateを緑のまま維持しつつ、Go側へ生成drift、`go test ./...`、`go test -race ./...`、V6 convergence、Kotlin/Go differential harnessを追加した。既存gateをGo testの成功だけで置換していない。

## 8. Phase 0時点の証拠不足と解消状況

機能項目そのものは上記分類へ割り当てた。Phase 0で検出した証拠不足と、Go移行統合後の扱いは次のとおりである。

1. 個別HTTP goldenの不足は、42 route/auth境界differential、認証済みHTTP/PostgreSQL統合、全機能domain/DB試験、
   standalone Admin/conformance E2Eを重ねて補った。全42件を1本の巨大goldenへ統合せず、失敗の責務境界ごとに維持する。
2. 隣接component/toolingの未記載24変数は§3.4のとおり解消し、contract gateへ接続した。
3. env decode/default/rangeはGo `internal/config`のrole別table-driven negative testへ移し、secret未設定・不正値をfail-closedにした。
4. metric 13系列は名前、label escape、counter/error/latency増分を直接assertし、Kotlin v1にないHELP/TYPEとhistogram bucketを
   GoのHTTP公開から除外する互換testを追加した。
5. Connector runtimeのliveness、manifest、HTTP配送は別process smokeで固定した。SMTPは`MailSender`差替えunitを正本とし、
   実SMTP serverへの配送は環境依存のためcanary疎通で扱う。
6. legacy migrationを含む10 entrypointを1つのdistroless image内symlinkとして実image検査するよう解消した。
7. ZIP container byte列はcompression/runtime差を許可し、entry名・entry byte列・manifest/checksumを比較正本、archive全体SHAは
   各実装内の整合性確認とする規則で固定した。
8. timestamp/UUID/requestId/claimToken/ZIP生成時刻はbehavior/differentialとarchive testでfieldごとの意味検証または除外を明示した。

## 9. behavior fixture候補とdifferential比較軸

### 9.1 優先fixture

1. **HTTP共通matrix**: 42 operationそれぞれへ最小成功、invalid UUID/query/body、unknown field、未認証401、permission不足403、非member resource 404を付ける。`C`のみまたは`C,I`のoperationから優先する。
2. **JSON/Problem golden**: absent/null/empty collection、timestamp精度、enum、pagination/tie-break、`type/title/status/detail/code/requestId`、`Retry-After`、`ETag/If-Match`、merge-patchを固定する。
3. **認証境界**: direct OIDCとexchangeを分離し、`alg=none`、想定外alg、issuer/audience、期限、未来iat、actor issuer、token scope×DB membershipの積集合を同じtableで流す。
4. **transaction副作用**: session/thread/message/status/membership/connector/retryごとに業務table、audit、change journal、outbox、queue、idempotency recordを正規化snapshot化する。失敗/rollback時の片残りゼロもfixture化する。
5. **並行性**: thread番号、message version、idempotency、tenant/principal/IP rate limit、export/backup/connector claim、lease expiry、同一delivery IDの排他をbarrier付きで再現する。
6. **Object Storage**: Kotlin作成evidence/export/backupをGoで読む逆方向fixture、Range、SHA不一致、put成功後DB失敗、orphan、retention delete retryを固定する。
7. **成果物golden**: export CSV/XLSX、full/incremental backupのentry名とentry byte列、manifest cursor/count/checksum、backup pullのatomic/retry/extra-entry拒否を固定する。
8. **Connector capture**: manifest/health、delivery header、timestamp/HMAC、delivery ID、redacted payload、include-body opt-in、accepted/duplicate、429/timeout/4xx/5xxの分類と試行回数を記録する。
9. **CLI process**: 全entrypointの必須env、不正env終了code、SIGTERM、legacy 4 subcommand、backup pull、bootstrap/register冪等性、`feedback-migrate` lock/checksum/状態遷移をprocess-levelで試す。
10. **operability golden**: readiness dependency matrix、13 metric全行/label/増分、structured logのrequestId/tenant/application/environment/workspace/eventId、30秒以内shutdownを固定する。

### 9.2 比較軸

| 層 | 比較するもの | 正規化を許すもの | 許さない差 |
|---|---|---|---|
| HTTP | status、Content-Type、主要header、JSON field/value、body bytes | UUID、時刻、requestIdをfixture mappingへ置換 | field欠落、null/absent差、順序/pagination差、401/403/404差 |
| DB | 業務row、version/sequence、audit/journal/outbox/queue/idempotency、cursor | surrogate UUIDと時刻を論理IDへ写像 | transaction片残り、sequence非単調、scope越境 |
| Object Storage | key、content type、size、SHA、Range bytes、orphan状態 | claim token/UUIDをmapping | key segment変更、既存object読取不能、checksum差 |
| export/backup | entry集合、entry byte列、manifest、cursor/count/checksum | ZIP metadata/compression、generatedAt | CSV BOM/CRLF/quote/式対策差、entry欠落、cursor差 |
| connector | request headers、署名対象、payload、status分類、attempt数 | timestamp/delivery ID mapping | secret/object key/evidence URL漏洩、重複外部送信 |
| process | exit code、stderr分類、ready、signal時claim停止、再起動収束 | PID/ログ時刻 | secret露出、未検証設定で起動、30秒超過 |
| metric/log | metric名/label/value増分、必須log field | scrape時刻、非契約log message | metric改名、label変更、scope/request correlation欠落 |

## 10. Concurrency / security / rollback invariant

- Kotlin/Goへ同一writeを同一DBで二重実行しない。別DB/Object Storage snapshotまたはworkspace sticky routingを使う。
- worker roleは排他的に所有し、notification/export-backup/retentionの多重claimを意図せず混在させない。
- `FOR UPDATE SKIP LOCKED`、lock順、lease、idempotency、outbox/queue/cursor transaction境界をquery結果比較に含める。
- direct OIDCとexchange JWTを別trust boundaryに保ち、issuer/audience/algorithm/time/scope/membershipをfail-closedで検証する。
- ConnectorのHTTPS/private network/allowlist、HMAC、payload redaction、AES-256-GCM旧鍵rotationを弱めない。
- V6中はKotlin rollback可能。V7、object key、暗号format、wire contractの変更はcanary/観察期間前に行わない。
- rollback時はworkspace routingをKotlinへ戻し、Go worker replicaを0、lease期限/idempotencyを確認後Kotlin workerを再開する。DB rollbackは行わない。

このinventoryの差分が0であることはPhase 6のfeature parity条件の一部であり、rollback/restore証跡とJDK除去を代替しない。
稼働済み環境のin-place移行では、Phase 8の14日/2 full-backup観察も別途必要である。
