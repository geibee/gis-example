# Feedback Platform サブエージェント並行実行計画

> 対象: Go v1完全互換移行とGo移行後ロードマップ
> 実行モデル: 統合担当の親エージェント1 + 実装サブエージェント最大3
> 前提文書: [`../feedback-platform-improvement-plan.md`](../feedback-platform-improvement-plan.md)、
> [`feedback-platform-post-go-roadmap.md`](feedback-platform-post-go-roadmap.md)
> 実行時更新: 2026-08-10に対象が未投入であることを確認し、24時間/14日/2 full backupの時間経過gateは今回の
> release blockingから除外した。本書の元のgate定義は稼働済み環境のin-place移行向けとして残す。

## 1. 目的

契約、migration、transaction、生成物を壊さずに実装速度を上げる。
単純にタスク数を3分割するのではなく、依存interfaceを先に固定し、競合しないpathと独立した完了条件を持つ作業だけを並行する。

この文書は、実装開始後に親エージェントがサブエージェントを起動することを必須とする。
ただし、共有契約が未確定の作業、production切替、破壊的変更を無理に並行化しない。

## 2. 基本ルール

### 2.1 Slot allocation

- 最大4スロットを、親1 + 子3として使用する。
- 親は契約、共通interface、integration、最終判断を所有し、自身も統合作業を進める。
- 子は1 turnで完了条件を判定できる、具体的でboundedなsubtaskだけを担当する。
- 子による孫エージェント起動は禁止し、slot配分は親へ一元化する。
- 完了した子は同じlaneの次taskへ再利用し、毎回新規agentを増やさない。
- 依存待ちの子を放置せず、親は独立taskへ切り替えるか一度終了させる。

### 2.2 直列化する作業

次は親だけが実行し、同時編集しない。

- OpenAPI、JSON Schema、Connector Protocol、behavior fixtureの公開契約変更
- DB migration、schema fingerprint、baseline生成
- `go.mod`、`go.sum`、generator/tool version
- generated Go/TypeScript型の更新
- composition root、command registry、共通port/interface
- `deploy/compose.yaml`、CI workflow、検証scriptの最終統合
- 環境変数SSoT、release/version metadata
- production routing、replica、migration適用、Kotlin削除
- 全体formatter、`go mod tidy`、full extraction、standalone smoke

### 2.3 並行化する条件

次をすべて満たすtaskだけをspawnする。

1. 入力となるcontract/interfaceが親によってcommitまたは固定されている。
2. 編集可能pathが他agentと重ならない。
3. 単独で実行できる局所testがある。
4. 完了時の期待成果物が列挙できる。
5. 未完成でも本番route/workerへ登録されない。
6. 他agentへ暗黙のschema/config変更を要求しない。

## 3. Ownershipと競合回避

### 3.1 親エージェントの専有path

- `contracts/feedback/**`
- `apps/feedback-service-go/go.mod`、`go.sum`
- `apps/feedback-service-go/cmd/**`
- `apps/feedback-service-go/internal/contract/**`
- `apps/feedback-service-go/internal/ports/**` または共通interface相当
- `apps/feedback-service-go/migrations/**`
- `.github/workflows/**`
- `scripts/verify*.sh`、`scripts/assemble-feedback-repository`
- `deploy/compose.yaml`、root Compose
- `docs/environment-variables.md` と計画文書
- Kotlin sourceの削除

子がこれらの変更を必要とする場合、直接編集せず親へ次を通知する。

- 必要なsignature/schema/config
- 変更理由
- 呼出し側の想定
- 後方互換への影響
- 代替案

親がbarrier中に反映し、全agentへ固定版を通知する。

### 3.2 子エージェントのpath ownership

子にはfeature packageと同packageのtestだけを割り当てる。

```text
Agent A: internal/auth、internal/httpapi/<assigned-feature>、internal/usecase/<assigned-feature>
Agent B: internal/postgres/<assigned-feature>、internal/objectstore/<assigned-feature>
Agent C: internal/jobs/<assigned-feature>、internal/connector/<assigned-feature>
```

