# Feedback Platform Go移行・独立化計画

> 状態: レビュー用。Go採用を明示的に承認した後に実装を開始する。
> 基準実装: `afe6d04`（フィードバックのバックアップと拡張通知基盤を実装）
> 作成基準日: 2026-08-09

## 関連文書

- 本文書: KotlinからGoへのv1完全互換移行、切替、Kotlin撤去まで
- [`docs/feedback-platform-post-go-roadmap.md`](docs/feedback-platform-post-go-roadmap.md): Go移行完了後の製品化・汎用化ロードマップ
- [`docs/feedback-go-agent-execution-plan.md`](docs/feedback-go-agent-execution-plan.md): 最大4スロットでのサブエージェント並行実装・統合計画
- [`docs/feedback-backup-and-connectors.md`](docs/feedback-backup-and-connectors.md): 現行backup/connectorの実装・運用契約

Go移行の完了前は本文書だけを実装scopeとし、移行後ロードマップのAPI・schema・package変更を混在させない。

## 1. 要約

`apps/feedback-service` のKotlin実装を、公開API、データ、運用インターフェース、失敗時の挙動を維持したGo実装へ置換する。
Go移行中に製品仕様を再設計せず、最初の到達点を **v1完全互換** とする。

採用を承認した場合の決定事項は次のとおり。

- 最終的なBackend実装はGoとし、Kotlin版は互換性確認とロールバックのために一時併存させる。
- `contracts/feedback/openapi.yaml` とConnector Protocol v1を公開契約のSSoTとして維持する。
- PostgreSQLの既存データとV1〜V5のDDL、Object Storage上の既存objectを移行せず、そのまま利用する。
- APIだけでなく、worker、provisioning、connector runtime、backup pull、旧consumer移行CLIまでGo化対象に含める。
- 初期移行ではworker統合、新API、データモデル再設計、Frontend再設計、独立repositoryへの物理移動を行わない。
- 本番相当の並行検証では同じ書込みを二重実行しない。Kotlin版とGo版を別DBへ同一入力で実行するか、workspace単位で排他的に振り分ける。
- Kotlinへ即時ロールバックできる期間は、Kotlinが解釈できないGo専用DDLを適用しない。

完了とは、Go版が全互換ゲートを満たし、14日間の観察期間と2回以上のフルバックアップ周期を問題なく通過し、
Kotlin/JDK/GradleをFeedback Serviceの実行・ビルド要件から除去できた状態を指す。

## 2. 現行v1の基準

### 2.1 SSoT

| 項目 | 基準 |
|---|---|
| HTTP API | `contracts/feedback/openapi.yaml` |
| Connector Protocol | `contracts/feedback/schemas/connector-protocol.schema.json` |
| DB DDL | `apps/feedback-service/src/main/resources/db/migration/V*.sql` |
| 環境変数 | `docs/environment-variables.md` |
| 運用挙動 | `docs/feedback-service.md`、`docs/feedback-operations-guide.md` |
| 独立配布形状 | `scripts/assemble-feedback-repository` と `feedback-repository/` |
| 基準コード | Git commit `afe6d04` |

Go移行中にSSoT間の不一致を発見した場合、Kotlinコードを暗黙の正解として写経しない。
OpenAPI、統合テスト、運用文書、Kotlin実挙動を比較し、契約修正または互換テスト追加を先に行う。

### 2.2 維持する機能

HTTP APIは `/feedback/v1` 配下の現行resourceをすべて維持する。

- capability、現在ユーザー、application manifest、review context
- review sessionの一覧・作成・取得・更新
- threadの作成・取得、deep link、status変更
- messageの投稿・更新・version履歴
- evidenceのupload/download、Range応答、quota、checksum
- exportの作成・状態取得・download
- 自動backup policy、full/incremental run、download、retry
- retention policy
- 従来notification settingの互換API
- connector type、notification connectorのCRUD
- notification deliveryの参照・retry
- workspace membershipの管理

