# Feedback Platform Go移行・独立化計画

> 状態: 初回導入向け実装完了。2026-08-09にGo採用を明示承認し、Phase 0〜Phase 8のblocking gateを完了した。
> 2026-08-10に、対象は未投入で
> production data/trafficへ影響しないことを確認し、時間経過だけを要求する24時間soakと14日/2 full backup観察を
> 今回の初回導入のblocking gateから外した。Feedback ServiceはGo-onlyをdefaultとし、Kotlin source、Gradle wrapper、
> Kotlin生成契約を正本から撤去した。将来の稼働済み環境のin-place移行には従来の長時間ゲートを適用する。
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

完了とは、Go版が契約、認可、migration、transaction、Object Storage、rollback/restore、releaseのblocking gateを満たし、
Kotlin/JDK/GradleをFeedback Serviceの実行・ビルド要件から除去できた状態を指す。稼働済み環境のin-place移行では、これに
14日間の観察期間と2回以上のフルバックアップ周期を加える。今回の未投入環境では、長時間観察を初回導入後の運用確認へ
移し、releaseをブロックしない。

## 2. 現行v1の基準

### 2.1 SSoT

| 項目 | 基準 |
|---|---|
| HTTP API | `contracts/feedback/openapi.yaml` |
| Connector Protocol | `contracts/feedback/schemas/connector-protocol.schema.json` |
| DB DDL | fresh installは`apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql`。既存V1〜V6 checksum履歴は`apps/feedback-service-go/migrations/flyway-v1-v6/` |
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
4. fresh install向けにはV6収束済みbaselineを生成する。独立抽出物だけが除外する旧consumer移行台帳を除き、
   業務schemaを一致させる。Go版はFlyway履歴がV1のみのfresh baselineとV1〜V6 upgradeを区別し、
   それぞれに固定したschema fingerprintとbaseline marker以外を拒否する。
   CHECK/partial indexのtext-array castは`pg_dump`/`pg_restore`で同値の別表記になるため、column型、演算子、
   値集合を維持したrestore安定表記へ正規化してからfingerprintを計算する。
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

実行結果（2026-08-09）:

- config、pgx pool/transaction、Problem Details、request ID、構造化log、health/readiness/metrics、graceful shutdownを実装した。
- direct OIDC/token exchange、固定permission matrix、issuer/token scope/membership境界、拒否監査のfail-closed経路を実装した。
- application/environment/workspace/principal解決、CORS、Go bootstrap、`/capabilities`、`/me`、manifest、review-contextを実装した。
- PostgreSQL 16.14でDB/HTTP統合試験、Kotlin/Go live differential、Go unit/race/vet/CGO無効build、Kotlin unit/integrationを完走した。
- readinessのDB/Object Storage障害と、JWKS障害時にreadinessを変更せず認証だけをfail-closedにする試験を追加し、
  CIのFeedback統合jobへGo runtime統合試験を接続した。

### Phase 2: Review session、thread、message

実施内容:

- session CRUD、thread作成/取得/status/deep-linkを実装する。
- message投稿/更新/version履歴を実装する。
- audit、change journal、idempotency、rate limit、notification outboxをtransactionへ統合する。

完了ゲート:

- 全HTTP fixtureが一致する。
- 並列thread番号、message version、idempotency、rate limit試験が収束する。
- transaction rollback時にoutbox/change journal/auditの片残りがない。

実行結果（2026-08-09）:

- session CRUD、thread作成/取得/status/deep-link、message投稿/更新/version履歴をGo APIへ実装した。
- idempotency advisory lock、thread連番、message楽観lock、journal/outbox/metricのtransaction境界をPostgreSQL 16の
  並行試験で検証した。既知rollback時の片残りは0件、commit結果不明時は安全側へ分類する。
- W2の全routeを含むKotlin/Go live HTTP fixtureで認証境界、Problem Details、Content-Typeの差分0件を確認し、
  認証済みCRUD列はGo HTTP/PostgreSQL統合試験でstatus/header/JSON/DB副作用を検証した。

### Phase 3: EvidenceとObject Storage

実施内容:

- upload、metadata、quota、SHA-256、Range downloadを実装する。
- filesystem/S3 adapter、delete retry、orphan検出を実装する。

完了ゲート:

- PostgreSQL 16とMinIOを使うintegration testが成功する。
- 不正Range、巨大upload、MIME不一致、path traversal、storage timeoutをfail-closedに処理する。
- 既存Kotlin版が作成したobjectをGo版からdownloadでき、その逆も成立する。

実行結果（2026-08-09）:

