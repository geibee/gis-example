# Feedback Service Go移行 完了監査

## 判定基準

この文書は `feedback-platform-improvement-plan.md` の完了条件を、実装済みであることだけでなく、再現可能な検証証跡まで
含めて突合する。状態は次の3種類に限定する。

- **合格**: repository内の自動試験または記録済みcommandで条件を検証済み
- **暫定合格**: 絶対値は満たすが、計画が要求する同一fixture・同一resource limitでの比較が未完了
- **未完了**: 外部環境、長時間観察、または追加の演習が必要

今回の対象は未投入のため、初回導入のblocking gateと導入後に観察する非blocking項目を分ける。稼働済み環境を将来
in-place移行する場合は、Kotlin rollback artifact保持、V7凍結、14日/2 full backup観察を再びblockingとする。

## Phase gate

| Phase | 状態 | 証跡 |
|---|---|---|
| 0 Contract freeze | 合格 | `contracts/feedback/freeze-v1.json`、`contracts/feedback/behavior/http-v1.json`、OpenAPI 42 operation、route coverage、V6 handoff統合試験 |
| 1 Runtime foundation | 合格 | `internal/auth`、`internal/httpapi`、`internal/observability`、`internal/postgres` のunit/race/integration。DB/Object Storage readinessとJWKS auth fail-closedを検証 |
| 2 Session/discussion | 合格 | PostgreSQL実体で並列thread番号、message version、idempotency、rate limit、rollback時のjournal/outbox片残りを検証 |
| 3 Evidence/storage | 合格 | PostgreSQL/MinIO実体、Range/MIME/size/quota/SHA/path/timeout、Kotlin/Go object相互運用を検証 |
| 4 Export/backup/retention | 合格 | deterministic archive、cursor非更新、object/DB片失敗、pull checksum/atomic replacement、OAuth/Bearer付きredirect拒否を検証。pull metadataはbyte上限・単一JSON・page件数・cursor循環/総page上限をfail-closedに検査。export/backupのDB完了結果不明時はobjectを保持し、retentionはDB論理purge/監査をcommit後にObject削除する。失敗objectをevidence/export/backup別orphan sweepで回収することをPostgreSQL実体・race付きで検証 |
| 5 Notification/connector | 合格 | protocol schema、別process配送、timeout/429/4xx/5xx/duplicate/lease/secret rotation/redactionを検証。append-only delivery ID台帳は全量readせず行単位で走査し、直近件数だけを保持する。再起動後の重複排除、不正UUID、上限超過行のfail-closedをrace付きで検証 |
| 6 Administration/legacy | 合格 | OpenAPI 42 operationの実装、production API全依存の起動前完全性検査、Admin/conformance smoke、legacy専用journalの初回作成・冪等再実行・checksum検証とdry-run/apply/reconcile/rollbackをPostgreSQL実体で検証 |
| 7 Packaging/extraction | 合格 | JDKなしのGo-only clean extraction、unit/race/vet、Frontend/SDK/package、空DB migration、全container smokeを完走。Kotlin撤去後は同じallowlistの再抽出・構造検査・Go全testを再実行し、multi-platform binary/OCI/SBOM/checksumを再生成 |
| 8 Canary/default/Kotlin撤去 | 合格（初回導入） | ローカルsticky routing・rollback/restore・API性能、短縮fault 228反復/DB再起動11回/異常0、role別RSS、Go default化、Kotlin/Gradle/生成契約撤去を完了。24時間/14日/2 full backup待ちは導入後の非blocking確認 |

Phase 0〜7の統合commandは次である。破壊的な実体試験は専用DB/bucketとrun ID guardがない場合は起動しない。