非HTTP機能も互換対象とする。

- OIDC Bearer JWTとtoken exchange JWTの検証
- `feedback.read`、`feedback.comment`、`feedback.manage`、`feedback.admin` の認可
- tenant/application/environment/workspace境界と非メンバーへの404
- mutate成功および401/403の監査、before/after変更記録
- tenant/principal/IP単位rate limitとevidence quota
- notification outbox、connector delivery queue、lease、retry、dead-letter相当状態
- AES-256-GCMによるsecret暗号化と旧鍵からのrotation
- HMAC署名、timestamp、delivery ID、重複排除
- full/incremental backup、CSV/ZIP/manifest/checksum/cursor
- export/evidence/backupのretentionとorphan cleanup
- PostgreSQLとS3互換Object Storageのreadiness
- Prometheus metrics、structured log、request/correlation ID

### 2.3 維持するプロセスとCLI

既存の実行名はdeployment contractとして維持する。Go版は単一の静的バイナリとし、subcommandまたはsymlinkで
次のentrypointを提供する。

| 既存entrypoint | Go版の責務 |
|---|---|
| `feedback-service` | HTTP API |
| `feedback-notification-worker` | outboxとconnector配送 |
| `feedback-export-worker` | exportと自動backup |
| `feedback-retention-worker` | retentionとorphan cleanup |
| `feedback-bootstrap` | tenant/application/workspace/membershipの冪等登録 |
| `feedback-connector-register` | connector manifest登録 |
| `feedback-connector-runtime` | Webhook、Teams、Slack、SMTP参照connector |
| `feedback-backup-pull` | OAuth client credentialsによる共有サーバ搬送 |
| `feedback-legacy-migration` | 旧Web GISデータのdry-run/copy/reconcile/rollback |
| `feedback-migrate`（追加） | Flyway handoff後のone-shot schema migration |

初期互換期間はプロセスを統合しない。負荷と障害分離を観測した後のworker統合は別変更として扱う。

## 3. 移行範囲と非対象

### 3.1 Go移行に含めるもの

- HTTP routing、DTO、validation、Problem Details、CORS
- OIDC/JWKS、token exchange、permission判定
- PostgreSQL query、transaction、locking、idempotency、audit
- S3互換storage clientとfilesystem local adapter
- evidence、export、backup、retention
- notification、connector protocol、SMTP/Webhook/Teams/Slack
- health、readiness、metrics、structured logging
- すべてのworker、bootstrap、backup pull、legacy migration CLI
- OCI image、Compose、CI、独立repository抽出処理、運用文書
- OpenAPIから生成するGo DTO/handler interfaceとdrift check

### 3.2 v1完全互換まで実施しないもの

次の内容は有用だが、Go移行と同時には行わない。

- `/feedback` や `/review-scopes` などへのresource再編
- Stable Anchor、Review Dimension、Review Scopeの新しいwire model
- Web Component追加やReact binding再設計
- Host Adapterの新規公開契約
- 独立した `feedback-sidecar` の新設
- notification/export/retention workerの統合
- queue製品、ORM、DI framework、service meshの導入
- `gis-example` から独立repositoryへの物理移転

これらはGo版をdefaultにした後、OpenAPIの後方互換ルールに従う別ロードマップとして扱う。

## 4. Go実装の技術方針

### 4.1 Runtime topology

v1移行では現在の責務分離を維持し、独立したSidecar製品は追加しない。

```text
Frontend SDK / Admin UI
          │ /feedback/v1
          ▼
feedback-service (Go) ───── OIDC / token exchange
          │
          ├──────── PostgreSQL
          └──────── S3-compatible Object Storage
                         ▲
                         │
notification / export-backup / retention workers (Go)
          │
          └──────── connector runtime (Go) ── Webhook / Teams / Slack / SMTP
```