- strict Base64、PNG/WebP magic、size/quota/SHA-256 metadata、single Range、storage timeoutを実装した。
- `os.OpenRoot`でlocal traversal/root外symlinkを拒否し、S3はcreate-only Putとprivate Get/List/Deleteを実装した。
- PostgreSQL 16のquota/metadata統合、MinIOのPut/Get/List/Delete、Go→Kotlin→Goの同一bucket固定byte列相互運用を
  専用run IDとbucket guardの下で完走した。
- rollback確定時だけ即時削除し、commit不明objectはgrace付きorphan sweepへ送る回復境界を試験で固定した。

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

実行結果（2026-08-09）:

- CSV/XLSX exportのclaim、生成、private download、stale recovery、期限切れ処理をGo化した。
- full/incremental backup、workspace単一実行、cursor、deterministic ZIP/manifest/checksum、retryとbackup pull CLIをGo化した。
- export/backupはupload後のDB完了結果が不明なときobjectを即時削除せず、attempt固有keyをorphan回収へ委ねる。
- retention policy API、evidence/export/backup expiryをGo化した。期限切れmetadataと監査をDB transactionで先にcommitし、
  Object Storage削除はtransaction外で行う。削除失敗objectはevidence/export/backup別のgrace付きorphan回収へ収束させる。
- PostgreSQL 16とMinIOの専用実体試験で、cursor非更新、object/DB片失敗、checksum/manifest、atomic replacementを検証した。
  retentionは削除失敗を注入し、DB commit後にobjectが残り、次cycleのorphan sweepで回収される境界をrace付きで固定した。
- backup pullはOAuth client secret/Bearer tokenを3xx先へ再送しないようredirectを拒否し、negative testで固定した。
- backup pullのOAuth/list metadataはbyte上限付きの単一JSONだけを受理し、200件超page、空・循環cursor、10,000 page超を
  fail-closedで拒否するnegative testを追加した。
- completed backupのdownload URL/SHA-256/archive bytes欠落を黙ってskipせず、`archiveBytes+1`で一時fileへの書込みを制限して
  HTTP長・実byte数・checksum・manifestをすべて照合する。
- APIからのbackup downloadもDBの`archive_bytes`を必須化し、Object Storage metadataと実読取byte数を`archiveBytes+1`で
  制限・完全一致させてからSHA-256を検証する。
- DBにbyte数を持たないexport downloadはObject Storageの既知sizeをContent-Lengthに固定して直接streamし、short/long bodyを
  検出する。export容量に比例したAPI processのheap確保を行わない。
- backup workerは一時ZIPを`os.ReadFile`でheapへ複製せず、size付きReaderでLocal/S3へstreamする。Readerのshort/long入力と
  partial local file削除をunitで、実MinIO round tripをrace付きで検証した。

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

実行結果（2026-08-09）:

- notification settings/delivery/retry、outbox claim、connector queue/attempt/healthをGo化した。
- Webhook、Teams、Slack、SMTPのreference runtime、manifest register、persistent delivery ID、HMACとsecret rotationを実装した。
  append-onlyのdelivery ID台帳は起動時に行単位で走査して直近100,000件だけをmemoryへ保持し、台帳全体の大きさに
  process heapが比例しないようにした。不正UUIDと200 bytes超の破損行は起動時にfail-closedで拒否する。
- timeout、429、4xx/5xx、duplicate、lease recovery、payload redaction、SSRF/private network既定拒否を単体・実HTTP試験で固定した。
- スタンドアロンE2Eでconnector登録から二段配送、署名検証、delivery履歴までを別processで完走した。

### Phase 6: Administrationと移行CLI

実施内容:

- membership、retention、backup、notification connector/delivery管理APIの残差を完了する。
- Admin UIの既存操作をGo版へ向けたE2Eで検証する。
- legacy migration CLIのdry-run/copy/reconcile/rollbackをGo化する。

完了ゲート:

- 全OpenAPI operationにGo実装があり、未実装responseがない。
- Admin UI、conformance consumer、旧Web GIS copy fixtureがGo版だけで完走する。
- Kotlin版とGo版のfeature inventory差分が0件になる。

実行結果（2026-08-09）:

- membership、retention、backup、notification、connector管理を含むOpenAPI 42 operationを全てGo handlerへ配線した。
- 旧Web GIS snapshotのdry-run/copy/reconcile/rollback CLIをGo化し、本体baselineへ旧consumer台帳を混入させず、
  Kotlin版とbyte一致する専用journal migrationをCLI起動時だけtransaction適用する境界を維持した。空の専用schema作成、
  冪等再実行、Flyway checksum差分・部分適用拒否、apply/reconcile/rollbackをPostgreSQL実体で検証した。
- Admin Console、conformance consumer、token brokerをGo backendへ接続するスタンドアロンE2Eを完走した。
- 42 requestのKotlin/Go live differentialはstatus/header/JSON差分0件となり、feature inventoryの未実装を0件にした。

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