```bash
FEEDBACK_TEST_RUN_ID=w4-final VERIFY_INTEGRATION=1 \
  FEEDBACK_GO_INTEGRATION_DATABASE_URL=... \
  FEEDBACK_GO_INTEGRATION_LEGACY_DATABASE_URL=... \
  FEEDBACK_GO_INTEGRATION_DATABASE_USER=... \
  FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD=... \
  FEEDBACK_GO_INTEGRATION_S3_ENDPOINT_URL=... \
  FEEDBACK_GO_INTEGRATION_S3_BUCKET=... \
  bash scripts/verify-feedback-go.sh

FEEDBACK_SMOKE_RUNTIME=go bash scripts/smoke-feedback-standalone.sh \
  --evidence-output <new-evidence-directory>
bash scripts/check-feedback-extraction.sh
bash scripts/build-feedback-go-release.sh --output <empty-directory> --version <version>

scripts/assemble-feedback-repository --output <empty-directory> --go-only
# 抽出先でJDKなしに実行
bash scripts/verify-feedback.sh
bash scripts/smoke-feedback-standalone.sh
```

## 非機能acceptance

2026-08-10のローカル計測値は、合否を過大評価しないため次のように扱う。

| 指標 | 条件 | 計測結果 | 判定 |
|---|---|---|---|
| Runtime image | 100MB以下、Kotlin比70%以上削減 | Go distroless 29,482,865 bytes、Kotlin 414,373,449 bytes、92.9%削減。UID/GID 65532、shell/package managerなし、CA証明書・timezone dataあり | 合格 |
| Idle RSS | 各server/worker 100MiB以下、Kotlin比50%以上削減 | 同一fixture比較のAPI peakはKotlin 209,388KiB、Go 34,112KiB（83.7%削減）。最終Go-only containerはAPI 8,904,507 bytes、notification 7,421,821 bytes、export/backup 7,376,732 bytes、retention 8,528,069 bytes | 合格 |
| 起動 | migrationなしでreadiness 2秒以内 | Go container 407ms、native process 82ms | 合格 |
| Build | warm module cacheで`go test ./...` 15秒以内 | `go test -count=1 ./...` 4.87秒 | 合格 |
| HTTP performance | p95がKotlin比10%以上悪化しない | 同一clone・1 CPU/512MiB、各endpoint/実装1,000 sample。Goはsession一覧228.724ms（-29.84%）、capabilities 45.151ms（-53.69%）、session詳細86.392ms（-32.07%）、計6,000 request error 0 | 合格（ローカル） |
| Reliability | 未投入環境はDB再起動を含む短縮fault testでlease/cursor/重複異常0 | 2時間15分、228完了反復、DB再起動11回、異常0。24時間要求は初回導入のblocking gateから明示的に除外 | 合格（初回導入） |
| Shutdown | SIGTERM後30秒以内、新規claimなし | Go container 125ms、native process 3ms。cancel後の新規claim 0に加え、contextを無視するcycleも30秒上限でprocessへ返すworker試験が合格 | 合格 |

性能証跡は同じsource DB/Object StorageからKotlin用・Go用DBをdata-only cloneし、同じDocker host、1 CPU、512MiB、
同一OIDCとread-only fixtureで取得した。証跡SHA-256はsession一覧
`34be5283c26433b41cee07aa70636a877ed80dadf1ca718ca99e097815db0426`、capabilities
`023865fd561fb49005d2cc6763311c3a986bc6fdcadf633b33643b2d49fe5613`、session詳細
`b552747eb8b9993834e2804f2855d44e973113d53e767c3fb925c4de202ecaeb`である。production canaryでは同じharnessを再実行する。

## Security、failure injection、recovery