Waveごとに割当を変更できるが、同じWave内で1つのfileを複数agentへ割り当てない。
共有helperが必要な場合は、子が局所private helperで検証し、親が統合時に共通化を判断する。

### 3.3 Git operation

- 子は `git add`、`git commit`、`git reset`、`git checkout`、`git rebase` を実行しない。
- 子は割当path外の既存変更を戻さない。
- 親だけがdiffを監査し、Wave単位でcommitする。
- 広域formatterを禁止し、子は割当Go packageだけを `gofmt` する。
- userの既存変更と重なる場合は親へ即時通知し、勝手に解消しない。

共有worktreeでpath ownershipを守れないtoolingを使う場合だけ、親がagentごとの一時git worktreeを作り、
統合時にcommit単位で取り込む。既定は共有worktree + 排他的path ownershipとする。

## 4. Go移行の依存DAG

```text
G0 Contract freeze / scaffold / V6 handoff
 └─ G1 Runtime・認証・DB・HTTP基盤
     ├─ G2a Identity / Session
     ├─ G2b Thread / Message / Outbox
     └─ G2c Evidence / Object Storage
          │
          ├─ G3a Export / Backup / Pull
          ├─ G3b Notification / Connector
          └─ G3c Membership / Admin / Legacy migration
               │
               ▼
      G4 Retention / 全差分試験 / Packaging
               │
               ▼
      G5 Canary準備 / rollback / performance
               │
               ▼
      G6 Canary / 14日・2 full backup観察
               │
               ▼
      G7 Kotlin撤去 / Go-only gate
```

G0/G1はhard barrier、G2/G3/G4はinterface固定後に並行可能、G5以降は直列とする。

## 5. Go移行Waveのagent配置

### W0: Contractとscaffold

| Role | Task |
|---|---|
| 親 | Go module、共通port、generator、V6、CI入口を確定 |
| Agent A | 全機能inventory、behavior fixture、differential harness |
| Agent B | OpenAPI generator検証、operation/route coverage検査。生成実行は親へ引継ぐ |
| Agent C | schema fingerprint、V5→V6、fresh baseline試験。migration本体は親へ提案する |

完了条件:

- Kotlin基準ゲートが維持される。
- OpenAPI operation、process、環境変数、metric、artifactに未分類がない。
- 生成物とmigrationの変更を親だけが統合している。

W0の子は調査・test harnessを主とし、業務実装へ着手しない。

### W1: Runtime foundation

| Role | Task |
|---|---|
| 親 | `main` wiring、依存version、共通interface統合 |
| Agent A | config、OIDC、token exchange、permission matrix |
| Agent B | pgx pool、transaction、claim/lease基盤、bootstrap primitive |
| Agent C | HTTP middleware、Problem Details、health、metrics、shutdown |

完了条件:

- foundationのunit/race/negative testが成功する。
- auth、DB、HTTP間のinterfaceが固定される。
- shared config/contractへ子の直接変更がない。

W1完了後、親はinterface freeze commitを作り、W2 taskへそのcommit hashを明記する。

### W2: Core API

| Role | Task |
|---|---|
| 親 | route登録、横断audit、transaction wiring |
| Agent A | capability、me、manifest、review context、session |
| Agent B | thread、message、version、status、deep link、journal/outbox |
| Agent C | evidence、quota、SHA-256、Range、S3/filesystem |

完了条件:

- Core HTTP differential差分が0件。
- 並行番号/version/idempotencyが収束する。
- Kotlin作成objectとGo作成objectを相互に読める。
- rollback時にaudit/outbox/journalの片残りがない。

Agent BとCはDB tableを共有するため、query fileをtable単位で分け、親がtransaction boundaryだけを統合する。

実行結果（2026-08-09）:

- 3 laneを `session`、`discussion`、`evidence/objectstore` に分離し、親がroute、成功監査、rate limit、main wiringを統合した。
- unit/race/vet/build、PostgreSQL並行試験、MinIO lifecycle、Kotlin/Go live HTTP fixture、双方向object相互運用が成功した。
- 共有interface手戻りはsession listのpresent/empty表現とevidence cleanup分類をbarrier前に解消し、V6 schemaを変更していない。