Go版 `feedback-service` は中央配置にもapplication隣接配置にも対応するが、どちらも同じHTTP契約と認証境界を使う。
API transaction内では外部通知を行わず、outbox/queueを介してworkerへ渡す。

### 4.2 Toolchainと配布

- 実装開始時点の安定版であるGo 1.26.5を `go.mod`、CI、Docker build imageで固定する。
- `CGO_ENABLED=0` のLinux amd64/arm64静的バイナリを生成する。
- runtime imageはnon-rootのdistroless系を使用し、CA証明書とtimezone dataだけを含める。
- 1つの `feedback` バイナリへsubcommandを実装し、既存entrypoint名のsymlinkをimageへ配置する。
- Windows amd64、macOS arm64のbinaryはCLIとローカル検証用に配布し、serverの本番保証対象はLinuxとする。
- module、generator、toolのversionはすべて `go.mod` / `go.sum` とtool定義へ固定する。

Go 1.27は基準日時点で未リリースのため採用しない。Goのminor security releaseは通常の依存更新PRで追随する。

### 4.3 Repository layout

Go版は並行検証のため、Kotlin版を上書きせず `apps/feedback-service-go` に追加する。

```text
apps/feedback-service-go/
├ go.mod
├ cmd/feedback/
├ internal/
│  ├ contract/       # OpenAPI生成物。手編集禁止
│  ├ httpapi/        # routing、decode/encode、middleware
│  ├ auth/           # OIDC、token exchange、permission
│  ├ usecase/        # transaction単位のapplication logic
│  ├ postgres/       # queryとrow mapping
│  ├ objectstore/    # S3/filesystem
│  ├ jobs/           # claim、lease、retry
│  ├ connector/      # Connector Protocol runtime/client
│  ├ migration/      # Go migration handoff後のrunner
│  ├ observability/  # log、metrics、health
│  └ config/         # 環境変数decode/validation
├ migrations/
├ tests/
└ Dockerfile
```

依存方向は `httpapi/jobs -> usecase -> interface <- postgres/objectstore` とする。
HTTP handlerへSQLを書かず、PostgreSQL固有の処理をdomain modelへ漏らさない。一方で、抽象化のためだけのrepository層や
巨大なinterfaceを作らず、transactionとqueryの境界に必要な最小interfaceだけを置く。

### 4.4 Library方針

- HTTPは標準 `net/http` を中心とし、OpenAPIからGo DTOとhandler interfaceを生成する。
- OpenAPI generatorは `oapi-codegen/v2` を固定versionで使用し、生成物をcommitする。
- PostgreSQLは `pgx/v5` と `pgxpool`、値はbind parameter、動的識別子は既存allowlist相当を必須とする。
- ORMとSQL自動生成は採用せず、既存SQLの意味を監査できるhand-written queryを使用する。
- S3はAWS SDK for Go v2を使用し、AWS S3とMinIOで同じintegration suiteを通す。
- JWT/JWKSは `lestrrat-go/jwx/v3` を使用し、issuer、audience、algorithm、time claimを明示検証する。
- JSONはunknown field拒否、null/未指定の区別、timestamp/UUID validationを共通decoderで統一する。
- loggingは `log/slog`、traceはOpenTelemetry、metricsはPrometheus clientを使用する。
- dependency injection frameworkは使わず、`main` で明示的に依存を組み立てる。

### 4.5 Configuration

- 既存の `FEEDBACK_*` 環境変数名、必須/任意、default、範囲検証を維持する。
- secretをfileやcommand line argumentから読まず、環境変数または実行基盤のsecret injectionを使用する。
- secretに開発用fallbackを設けない。
- 未知の環境変数は無視するが、既知変数の不正値は起動失敗とする。
- Go固有設定を追加する場合も `docs/environment-variables.md` とCompose/CIを同じ変更で更新する。

## 5. 互換性契約

### 5.1 HTTPとJSON

Go版は次をKotlin版と一致させる。