| 項目 | 状態 | 証跡または残作業 |
|---|---|---|
| `go vet` / race / staticcheck | 合格 | 全package成功。staticcheck v0.7.0をGo 1.26.5で実行し、生成template由来ST1005だけを生成元で限定抑制。未使用code、deprecated ZIP API、error文の実指摘は修正済み |
| Go fuzz | nightly接続済み | path、connector payload、strict Base64、Range、CSV/formula、canonical JSONの6 targetを各30秒実探索。seed corpusは通常testでも実行 |
| `govulncheck` | 合格 | v1.6.0で全packageを走査し、呼出可能な脆弱性0件 |
| Trivy / SBOM / checksum | 合格 | 最初のrelease scanで`kin-openapi v0.142.0`のCriticalを検出して成果物をrejectし、v0.144.0へ更新。distroless multi-arch OCIのlinux/amd64・linux/arm64でHIGH/CRITICAL 0件、platform別CycloneDXと全`SHA256SUMS`を生成 |
| Runtime confinement | 合格 | UID/GID 65532のdistroless、shell/package managerなし。read-only root、capability全drop、権限昇格禁止、制限付き`/tmp`でGo-only Compose 9 serviceと全stackを検査。撤去後の同一Dockerfileでmulti-arch imageを再build |
| Egress default deny | 外部Phase 8 | role別許可先をrunbookへ固定。production network policyの許可/拒否疎通証跡が必要 |
| JWT algorithm/issuer/audience/time | 合格 | `internal/auth` table-driven negative test |
| SSRF/CSV/ZIP/path/oversize | 合格 | connector、export、backup pull、object store、evidenceのnegative test。backup API/pullはDB記録`archiveBytes+1`で読取/一時fileを物理制限し、Object metadata/Content-Length・実byte数・SHA-256・manifestを照合。exportは既知Object sizeで直接streamしてheapを定数化し、short/long bodyを拒否。pull metadata JSON上限/cursor循環も拒否 |
| tenant/application/workspace越境 | 合格 | auth/usecase/HTTP/PostgreSQLのnegative test |
| 環境変数SSoT | 合格 | Go backendと隣接component・build/release/smoke・integrationの実参照を独立文書へ列挙し、未記載実参照をcontract gateが拒否する |
| Prometheus v1形式 | 合格 | 13系列の名前・label・増分を維持し、Kotlin v1にないHELP/TYPEとhistogram bucketをHTTP公開から除外するgolden test |
| DB/Object Storage readiness障害 | 合格 | readiness matrix/timeout試験と実体integration |
| JWKS障害 | 合格 | readinessの必須依存には加えずKotlin契約を維持し、認証要求だけをfail-closedにする試験 |
| connector timeout/429/4xx/5xx/duplicate | 合格 | protocol unit/実HTTP試験 |
| connector delivery ID台帳 | 合格 | 起動時に台帳をstream走査して直近100,000件だけをmemoryへ保持。不正UUIDと200 bytes超の行を拒否し、再起動後の重複排除をrace/staticcheck/vet付きで検証 |
| worker crash/lease expiry/idempotent recovery | 合格 | PostgreSQL lease/concurrency試験 |
| DB接続枯渇 | 合格 | pool size 1を占有し、2本目が150msでtimeoutした後、解放後のtransaction/readiness回復をPostgreSQL実体・race付きで検証 |
| export/backup commit結果不明 | 合格 | upload済みattempt固有objectを即時削除せず、DBがcommit済みなら参照を維持し、rollback済みならretention orphan sweepへ収束させるunit/integration試験 |
| backup worker大容量I/O | 合格 | 一時ZIPからsize付きReaderでLocal/S3へ直接streamし、archive全量のheap複製を廃止。short/long Reader時のpartial file削除と実MinIO round tripをrace付きで検証 |
| retention Object削除失敗 | 合格 | 外部削除をDB transaction外へ分離。失敗注入後もmetadata削除と監査がcommit済みで、残存evidence/export objectをgrace後のorphan sweepが回収することを専用PostgreSQLで検証。backupも同じ境界と専用prefixを使用 |
| 長時間fault | 省略（初回導入） | 2時間15分、228完了反復、DB再起動11回、異常0で意図的終了。summaryは要求24時間未達を`result=failed`/`failureStage=interval-wait`として正直に保持し、SHA-256付きJSONL/logを短縮試験証跡とする |

最終release候補は`ci-results/feedback-go-release-final-go-only-20260810`、Go-only抽出確認先は
`ci-results/feedback-go-final-repository-20260810`である。releaseの全`SHA256SUMS`、platform別SARIF結果0件、
CycloneDX、4 platform binary、multi-arch OCIを確認した。空DBbaselineのSHA-256は
`f5dba8092f63dcf0b49378582a1a6be3d32e5f6577a6e6e1ec131a811850e0cd`である。