### W3: Async、Administration、CLI

| Role | Task |
|---|---|
| 親 | subcommand registry、共通worker lifecycle、cipher/config統合 |
| Agent A | export、full/incremental backup、backup pull |
| Agent B | notification、connector queue/runtime/register、暗号 |
| Agent C | membership、管理API、bootstrap完成、legacy migration CLI |

完了条件:

- 全worker/CLIのfeature inventory差分が0件。
- archive/connector/adminの局所integrationが成功する。
- 既存entrypoint名から各subcommandを起動できる。

Retention本体はEvidence/Export/Backupの完成に依存するため、W3で並行着手せずW4へ置く。

### W4: Retention、Packaging、全体品質

| Role | Task |
|---|---|
| 親 | CI、Compose、OpenAPI/環境変数、全route/commandの最終統合 |
| Agent A | retention、expiry、orphan cleanup、failure injection |
| Agent B | HTTP/DB/archive/connector全differential、security/fuzz |
| Agent C | OCI、multi-arch、SBOM、独立抽出、standalone smoke準備 |

完了条件:

- Go版だけで全単体・race・integration・conformanceが成功する。
- clean extractionでbuild、Docker build、standalone smokeが成功する。
- image/resource/performance基準を満たす。
- production routeへ未実装handlerがない。

### W5: Canary preparation

| Role | Task |
|---|---|
| 親 | 切替判定、承認項目、runbook統合 |
| Agent A | workspace sticky routing、API rollback手順 |
| Agent B | worker role ownership切替、lease/retry rollback手順 |
| Agent C | benchmark、24時間fault、restore drill |

W5ではコード変更より検証と運用証跡を並行作成する。routing、replica、DBへ実際の変更を加える操作は親だけが行う。

完了条件:

- canary開始条件、監視query/dashboard、即時rollback操作が実地検証済み。
- V7以降が未適用で、Kotlin imageを再起動できる。
- backup/restore、key rotation、connector deliveryの演習証跡がある。

### W6: Canary observation

| Role | Task |
|---|---|
| 親 | routing/replica変更、incident判断、観察期間管理 |
| Agent A | API差分、認可、監査を監視 |
| Agent B | queue、delivery、retention、backup cursorを監視 |
| Agent C | latency、RSS、error、DB/storageを監視 |

監視agentはコードを自動修正・deployしない。異常を検出したら証跡とrollback条件への該当を親へ報告する。

完了条件:

- 14日かつfull backup 2周期を通過する。
- Sev 1/2、データ欠落、認可越境、backup検証失敗が0件。
- rollback条件へ一度も該当しないか、該当時にrollback後の再監査を完了している。

### W7: Kotlin removal

| Role | Task |
|---|---|
| 親 | Kotlin削除対象、commit順、Go-only releaseを統合 |
| Agent A | verify/CIからGradle/JDK依存を除去 |
| Agent B | Docker/Compose/抽出物をGo-only化 |
| Agent C | docs、SBOM、dependency/license inventoryを収束 |

Kotlin source削除、migration owner変更、default image切替は親が実施する。子は参照残存の調査と限定path修正を担当する。

完了条件:

- `VERIFY_SCOPE=feedback` がJDKなしで成功する。
- source、image、docs、SBOMにKotlin runtime依存が残らない。
- V7以降をGo migratorで適用できる。

## 6. Go移行後Roadmapのagent配置

### R0

| Agent | Lane |
|---|---|
| A | v1互換不具合、regression、capacity |
| B | fault、restore、key rotation、運用runbook |
| C | release、SBOM、署名、security response |

親はGA判定とpublic contract freezeを所有する。未解決Sev 1/2があればR1/R2のreleaseを止める。

### R1 / R2 / R9計測

| Agent | Lane |
|---|---|
| A | 独立repository、release manifest、upgrade |
| B | SDK/Host Adapter 1.0、typed client、testing kit |
| C | 30日分のruntime/queue/DB metrics収集と分析 |