- path、method、query、header、request body、response body
- status code、Problem Detailsの `type/title/status/detail/code/requestId`
- Content-Type、Range、Content-Range、Retry-After、download filename
- absent/null/empty collection、enum文字列、日時精度、UUID表現
- pagination順序、default limit、同値時のtie-break order
- 401/403/404による情報隠蔽
- idempotency keyとrequest IDの引継ぎ
- `application/merge-patch+json` の部分更新意味論

OpenAPIに表現できない挙動は `contracts/feedback/behavior/` の機械可読fixtureとして追加し、Kotlin版とGo版へ同じ試験を適用する。

### 5.2 AuthenticationとAuthorization

- direct OIDCとtoken exchangeを別trust boundaryとして維持する。
- JWKS cache/refresh失敗時に未検証tokenを許可しない。
- `alg=none`、想定外algorithm、issuer/audience不一致、期限切れ、未来のiatを拒否する。
- token permission、DB membership、tenant/application/environment/workspace claimをすべて満たす場合だけ許可する。
- permission matrixは純粋関数として実装し、Kotlinの全期待表を同じtable-driven testへ移す。
- 認証拒否と認可拒否の監査記録を成功応答より先に失わない。

### 5.3 Databaseと並行処理

- Go版は既存 `feedback` schemaを直接利用し、移植目的のtable/column変更を行わない。
- transaction isolation、lock順序、`FOR UPDATE SKIP LOCKED`、advisory lock、lease期限をKotlin版と一致させる。
- thread番号、message version、change sequence、audit sequenceの単調性を維持する。
- outboxと業務更新、connector queueとthread更新、backup cursorと成功runを同一transaction境界で扱う。
- DB transaction中に外部HTTPやObject Storageの長時間I/Oを行わない。
- process停止、timeout、commit結果不明の場合もat-least-onceとidempotencyで収束させる。

### 5.4 Object Storageと成果物

- 既存object keyを読めることを必須とし、Go移行だけを理由にobjectをcopy/renameしない。
- evidenceのSHA-256、Content-Type、size、Range downloadを維持する。
- export/backup ZIPのentry名、UTF-8 BOM、CRLF、RFC 4180 quoting、CSV formula対策を維持する。
- backup manifestのversion、件数、cursor、history coverage、entry checksumを一致させる。
- upload成功後にDB commitが失敗したobjectをorphanとして回収する。
- download CLIは同一directory内temp fileとatomic renameを使い、path traversalとroot出力を拒否する。

### 5.5 NotificationとConnector Protocol

- Connector Protocol v1のmanifest、health、delivery、result schemaを変更しない。
- delivery bodyへtoken、evidence URL、object key、未知fieldを含めない。
- 本文送信はconnector単位の明示opt-inを維持する。
- timestamp/HMAC、request size、HTTPS/private network/allowlist規則を維持する。
- accepted/duplicate、retryable/permanent failure、429/timeoutの分類を一致させる。
- persistent delivery IDと並列重複実行の排他を維持する。
- legacy notification settingは互換adapterとしてGo版でも1 release以上維持する。

### 5.6 運用インターフェース

- `/health/live`、`/health/ready`、`/metrics` のpathと意味を維持する。
- readinessはdatabase/evidence/exportを必須、notification状態をdegradedな任意依存として区別する。
- 主要metric名、label、counter増分条件を維持し、移行期間中にdashboardを二重管理しない。
- structured logのrequestId、tenant、application、environment、workspace、eventIdを維持する。
- SIGTERMで新規claimを停止し、処理中request/jobを最大30秒でgraceful shutdownする。

## 6. Migration ownershipの引継ぎ

Flywayのversion履歴を別libraryへ暗黙変換しない。次のhandoffを1回だけ実施する。

