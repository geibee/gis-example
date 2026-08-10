# Go canaryとrollback

このrepositoryは未投入環境へGo-onlyで初回導入する。workspace単位の段階的routingを使い、workerはrole単位で
1 replicaから開始する。切替順はnotification、export/backup、retention、bootstrap/connector/CLIとする。

開始条件はV1〜V6 success、V6 baseline marker一致、V7未適用、backup/restore checksum確認、全contract/integration/
standalone gate成功である。認可越境、監査欠落、データ欠落、backup checksum不一致、回復しないqueue lagで即時に
workspace routingを直前のGo imageへ戻し、対象Go workerを0にする。processing行を手動更新せずstale lease回収後に
直前imageのworkerを再開する。DBはV6のままrollbackしない。

既存V1〜V6 DBのrollbackには、切替元のV1〜V6 checksumを保持するKotlin imageを使う。fresh install向けにmigrationを
V1へ収束したclean抽出版Kotlin imageは既存DB用ではない。Flyway checksum mismatch時はrepairせずimage digestを確認する。

Go runtimeはUID/GID 65532、read-only root filesystem、capability全drop、権限昇格禁止で起動する。書込みは制限付き
`/tmp`と明示volumeだけにし、ローカル比較は各roleを1 CPU/512MiBへ統一する。egressは既定denyとし、APIはDB/Object Storage/JWKS、各workerはDBと担当storage/connector、
connector runtimeは承認済みprovider endpoint、backup pullはtoken/backup endpointだけを許可する。canary開始前に
許可先の疎通と未許可fixture endpointの拒否を変更記録へ残す。

ローカルでは `FEEDBACK_SMOKE_RUNTIME=go bash scripts/smoke-feedback-standalone.sh` が空DB migration、API、worker、
Object Storageの主要経路を検証する。Kotlin撤去前には同一V6 DB/Object Storageを維持する相互rollbackとrestoreを完了済みである。
これは実gatewayのworkspace routing、production replica、対象環境から取得したbackup restoreの代替ではない。

HTTP p95は同じsnapshot/resource limitの隔離replicaへ同じread-only fixtureを送り、次のscriptが生成する全sample入りJSONを
変更記録へ保存する。`FEEDBACK_CANARY_BEARER_TOKEN`は短時間tokenを環境変数からだけ渡し、成果物へ記録しない。

```bash
read -r -s FEEDBACK_CANARY_BEARER_TOKEN
export FEEDBACK_CANARY_BEARER_TOKEN
scripts/measure-feedback-canary.sh \
  --kotlin-url https://feedback-kotlin.example/feedback/v1 \
  --go-url https://feedback-go.example/feedback/v1 \
  --path '/sessions?applicationKey=fixture&environmentKey=canary&externalWorkspaceKey=fixture&limit=50' \
  --samples 1000 --concurrency 16 --warmup 50 \
  --output <change-record-directory>/sessions.json
unset FEEDBACK_CANARY_BEARER_TOKEN
```

既定の合格条件は両実装のHTTP error 0件、Go p95がKotlin比10%以内である。本番writeのmirror、異なるfixture、
`--allow-http`、緩和した比較率は合格証跡に使わない。

稼働済み環境のin-place移行では、全traffic移行後14日間かつfull backup 2周期の観察が完了するまでKotlin imageを保持し
V7を適用しない。未投入環境の初回導入では長時間観察をpost-deploy確認へ移せる。どちらもimage digest、workspace集合、
role owner、error/p95、queue lag、delivery failure、backup checksum、retention、audit件数を変更記録へ残す。

Go-only抽出物では、24時間fault gateを専用PostgreSQLでローカル実行できる。parallel claim、stale lease回収、
idempotency replay、backup cursor不変条件を反復し、20反復ごとにDBを再起動して次反復の回復まで検証する。

```bash
scripts/soak-feedback-go.sh --duration 24h --interval-seconds 30 --fault-every 20 \
  --output <change-record-directory>/feedback-go-soak-24h.json
```

summary、全iteration JSONL、test logのSHA-256を変更記録へ添付する。稼働済み環境では短縮実行を24時間gateの代替にしない。
未投入環境では短縮実行を採用できるが、省略判断、実時間、反復数、再起動数、不変条件件数を明記する。