R1とR2はpathが分離できるため並行する。Agent Cは計測とproposalだけを行い、topologyをまだ変更しない。

### R3 / R4 / R6

親が先にTarget schema evolution、widget controller、Sidecar Token Exchange/proxy境界のRFCを個別に固定する。

| Agent | Lane |
|---|---|
| A | Target v2、anchor alias、resolver/conformance |
| B | Web Component、React binding、accessibility |
| C | 任意Sidecar、token broker、企業認証fixture |

R4はTarget v1だけで先行可能だが、Target v2の表示対応をmergeするのはR3 contract固定後とする。

### R5 / R7 / R9実装

| Agent | Lane |
|---|---|
| A | review profile、thread workflow、scope/perspective、Admin/reporting |
| B | Connector/Adapter tooling、third-party conformance |
| C | 30日以上の実測に基づくworker profile/scaling |

R9の実装はGo GA後30日以上の本番相当metricsを入力条件とする。根拠が不足する場合、Agent Cは変更せず計測継続を提案する。

### R8

| Agent | Lane |
|---|---|
| A | archive、証跡搬送、checksum、Object Lock option |
| B | offline bundle、private CA/registry、署名/SBOM |
| C | backup/restore、DR drill、運用証跡、security profile |

親はoffline clean networkで3 laneを統合し、installからrestoreまでのacceptanceを実行する。

## 7. Spawn task template

親は各子への依頼へ必ず次を含める。

```text
目的:
完了条件:
編集可能path:
編集禁止path:
固定済みcontract/interfaceとcommit:
利用可能なfixture:
実行する局所test:
許可しない操作:
完了報告形式:
```

完了報告には次を要求する。

- 変更ファイル一覧
- 実装した挙動と意図的に未実装の挙動
- 実行したcommandと結果
- contract/config/migration変更要求
- concurrency/security/rollback上の注意
- 親が統合時に行う作業

曖昧な「機能を実装する」だけでspawnせず、1 agentにつき1つのbounded ownershipとacceptanceを与える。

## 8. Integration barrier

各Waveで次を繰り返す。

1. 親が固定interfaceとpath ownershipを通知する。
2. 子3体を並行起動し、親は共通wiring/test fixtureを進める。
3. 子の完了ごとに親が所有path外の変更、局所test、未解決要求を監査する。
4. 全laneが揃ったら新規spawnを止める。
5. 親が共通interface、generated code、`go mod tidy`、wiringを直列統合する。
6. unit、race、contract syncを実行する。
7. W2以降はPostgreSQL/MinIO integrationとKotlin/Go differentialを実行する。
8. gate成功後だけWave統合commitを作る。
9. 次Waveへ固定commitと既知制約を引き継ぐ。

一部laneが失敗しても、他laneの成果物を自動的に破棄しない。親が失敗の共有interface影響を判定し、独立なら統合を保留して修正taskを再割当する。

## 9. Test resource isolation

並行testは共通DB/schema/bucket/containerを共有しない。

- 親が `FEEDBACK_TEST_RUN_ID=<wave>-<agent>` を割り当てる。
- DB名/schema、bucket prefix、container名、portをrun IDから一意にする。
- destructive integration testは対象名のprefix guardを通らなければ起動拒否する。
- shared Composeを使うfull integrationはbarrier中に親だけが実行する。
- codegen、npm install、Go module更新、抽出testも親が直列実行する。
- 子が起動したprocess/containerは完了時に正確な名前を報告し、親がcleanupを確認する。

## 10. 品質と速度の両立

並行化の成功指標はagent稼働率ではなく、critical path短縮と統合失敗の少なさで測る。

- 各Waveの直列時間、並行時間、barrier時間を記録する。
- merge conflict、所有path違反、共通interface手戻りを件数化する。
- 同じ不具合を複数laneで修正した場合はownershipまたはinterface分割を見直す。
- barrierが全期間の40%を超える場合、agent数を増やさずfixture/interface整備を優先する。
- 子が待機する場合は先行Waveのtest/文書/negative caseへ再割当する。
- contract、security、migrationの品質ゲートを速度のために弱めない。