1. Kotlin互換releaseへ `V6__go_migration_handoff.sql` を追加する。
2. V6はGo migrator用version tableとbaseline markerを作成するだけとし、既存業務tableを変更しない。
3. 既存環境ではKotlin/FlywayがV6を適用し、V1〜V6がsuccessであることとschema fingerprintをGo版が検証する。
4. fresh install向けにはV6収束済みbaselineを生成し、同じschema fingerprintとbaseline markerを作る。
5. Go版default化までは新しい業務DDLを追加しない。
6. Go版default化後の新規migrationはV7から開始し、Go migratorだけがversion tableを更新する。
7. `feedback.flyway_schema_history` は監査証跡として保持し、編集・削除しない。

Go migratorはPostgreSQL advisory lockで単一起動を保証し、migrationごとにtransaction、SHA-256、開始/完了状態を記録する。
本番ではone-shot `feedback-migrate` を先に実行する。現行の起動時migration互換のため、API起動時にも未適用確認を行うが、
本番で未適用migrationを検出した場合はfail-closedとする。ローカルComposeだけは明示設定により自動適用を許可する。

Kotlinへ戻せる期間はV6 schemaのまま運用する。V7適用をKotlin撤去後に限定することで、rollback境界を明確にする。

## 7. 実装フェーズ

各phaseは独立した統合コミットまたはPRとする。Phase 0とPhase 1、Phase 7以降は直列ゲートとする。
Phase 2〜6は、依存する共通interfaceが固定済みであれば並行実装できるが、統合とrelease候補への昇格は依存DAG順とし、
未通過の先行ゲートを飛び越えない。具体的なagent配置、path ownership、統合手順は
[`docs/feedback-go-agent-execution-plan.md`](docs/feedback-go-agent-execution-plan.md) に従う。

### Phase 0: Contract freezeと比較基盤

実施内容:

- 基準commit、OpenAPI、Connector schema、V1〜V5 checksumを固定する。
- 全endpoint・worker・CLI・環境変数・metric・成果物formatのinventoryを生成する。
- OpenAPI生成Go型と未実装handlerを追加する。
- Kotlin/Goへ同一fixtureを流すdifferential test harnessを作る。
- V6 handoff migrationとclean baseline収束テストを追加する。

完了ゲート:

- inventoryに未分類項目がない。
- OpenAPI全operationが生成interfaceへ対応し、未登録routeをCIが検出する。
- Kotlin版の既存単体・統合・standalone smokeが引き続き成功する。

### Phase 1: Runtime foundation

実施内容:

- config、DB pool、transaction helper、Problem Details、request ID、structured logを実装する。
- health/readiness/metrics、graceful shutdownを実装する。
- direct OIDC、token exchange、permission matrix、audit denialを実装する。
- application/environment/workspace/principal解決とCORSを実装する。
- bootstrapをGo化する。

完了ゲート:

- `/capabilities`、`/me`、manifest、review-contextがKotlin版と一致する。
- invalid JWT、issuer/audience、permission、membership境界のnegative testが一致する。
- PostgreSQL停止、JWKS障害、Object Storage障害のreadinessが一致する。

### Phase 2: Review session、thread、message

実施内容:

- session CRUD、thread作成/取得/status/deep-linkを実装する。
- message投稿/更新/version履歴を実装する。
- audit、change journal、idempotency、rate limit、notification outboxをtransactionへ統合する。

完了ゲート:

- 全HTTP fixtureが一致する。
- 並列thread番号、message version、idempotency、rate limit試験が収束する。
- transaction rollback時にoutbox/change journal/auditの片残りがない。

### Phase 3: EvidenceとObject Storage

実施内容:

- upload、metadata、quota、SHA-256、Range downloadを実装する。
- filesystem/S3 adapter、delete retry、orphan検出を実装する。

完了ゲート:

- PostgreSQL 16とMinIOを使うintegration testが成功する。
- 不正Range、巨大upload、MIME不一致、path traversal、storage timeoutをfail-closedに処理する。
- 既存Kotlin版が作成したobjectをGo版からdownloadでき、その逆も成立する。