実行結果（2026-08-10）:

- Go 1.26.5の単一静的binaryから10 entrypointを提供するUID/GID 65532のdistroless imageを実装し、
  実測29,482,865 bytesとした。同じ抽出条件のKotlin image 414,373,449 bytesから92.9%削減し、image acceptanceを満たした。
  runtimeにshell/package managerを含めず、CA証明書とtimezone dataの存在を実imageで検証した。
- server用linux/amd64・linux/arm64とCLI/ローカル検証用darwin/arm64・windows/amd64 binary、
  両Linux platformを含むOCI archive、platform別にHIGH/CRITICALでfailするOCI scan SARIFとCycloneDX SBOM、
  release manifest、`SHA256SUMS`を生成し、
  binary formatと全checksumを検査するrelease gateを実装した。
- `assemble-feedback-repository`をGo-onlyのallowlistへ更新し、clean抽出先でGo/Frontend test、
  no-cache image build、Compose、全container standalone smokeをJDKなしで完走した。
- Compose、CI、抽出repositoryをGo-onlyへ切り替え、upgrade/release/canary/rollback/障害対応文書を更新した。
- 同じV6 DB/MinIOを維持してnotification、export、retention、APIをroleごとにGoからKotlinへ排他的に戻し、
  Go API稼働中のKotlin worker処理、Kotlin APIによる既存session読取と新規message書込、notification配送、export生成、
  retention削除が収束するrollback smokeを完走した。
- PostgreSQL custom dumpを隔離DBへ、Evidence/Exportを隔離bucketへrestoreし、Go migratorのschema検証、data-only dump、
  全object path/SHA-256がsourceと一致することを確認した。この演習でrestore前後の同値制約表記を正規化し、
  upgrade/fresh fingerprintをそれぞれ固定した。
- 2026-08-10の局所実測ではGo runtimeのreadiness 407ms、native idle RSS 25,844KiB、SIGTERM停止125ms、
  `go test -count=1 ./...` 4.87秒となり、各絶対基準を満たした。Phase 8ではさらに同一fixture/resource limitで
  Kotlin比RSSと3 endpointのHTTP p95を測定して全て合格した。長時間faultの扱いはPhase 8の初回導入方針に従う。詳細は
  [`docs/feedback-go-completion-audit.md`](docs/feedback-go-completion-audit.md) を参照する。
- pool size 1を占有するPostgreSQL実体試験を追加し、2本目のtransactionが設定timeoutでfail-closedになり、解放後に
  transactionとreadinessが回復することをrace付きで確認した。DB接続枯渇の局所failure injectionは完了した。
- 全worker共通loopはSIGTERM後に新規claimを開始せず、実行中cycleがcontextを無視しても30秒でprocessへ制御を返す
  shutdown上限を持つ。通常cancelとtimeoutの両経路をrace付き単体試験で固定した。
- `assemble-feedback-repository --go-only`を追加し、Kotlin source/生成契約、Gradle wrapper、JDK image参照を含まない
  最終配布形状を生成できるようにした。抽出物のGo migratorは空DBだけへ収束済みV1をtransaction適用し、Flyway V1履歴と
  V6 markerを作る。再実行、同時2 process、部分schema拒否をPostgreSQL実体で確認した。
- `java`を失敗stubへ置き換えたGo-only抽出先で、Go unit/race/vet/codegen、全Node workspace、OpenAPI drift、
  React 18/19実tarball、stable候補、Compose、空DBからの全container smokeを完走した。

### Phase 8: Canary、default切替、Kotlin撤去

事前準備（2026-08-10）:

- 同一read-only fixtureをKotlin/Goへ交互batchで送り、全sample、status、p50/p95/p99、error率と10%基準の合否を
  token非記録のJSONへ出力する`measure-feedback-canary.sh`を追加した。
- 同一source DB/Object StorageからKotlin用・Go用DBをdata-only cloneし、両APIを1 CPU/512MiBに固定して、3 endpointを
  各実装1,000 sample・concurrency 16で測定した。Go p95はsession一覧で29.84%、capabilitiesで53.69%、session詳細で
  32.07%短く、計6,000 requestのerrorは0件だった。RSS peakはKotlin 209,388KiB、Go 34,112KiBだった。
- ローカルgatewayでeast workspaceをGo、westをKotlinへ固定し、各20 writeのaudit増分が20:0で排他的になること、
  eastをKotlinへ戻した後も20:0で逆転することを確認した。
- APIに加えてnotification、export/backup、retention、connectorをrole別に100MiB上限で記録し、APIと3 workerを
  Kotlin同roleの50%以下か比較するcontainer memory JSONゲートをstandalone smokeへ追加した。最終release候補で実測する。