## 11. 完了チェックリスト

- [x] 各Wave開始時に親1 + 子最大3の配置が記録されている。
- [x] 各子に編集可能/禁止pathと局所testが指定されている。
- [x] 共有contract/migration/generated codeを親だけが変更している。
- [x] 並行integration資源がrun IDで分離されている。
- [x] 各barrierでunit/race/contract/integrationが依存DAG順に成功している。
- [ ] Wave単位のcommitが常にbuild可能である。
- [ ] Canary以降の外部状態変更を親だけが実施している。
- [ ] Kotlin撤去前に14日/2 full backupの直列観察ゲートを通過している。
- [ ] 移行後RoadmapでもR1/R2、R3/R4/R6等の独立laneを実際に並行実行している。
- [x] 並行化による手戻り、conflict、barrier時間を振り返り、次Waveのownershipへ反映している。

## 12. 実行記録

### W0: Contractとscaffold（2026-08-09）

固定入力はcommit `7026ac58ce91e9c6f3291c94fac4fe69bd528def`、基準実装は`afe6d04`。
親がcontract、Go module/generated code、V6、CI/scriptを所有し、次の排他的pathで3レーンを実行した。

| lane | agent | 編集可能path / run ID | 結果 |
|---|---|---|---|
| 親 | `/root` | 親専有path、`FEEDBACK_TEST_RUN_ID=w0-migration` | 42 operation codegen、V6、Go/Kotlin gate、integration barrierを統合 |
| inventory | `/root/w0_inventory` | `docs/feedback-go-v1-inventory.md`のみ | API/process/env/metric/artifactを全分類。未分類0、証拠不足を別記 |
| OpenAPI | `/root/w0_openapi` | repository read-only、`/tmp`のみ | oapi-codegen v2.8.0、Go 1.26.5、nullable生成、42 routeを隔離検証 |
| migration | `/root/w0_migration_tests` | handoff test新規2ファイルのみ、`w0-migration` | V1〜V5 checksum、fresh/V5→V6収束、marker/CHECK testを追加 |

integration資源はloopbackの専用PostgreSQL 16 container `feedback-w0-fingerprint`を親だけが使用した。
schema fingerprint算出とmigration testはrun ID付き一時DBへ分離し、共有DB/Object Storageを子へ渡していない。
子による所有path違反、git操作、merge conflictは0件だった。

W0 barrierはGoの生成drift・vet・unit・race・CGO無効build、Kotlinのunit/integration、contract/package/conformance、
クリーン抽出、3 image build、standalone smokeまで成功した。クリーン抽出で検出した `.git` なし環境のGo VCS stampingと、
段階V1〜V6をclean V1へ畳み込む抽出物の静的test不整合は、それぞれ再現可能build optionと二形態対応testで解消した。

### W1: Runtime foundation（2026-08-09）

W0で固定したcontractとV6境界を入力に、親がGo module、共通interface、runtime wiring、PostgreSQL/HTTP統合を所有し、
次の排他的pathで3レーンを実行した。ユーザーからcommit作成の依頼は受けていないためinterface freeze commitは作成せず、
検証済み共有worktreeをW2の固定入力とする。

| lane | agent | 編集可能path / run ID | 結果 |
|---|---|---|---|
| 親 | `/root` | `cmd/feedback`、横断wiring、usecase、DB adapter、Object Storage、CI、`w1-runtime`/`w1-http`/`w1-diff` | 4 endpoint、DI、V6起動検証、PostgreSQL/HTTP/live differentialを統合 |
| auth/config | `/root/w1_auth_config` | `internal/auth`、`internal/config` | direct/exchange JWT、JWKS refresh、permission交差、拒否監査、環境変数契約を実装 |
| database/bootstrap | `/root/w1_database_bootstrap` | `internal/postgres`基盤、`internal/bootstrap` | pgx pool/transaction/claim、冪等bootstrapを実装 |
| HTTP/observability | `/root/w1_http_foundation` | `internal/httpapi`基盤、`internal/observability` | Problem Details、middleware、CORS、health/metrics/trace、shutdownを実装 |