### Phase 4: Export、Backup、Retention

実施内容:

- export claim/build/downloadをGo化する。
- full/incremental backup scheduler、cursor、ZIP/manifest、retryをGo化する。
- retention policy、expiry、orphan cleanupをGo化する。
- backup pull CLIをGo化する。

完了ゲート:

- Kotlin/Goが同じfixture DBから生成したCSV内容とmanifestを比較し、許可した非決定値以外が一致する。
- full優先、同一workspace単一実行、失敗時cursor不更新、object/DB片失敗を検証する。
- download CLIのchecksum、atomic replacement、再実行、破損archive拒否を検証する。

### Phase 5: NotificationとConnector

実施内容:

- notification administration、outbox claim、delivery履歴、retryをGo化する。
- connector installation/health/queue/attemptをGo化する。
- Webhook、Teams、Slack、SMTPのreference runtimeとregister CLIをGo化する。
- legacy webhook compatibilityとencryption key rotationを維持する。

完了ゲート:

- Connector Protocol schema testと別process smokeが成功する。
- timeout、429、4xx、5xx、duplicate、process crash、secret rotationを検証する。
- 通知payloadへ禁止情報が含まれないことをschemaとnegative testで保証する。

### Phase 6: Administrationと移行CLI

実施内容:

- membership、retention、backup、notification connector/delivery管理APIの残差を完了する。
- Admin UIの既存操作をGo版へ向けたE2Eで検証する。
- legacy migration CLIのdry-run/copy/reconcile/rollbackをGo化する。

完了ゲート:

- 全OpenAPI operationにGo実装があり、未実装responseがない。
- Admin UI、conformance consumer、旧Web GIS copy fixtureがGo版だけで完走する。
- Kotlin版とGo版のfeature inventory差分が0件になる。

### Phase 7: Packagingと独立抽出

実施内容:

- Go OCI image、multi-arch binary、SBOM、署名対象artifactを生成する。
- Composeのdefault backendを切替可能なprofileにする。
- `assemble-feedback-repository` をGo版も含むallowlistへ更新する。
- clean抽出先でGo test、Frontend test、Docker build、standalone smokeを完走させる。
- 環境変数、upgrade、rollback、障害対応runbookをGo版へ更新する。

完了ゲート:

- repository外のcacheや生成物なしで抽出ゲートが成功する。
- Kotlin版とGo版の両方を明示的に選択でき、default切替前のrollback演習が成功する。
- image、binary、SBOMのchecksumをrelease artifactとして出力できる。

### Phase 8: Canary、default切替、Kotlin撤去

実施内容:

- APIをworkspace単位のsticky routingでGo canaryへ切り替える。
- worker roleを1種類ずつ排他的にGo版へ切り替える。
- error、latency、queue lag、delivery failure、backup checksum、audit件数を比較する。
- 全trafficをGoへ移し、14日間かつ2回以上のfull backup周期を観察する。
- 完了後にKotlin source、Gradle/JDK image、Kotlin生成契約を削除する。
- Compose、CI、抽出repositoryのdefaultをGo版だけにする。

完了ゲート:

- Sev 1/2障害、データ欠落、互換性逸脱が0件である。
- queue backlog、backup cursor、retention、notification duplicateが基準範囲内である。
- rollback演習とbackup restore演習の証跡がある。
- `VERIFY_SCOPE=feedback` がJDKなしで成功する。

## 8. Test strategy

### 8.1 Unit

- permission matrix、scope解決、validation、Problem mapping
- SQL predicate/identifier、row mapping、transaction error classification
- encryption、HMAC、key rotation、secret masking
- CSV、ZIP、manifest、checksum、path guard、atomic rename
- retry/backoff、lease、cursor、retention期限計算
- Connector Protocol decode/encode、payload redaction

