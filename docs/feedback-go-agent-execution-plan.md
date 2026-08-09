# Feedback Platform サブエージェント並行実行計画

> 対象: Go v1完全互換移行とGo移行後ロードマップ
> 実行モデル: 統合担当の親エージェント1 + 実装サブエージェント最大3
> 前提文書: [`../feedback-platform-improvement-plan.md`](../feedback-platform-improvement-plan.md)、
> [`feedback-platform-post-go-roadmap.md`](feedback-platform-post-go-roadmap.md)

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

- [ ] 各Wave開始時に親1 + 子最大3の配置が記録されている。
- [ ] 各子に編集可能/禁止pathと局所testが指定されている。
- [ ] 共有contract/migration/generated codeを親だけが変更している。
- [ ] 並行integration資源がrun IDで分離されている。
- [ ] 各barrierでunit/race/contract/integrationが依存DAG順に成功している。
- [ ] Wave単位のcommitが常にbuild可能である。
- [ ] Canary以降の外部状態変更を親だけが実施している。
- [ ] Kotlin撤去前に14日/2 full backupの直列観察ゲートを通過している。
- [ ] 移行後RoadmapでもR1/R2、R3/R4/R6等の独立laneを実際に並行実行している。
- [ ] 並行化による手戻り、conflict、barrier時間を振り返り、次Waveのownershipへ反映している。