親の統合時に、PostgreSQL 16.14のcanonical schema fingerprintが旧goldenと異なることを実体DBで検出した。
さらにrestore演習でCHECK/partial indexのtext-array castが`pg_dump`/`pg_restore`後に同値の別表記になることを検出し、
restore安定化したV1〜V6 fingerprint `01d03abc057749179777853ca970bc220f1ee79d8b6fa98d0e0801ba5788e36d`へ
V6 marker、Go定数、Kotlin統合test、inventoryを同期した。
またlive differentialでGoだけがJSONへ`charset=utf-8`を付ける差分とGET manifestだけに余分なETagを返す差分を検出し、
Kotlin/OpenAPIへ一致させた。共通interface手戻りはreadiness probeのDB/storage分離1件、merge conflictと所有path違反は0件だった。

W1 barrierはGoの生成drift・tidy・unit・race・vet・CGO無効build、PostgreSQL実体のbootstrap/manifest/review-context、
実JWTを通すHTTP統合、Kotlin/Go live differential、Kotlin unitとMinIOを含む14件のintegrationを成功させた。
CIはPostgreSQL 16.14へ固定し、Kotlin/FlywayでV6 handoff DBを構築後にGo runtime統合testを実行する。

### W2: Core business parity（2026-08-09）

W1のauth/DB/HTTP interfaceを固定入力とし、session、discussion、evidenceを排他的な3レーンで実装した。

| lane | agent | 主なownership / run ID | 結果 |
|---|---|---|---|
| 親 | `/root` | 42 route handler、共通認可・監査・rate limit wiring、`w2-http`/`w2-diff` | handler統合、42 fixture differential、HTTP/PostgreSQL barrierを完了 |
| session | `/root/w1_auth_config` | `internal/session`、PostgreSQL session、`w2-session` | CRUD、idempotency、楽観lock、cursor/validation順序を実装 |
| discussion | `/root/w1_database_bootstrap` | `internal/discussion`、PostgreSQL discussion、`w2-discussion` | thread/message/version/journal/outbox/rate limitを単一transactionへ統合 |
| evidence | `/root/w1_http_foundation` | `internal/evidence`、`internal/objectstore`、PostgreSQL evidence、`w2-evidence` | strict upload、quota、Range、local/S3、orphan回収を実装 |

専用PostgreSQL 16とMinIOをrun ID/bucket prefixで分離し、unit/race/vet、並行transaction、
Kotlin/Go object相互読込、42 route live differentialをbarrierで成功させた。共有interface手戻りはlist queryの
present/empty識別、evidence scope observer、commit不明cleanup分類の3件で、所有path違反とmerge conflictは0件だった。

### W3: Workers、administration、CLI（2026-08-09）

W2のmutation/storage境界を固定し、export/backup、notification/connector、administration/legacy migrationを並行実装した。

| lane | agent | 主なownership / run ID | 結果 |
|---|---|---|---|
| 親 | `/root` | command/HTTP wiring、retention残差、全route inventory | 10 process entrypointと42 operationを統合 |
| export/backup | `/root/w1_auth_config` | export、backup、backup pull、`w3-export-backup` | CSV/XLSX、full/incremental ZIP、cursor、pull atomic replaceを実装 |
| notification/connector | `/root/w1_database_bootstrap` | cryptoutil、connector、notification | administration、worker、HTTP/SMTP runtime、registerを実装 |
| admin/legacy | `/root/w1_http_foundation` | membership、legacy migration、`w3-admin-legacy` | membership CRUDと旧snapshot dry-run/copy/reconcile/rollbackを実装 |

PostgreSQL/MinIO実体のrace付きintegration、Connector別process試験、Admin/conformance wiringを完了した。
型名・constructorの共有は各レーンから親へfreeze通知して直列統合し、重複symbol2件とimport2件をbarrier前に解消した。
外部状態変更、migration追加、commit作成は行っていない。