最初の24時間runは2026-08-10 09:03 JSTに開始し、31反復とDB再起動1回まで不変条件異常0だった。attempt 32の
schema fingerprint走査が15秒のstatement timeoutに達したため、24時間合格証跡としては無効化した。失敗summaryと
test logのSHA-256は保持し、判定をretryで緩和していない。この失敗を受けてsummaryへ`attemptedIterations`、
`completedIterations`、`failureStage`を追加し、2反復・DB再起動1回の短縮試験で新しい証跡形状と異常0を確認した。
最終runは同日09:42 JSTから専用PostgreSQLで最初から実行した。対象が未投入でproduction data/trafficへ影響しないとの
2026-08-10のrisk acceptanceを受け、11:57 JSTに2時間15分、228完了反復、DB再起動11回、不変条件異常0で終了した。
終了signalによりsummaryは`result=failed`のまま保持し、24時間を完走したとは扱わない。今回のrelease判断では、この短縮証跡と
blockingな契約/DB/E2E/rollback/restoreゲートを使い、24時間と14日/2 full backupはpost-deploy運用確認へ移す。

## Rollbackとrestore

rollbackのDB境界はV6で固定済みであり、V7は未適用である。2026-08-10に専用Composeで次を実地検証した。

1. notification、export、retention、APIの順に対象Go processだけを停止し、同じroleのKotlin processを起動して、
   roleごとの排他切替を確認する。
2. 同じV6 DBとMinIO上で、Go APIのままKotlin notificationによる配送、Kotlin exportによる生成/download、
   Kotlin retention開始後のevidence読取を確認する。
3. 最後にKotlin APIへ切り替え、Goが作成したsessionを読み、新規messageを書き込み、Kotlin notificationで配送する。
   その後Kotlin retentionで期限切れevidenceを削除し、session/thread/evidence/exportのDB件数を照合する。
4. process停止中のPostgreSQL custom dumpを隔離DBへrestoreし、Go migratorのschema fingerprint検証とdata-only dumpの
   SHA-256完全一致を確認する。
5. Evidence/Export bucketを隔離bucketへrestoreし、全objectのpathとSHA-256 manifestを照合する。

最終実行のrestore checksumはDB `d98fab8a251843cf92602608b9de8b8e765e1f3a942e24865ba8c787c0b5cc9c`、
Object Storage manifest `95274371c1c8237aed8ad39bd8794dacbfb71982932bf5269bb296d4090a1797` だった。

ローカルgatewayではeastをGo、westをKotlinへ固定した各20 writeがaudit増分20:0となり、eastをKotlinへ戻した後も
Kotlin:Go=20:0となることを確認した。初回導入後に任意で取得する証跡は次である。

1. production相当gateway/replicaで同じworkspace sticky routingとrollbackを演習すること。
2. production相当replicaでroleごとのlease期限とbacklog単調減少を観察すること。
3. 対象環境で実際に取得したbackupを隔離環境へrestoreし、DB件数、object SHA-256、backup manifestを照合すること。

今回の初回導入にはKotlin rollbackを設けない。将来、既存V1〜V6環境をin-place移行する場合だけ、元のV1〜V6 migration
checksumを保持する切替元Kotlin image digestを別artifactとして保持する。誤った組合せはfingerprint/checksum検証で
fail-closedにする。

## ローカルblocking gate

完了済み。Go-only抽出でJDKなし全ゲート、空DB migration、全container smoke、role別RSSを実行した。Kotlin撤去後は
同じallowlistを再抽出して構造検査とGo全testを行い、platform別OCI scan/SBOM、release checksumを再実行した。
Kotlin source、Gradle wrapper、Kotlin生成契約は正本から撤去し、元一式は
`/tmp/feedback-kotlin-retired-20260810`へrecoverableに退避した。

## 導入後の非blocking確認

- production gatewayのworkspace routingと段階的traffic拡大
- worker roleのownershipとbacklog確認
- production taskのread-only/capability制約とrole別egress default denyの実設定・拒否疎通確認
- `measure-feedback-canary.sh`を使うproduction replicaでのHTTP p95、RSS、error、queue lag再確認
- 対象環境backupのrestoreと、実gateway/replicaによるworkspace・worker rollback演習
- 24時間相当の継続fault観察と14日/2 full backup周期の事後確認

これらは外部routing、replica、backupを変更するため、対象環境の承認と変更記録なしにローカル実装作業として代替しない。
今回の対象は未投入なのでrelease blockingではなく、初回導入後の運用確認とする。14日/2 full backup観察も同じ扱いとする。