- `soak-feedback-go.sh`を追加した。実PostgreSQLでparallel claim、stale lease回収、idempotency replay、backup cursorを反復し、
  定期的なDB再起動後にも同じfixtureを再実行する。最初の長時間runは31完了反復・1再起動・不変条件異常0の後、
  attempt 32のschema fingerprint走査がstatement timeoutとなったため合格扱いにしなかった。attempt/completed反復と
  failure stageをsummaryへ追加し、2反復・1再起動・異常0の短縮試験後、2026-08-10 09:42 JSTに長時間試験を再開した。
  未投入環境向けのrisk acceptanceを受けて2時間15分、228完了反復、DB再起動11回、不変条件異常0で意図的に終了した。
  harness summaryは要求時間未達のため`failed`を保ち、長時間合格と偽らず、今回の短縮pre-production証跡として扱う。

実施内容:

- APIをworkspace単位のsticky routingでGo canaryへ切り替える。
- worker roleを1種類ずつ排他的にGo版へ切り替える。
- error、latency、queue lag、delivery failure、backup checksum、audit件数を比較する。
- 稼働済み環境のin-place移行では、全trafficをGoへ移して14日間かつ2回以上のfull backup周期を観察する。
- 未投入環境の初回導入では長時間観察をpost-deploy確認へ移し、releaseのblocking gateにしない。
- 完了後にKotlin source、Gradle/JDK image、Kotlin生成契約を削除する。
- Compose、CI、抽出repositoryのdefaultをGo版だけにする。

完了ゲート:

- Sev 1/2障害、データ欠落、互換性逸脱が0件である。
- queue backlog、backup cursor、retention、notification duplicateが基準範囲内である。
- rollback演習とbackup restore演習の証跡がある。
- `VERIFY_SCOPE=feedback` がJDKなしで成功する。
- 未投入環境では短縮fault試験がDB再起動後も異常0であり、長時間試験を省略した判断と生証跡が記録されている。

実行結果（2026-08-10）:

- 2時間15分、228反復、DB再起動11回、lease/cursor/idempotency異常0の短縮fault証跡を保持した。要求時間未達の
  summaryは`failed`のままとし、24時間完走とは扱っていない。
- Go-only抽出物をJDKなしで再構成し、Go unit/race/vet、契約、Frontend/SDK/package、空DB migration、全container smoke、
  role別RSSを完走した。API 8,904,507 bytes、notification 7,421,821 bytes、export/backup 7,376,732 bytes、
  retention 8,528,069 bytesで、全roleが100MiB未満だった。
- Compose、CI、release、抽出のdefaultをGoへ固定し、Kotlin source、Gradle wrapper、Kotlin生成契約を正本から撤去した。
  元一式は初回導入確認中のrecoverable archiveとして`/tmp/feedback-kotlin-retired-20260810`へ退避した。
- 長時間観察、実gateway canary、production backup restoreは初回導入後の非blocking運用確認へ移した。

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
6. 稼働済み環境のin-place移行では、全traffic移行後に14日間の観察ゲートを開始する。
7. 稼働済み環境ではゲート通過後にKotlin版を撤去する。未投入環境の初回導入はblocking gate完了後にGo-only化し、
   長時間観察をpost-deploy確認として行う。

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
| Reliability | 稼働済み環境のin-place移行は24時間fault testで異常0。未投入環境はDB再起動を含む短縮試験で異常0 |
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

- [x] Go採用が明示承認されている。
- [x] 基準commitとfeature inventoryが固定されている。
- [x] 全OpenAPI operationとConnector Protocol v1をGo版が実装している。
- [x] 既存DB/Object Storageを変換せず利用できる。
- [x] V6 handoff、fresh baseline、既存upgradeが履歴別の固定fingerprintへ収束する。
- [x] 全worker、bootstrap、connector、backup pull、legacy migration CLIがGo化されている。
- [x] Kotlin/Go differential testの差分が0件である。
- [x] Admin UI、Frontend SDK、conformance consumerを変更なしまたは後方互換変更だけで利用できる。
- [x] security、failure injection、standalone extraction、performance gateが成功している。
- [x] workspace/APIとworker role単位のローカルrollback演習が成功している。未投入初回導入のproduction replica演習は
  post-deploy確認へ移している。
- [x] 今回が未投入環境の初回導入であることを確認し、14日間/2 full backup観察をpost-deploy確認へ移している。
- [x] Go版default化後にKotlin/JDK/Gradle依存をFeedback Serviceの正本repositoryから撤去している。
- [x] Go-only抽出物のFeedback全ゲートがJDKなしで成功している。
- [x] 運用、upgrade、backup/restore、rollback文書がGo版へ更新されている。