### W4: Differential、packaging、canary準備（2026-08-09〜10）

親がretention、full-system differential、security/fuzz、release artifact、独立抽出を直列統合した。
OpenAPI 42 requestのKotlin/Go差分は0件、Go standalone smokeはV6 handoff、全worker、connector二段配送、
evidence Range、export、retention、token exchange、frontend継続まで成功した。

Go unit/race/vet/CGO無効build、PostgreSQL/MinIO全integration、6 fuzz target、staticcheck、govulncheck、
non-root 100MB制約Docker imageを検証した。linux/amd64・linux/arm64 binary、multi-arch OCI、CycloneDX SBOM、
release manifest、SHA256SUMSを実生成し、platformとchecksumを照合した。

clean抽出では、旧consumer移行台帳を除外するfresh V1と通常V1〜V6 upgradeのfingerprintが異なることを検出した。
Flyway履歴形状ごとに別の固定fingerprintだけを受理し、baseline marker生成も対応させた。
当初はPhase 8を外部deploymentと14日/2 full backup観察後に完了する前提とした。その後、対象が未投入であるとの
risk acceptanceにより、長時間待機は初回導入後の非blocking確認へ変更した。

### W5: ローカルrollback準備（2026-08-10）

同一V6 DB/MinIOに対し、notification、export、retention、APIの順にGoの対象roleだけを停止してKotlinの同roleを起動する
rollback smokeを追加した。Go API稼働中のKotlin worker処理、Go作成sessionのKotlin API読取、Kotlinのmessage書込、
notification配送、export生成/download、retention削除とDB件数照合が成功した。さらにPostgreSQL custom dumpと
Evidence/Export bucketを隔離先へrestoreし、
Go schema fingerprint、DB data-only dump、全object path/SHA-256を照合した。実gatewayのworkspace sticky routing、
production replica/lease観察、対象環境backupのrestoreは外部環境のW5で引き続き実施する。

### W6: ローカルdefault候補と非機能実測（2026-08-10）

同じsourceからdata-only cloneしたKotlin/Go DB、同じObject Storage/OIDC、1 CPU/512MiBで3 endpointを各実装
1,000 sample測定し、計6,000 request error 0、Go p95 29.84〜53.69%短縮、peak RSS 83.7%削減を確認した。
ローカルgatewayではeast→Go、west→Kotlinの各20 writeとeast→Kotlin rollbackがaudit増分20:0で排他的になることを確認した。

`assemble-feedback-repository --go-only`、空DBを初期化する埋め込みclean V1、JDKなしverify/smokeの独立CI job、
PostgreSQL再起動後の次反復までlease/cursor/idempotencyを検査する24時間soak harnessを追加した。最初の長時間runで
31完了反復後のstatement timeoutをfail-closedに記録し、attempt/completed反復とfailure stageをsummaryへ追加した。
短縮soakは2反復・1再起動・異常0で、補強後runも2時間15分・228反復・11再起動・異常0まで確認した。未投入環境向けの
risk acceptanceにより24時間完走は省略した。production routing/replica、対象環境restore、14日/2 full backup観察は
初回導入後の非blocking確認として残す。

完了監査でruntimeをdigest固定distrolessへ収束し、read-only/capability制約、darwin/windows CLI artifact、
OCI vulnerability scan、role別container memory gateを追加した。これらを含む一括extraction/release/rollback smokeは
短縮soak終了後に実行し、全て合格した。さらに`kin-openapi v0.142.0`のCriticalを最初のrelease scanで検出し、
v0.144.0へ更新してplatform別scan 0件を確認した。

### W7: Go-only完了（2026-08-10）

fresh baselineと既存V1〜V6 checksum archiveをGo moduleへ固定し、Compose、CI、抽出repositoryのdefaultをGoへ切り替えた。
Kotlin source、Gradle wrapper、Kotlin生成契約を正本から撤去した。撤去後の再抽出・Go全testと、baselineを内包する
multi-platform binary、multi-arch OCI、platform別CycloneDX/SARIF、全checksumを再生成して初回導入のblocking gateを完了した。