`go test ./...` と `go test -race ./...` をCI必須とする。parser、validator、path、CSV、connector payloadには
Go fuzz testを追加し、発見したcrash inputをcorpusへ固定する。

### 8.2 Contract differential

Kotlin版とGo版を別の同一snapshot DB/Object Storageで起動し、同じrequest列を実行する。

- response status/header/JSONを比較する。
- UUID、時刻、request IDは意味を検証し、fixtureで固定できる値は固定する。
- DBの業務table、audit、journal、outbox、queueの結果を正規化して比較する。
- ZIPはentry単位で展開し、manifest/checksumとCSV byte列を比較する。
- external notificationはcapture serverでheader、署名、payload、再試行回数を比較する。

OpenAPI schema適合だけで合格にせず、順序、null、監査副作用、失敗時副作用まで比較する。

### 8.3 Integration and failure injection

- PostgreSQL 16 clean migration、既存V5 upgrade、V6 handoff、schema convergence
- MinIOによるevidence/export/backup round trip
- concurrent create/update/claim、worker crash、lease expiry、commit結果不明
- JWKS rotation/timeout、Object Storage timeout、connector timeout/429/4xx/5xx
- DB接続枯渇、graceful shutdown、再起動後のidempotent recovery
- Admin UIとconformance consumerの実HTTP response検証

統合テストは専用DB schema/bucketを破棄するため、接続先guardを維持し、開発・本番接続先では起動拒否する。

### 8.4 Security and supply chain

- `go vet`、`staticcheck`、`govulncheck`
- secret scan、Trivy、CycloneDX SBOM
- non-root/read-only filesystem、capability drop、egress制限
- JWT algorithm confusion、SSRF、CSV injection、ZIP slip、path traversal、oversized body
- tenant/application/workspace越境のtable-driven negative test

## 9. RolloutとRollback

### 9.1 禁止する切替方式

- 同一requestをKotlin版とGo版から同じDBへ二重書込みしない。
- 同じworker roleを両実装で無制御に同時稼働させない。
- Go版だけが理解するV7以降のDDLを観察期間前に適用しない。
- object keyや暗号形式を切替と同時に変更しない。

### 9.2 切替順序

1. V6 handoffをKotlin/Flywayで適用し、DB/Object Storage backupを取得する。
2. Go APIをread-only smokeへ接続する。
3. 限定workspaceをGo APIへsticky routingし、1workspaceずつ拡大する。
4. notification、export/backup、retentionの順にworker ownershipをGoへ切り替える。
5. bootstrap、connector runtime、運用CLIをGo版へ切り替える。
6. 全traffic移行後、14日間の観察ゲートを開始する。
7. ゲート通過後にKotlin版を撤去し、その後に限りV7以降を許可する。

### 9.3 Rollback条件と操作

次のいずれかで即時rollbackする。

- 認可越境、監査欠落、データ欠落、backup検証失敗
- error rateまたはp95 latencyが基準を継続超過
- queue lagがlease/retry設計で回復しない
- Kotlin版との契約差分がconsumerへ影響する

rollbackは対象workspaceのroutingをKotlinへ戻し、対象worker roleのGo replicaを0、Kotlin replicaを1以上にする。
V6はKotlin互換なのでDB rollbackは行わない。処理中leaseの期限とidempotency keyを確認してからworkerを再開する。

## 10. 非機能acceptance criteria

同じarm64/amd64 CI runner、同じPostgreSQL/MinIO、同じfixtureを使って測定する。

| 指標 | 合格条件 |
|---|---|
| Runtime image | uncompressed 100MB以下、Kotlin版より70%以上削減 |
| Idle RSS | 各server/worker 100MiB以下、Kotlin版より50%以上削減 |
| 起動 | 依存先readyかつmigrationなしで2秒以内にreadiness成功 |
| Build | warm module cacheで `go test ./...` が15秒以内 |
| HTTP performance | 同一resource limitでp95がKotlin版より10%以上悪化しない |
| Reliability | 24時間fault testで未回収lease、cursor欠落、重複確定処理が0件 |
| Shutdown | SIGTERM後30秒以内に安全停止し、新規claimを行わない |

性能目標のためにAPI意味論、監査、暗号、validationを省略してはならない。未達時はprofiling結果を記録し、
目標の見直しではなく原因修正を先に行う。

## 11. 主なriskとcontrol

| Risk | Control |
|---|---|
| Go移行に新仕様が混入する | v1 freeze、非対象の明記、OpenAPI/behavior fixture差分を別PRにする |
| JSONのnull/順序/default差 | generated DTO、golden response、differential test |
| transaction/lock差による重複や欠落 | 同一SQL意味論、concurrency test、fault injection、DB結果比較 |
| Flyway履歴を壊す | V6 handoff、V1〜V6不変、Flyway table read-only |
| Object Storageの片失敗 | idempotency、orphan cleanup、failure injection |
| JWT library差による認証緩和 | algorithm/issuer/audience/timeのnegative test、fail-closed |
| workerの二重実行 | role単位ownership、replica切替runbook、queue metric監視 |
| rollback不能 | V7凍結、workspace sticky routing、Kotlin image保持 |
| 独立抽出物だけ壊れる | clean directory build、Docker build、standalone smokeをCI必須化 |

## 12. Go版default化後のロードマップ

詳細は [`docs/feedback-platform-post-go-roadmap.md`](docs/feedback-platform-post-go-roadmap.md) をSSoTとする。
Go版default化後は次の順序で進める。

| Wave | 到達点 | 前提 |
|---|---|---|
| R0 | Go版v1の安定化とGA判定 | 本文書のPhase 8完了 |
| R1 | 独立repository・配布・upgrade経路の正本化 | R0 |
| R2 | 既存Host Adapter/SDKの1.0安定化とtesting kit | R0 |
| R3 | Target v2とanchor aliasによる追跡性向上 | R2 |
| R4 | Web Componentとframework binding共通化 | R2 |
| R5 | Review session/scope/perspectiveの再利用・運用高度化 | R1、R2 |
| R6 | 任意のGo Sidecarと企業認証profile | R1 |
| R7 | Connector/Adapter ecosystemとconformance公開 | R1、R2 |
| R8 | 閉域・公共部門向け配布、証跡搬送、DR運用の完成 | R1、R5〜R7 |
| R9 | 実測に基づくworker/scaling topology最適化 | Go GA後30日以上の本番相当運用データ |

各Waveは独立してrelease可能とし、未完了Waveを理由に既存v1機能を不安定化させない。
Go移行と製品再設計を分離すること自体を、本計画の重要なrisk controlとする。

## 13. 最終完了チェックリスト

- [ ] Go採用が明示承認されている。
- [ ] 基準commitとfeature inventoryが固定されている。
- [ ] 全OpenAPI operationとConnector Protocol v1をGo版が実装している。
- [ ] 既存DB/Object Storageを変換せず利用できる。
- [ ] V6 handoff、fresh baseline、既存upgradeが収束する。
- [ ] 全worker、bootstrap、connector、backup pull、legacy migration CLIがGo化されている。
- [ ] Kotlin/Go differential testの差分が0件である。
- [ ] Admin UI、Frontend SDK、conformance consumerを変更なしまたは後方互換変更だけで利用できる。
- [ ] security、failure injection、standalone extraction、performance gateが成功している。
- [ ] workspace/APIとworker role単位のrollback演習が成功している。
- [ ] 14日間かつ2回以上のfull backup観察ゲートを通過している。
- [ ] Go版default化後にKotlin/JDK/Gradle依存を撤去している。
- [ ] `VERIFY_SCOPE=feedback` がJDKなしで成功している。
- [ ] 運用、upgrade、backup/restore、rollback文書がGo版へ更新されている。
