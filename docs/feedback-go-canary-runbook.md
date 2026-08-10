# Feedback Service Go canary / rollback runbook

## 適用範囲

このrunbookはGo版をdefaultへ切り替える前のW5〜W6で使う。routing、replica、DB、bucketを実際に変更する操作は
対象環境の承認後に行う。Kotlin/Goへ同じwriteを二重送信せず、worker roleを両実装で同時稼働させない。

## 開始条件

- OpenAPI 42 operation、behavior fixture、PostgreSQL/MinIO integration、standalone smoke、clean extractionが成功している。
- DBはFlyway V1〜V6がsuccessで、`feedback.go_schema_migrations` のV6 baseline markerが一致する。
- V7以降を適用していない。Kotlin image、設定、secretを直ちに再起動できる。
- rollback用Kotlin imageは既存環境へ適用したV1〜V6の元checksumを保持する。fresh install向けにmigrationをV1へ
  収束したclean抽出版Kotlin imageを、既存V1〜V6 DBのrollbackへ使用しない。
- DBとEvidence/Export bucketのbackupを取得し、隔離環境でrestore checksumを確認している。
- Go/Kotlin image digest、release manifest、SBOM、`SHA256SUMS`を変更記録へ添付している。
- `verify-feedback-go.sh` のpool枯渇統合試験を含むfailure injectionが成功している。

開始前に次を保存する。

```sql
SELECT version, kind, state, schema_fingerprint_sha256, started_at, completed_at
FROM feedback.go_schema_migrations ORDER BY version;

SELECT installed_rank, version, description, success
FROM feedback.flyway_schema_history ORDER BY installed_rank;
```

V6以外のGo migration行、失敗行、Flyway失敗行があれば開始しない。

## Runtime隔離とegress

Go runtime imageはUID/GID 65532のdistroless staticを使用する。ComposeではAPI、migrator、bootstrap、worker、
connectorのroot filesystemをread-only、Linux capabilityを全drop、権限昇格を禁止し、書込み可能領域は
`/tmp`の制限付きtmpfsと明示volumeだけにする。ローカル比較では各roleを1 CPU/512MiBへ統一する。
production task定義でも同等のsecurity制約を設定し、起動後の実設定を
変更記録へ保存する。

egressは既定denyとし、platform DNSに加えてroleごとに次だけを許可する。hostname/IPは承認済み設定値から生成し、
広域CIDRやInternet全体を許可しない。

| role | 許可するegress |
|---|---|
| API | PostgreSQL、Evidence/Export Object Storage、direct OIDC/token exchangeのJWKS |
| migrate / bootstrap | PostgreSQL |
| notification worker | PostgreSQL、登録済みconnectorのhealth/delivery endpoint |
| export/backup worker | PostgreSQL、Evidence/Export Object Storage |
| retention worker | PostgreSQL、Evidence/Export Object Storage |
| connector register | PostgreSQL、登録対象connectorのmanifest endpoint |
| connector runtime | providerごとの承認済みWebhook/Teams/Slack endpointまたはSMTP relay |
| backup pull | OAuth token endpoint、共有backup server、マウント済みdestination volume |
| legacy migration | PostgreSQL、Evidence Object Storage、明示したsnapshot input |

canary開始前にroleごとの許可先への疎通と、未許可fixture endpointへの拒否を両方確認する。Composeの設定検査は
runtime confinementまでを証明するものであり、production network policyのegress denyを代替しない。

## API切替

gatewayでworkspace IDをstable hashし、承認したworkspaceだけをGo upstreamへ固定する。同一workspaceはread/writeとも
一方の実装へ送り、request単位のrandom splitやmirror writeを使わない。

1. Go APIをread-only probeへ接続し、live/ready/capabilitiesと代表GETを確認する。
2. 内部fixture workspaceを1件だけGoへ固定し、session→thread→message→evidence→exportを実行する。
3. error rate、p95、監査件数、DB副作用の差分が基準内ならworkspace数を段階的に増やす。
4. 各段階を最低1 full observation window維持し、次段階の承認者と時刻を記録する。

## worker ownership切替

順序はnotification、export/backup、retentionとする。roleごとに旧Kotlin replicaを0へし、処理中leaseの期限切れと
queue状態を確認してからGo replicaを1で開始する。bootstrap、connector runtime、CLIは最後に切り替える。

監視query例:

```sql
SELECT status, count(*), min(available_at), max(attempt_count)
FROM feedback.connector_delivery_queue GROUP BY status ORDER BY status;

SELECT status, count(*), min(created_at), max(created_at)
FROM feedback.export_jobs GROUP BY status ORDER BY status;

SELECT status, kind, count(*), min(scheduled_for), max(attempt_count)
FROM feedback.backup_runs GROUP BY status, kind ORDER BY status, kind;

SELECT action, outcome, count(*)
FROM feedback.audit_logs
WHERE occurred_at >= now() - interval '15 minutes'
GROUP BY action, outcome ORDER BY action, outcome;
```

claim後に停止した処理を手動でpendingへ書き戻さない。実装済みstale lease/retryに回収させ、回収時刻と重複の有無を
記録する。

## 即時rollback

認可越境、監査欠落、データ欠落、backup checksum不一致、回復しないqueue lag、継続的なerror/latency基準超過で
即時rollbackする。

1. 対象workspaceのgateway mappingをKotlinへ戻す。
2. 対象Go worker replicaを0へする。
3. processing leaseの期限とidempotency/connector delivery IDを確認する。
4. Kotlin workerを1 replicaで再開し、backlogが単調減少することを確認する。
5. DB migrationはrollbackしない。V6は両実装互換であり、V7は観察期間完了まで禁止する。
6. Go/Kotlinのaudit、journal、outbox、queue、backup cursorを比較し、片残りと重複確定処理を記録する。

Kotlin起動時にFlyway checksum mismatchが出た場合はmigration tableをrepairしない。選択したimageが既存環境の
V1〜V6 checksumを持つrollback imageか確認し、正しいdigestへ戻す。

現在の正本はGo-onlyである。ComposeがGo imageを選ぶことは次で検証する。

```bash
FEEDBACK_SERVICE_DOCKERFILE=apps/feedback-service-go/Dockerfile \
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
```

Kotlin撤去前には、同一V6 DB/Object StorageでGoからKotlinへAPIとworkerをroleごとに排他的に戻すローカル演習を実行した。既定で
notification、export、retention、APIの順に、対象Go process停止後に同じroleのKotlin processを開始する。Go API稼働中の
Kotlin worker処理に続き、Kotlin APIから既存sessionを読み、新規message、notification、export、retentionを検証する。process停止中に
PostgreSQLを隔離DBへ、Evidence/Exportを隔離bucketへrestoreし、Go schema fingerprint、DB data、全object SHA-256も照合する。

現在のGo-only sourceからこのKotlin演習は再実行しない。将来、稼働済みKotlin環境をin-place移行するときだけ、切替元の
checksumを持つ保存済みimage digestを用意し、同じ手順を別の移行作業として再実行する。

この演習はmigration checksum、roleごとのprocess排他、業務read/write、3 workerの回復境界、restore手順を検証する。gatewayの
workspace sticky routing、production replica、対象環境から実際に取得したbackupのrestoreの代替にはしない。

## HTTP p95比較

Kotlin/Goへ同じsnapshotとresource limitを割り当てた隔離replicaを用意し、同じread-only fixtureを交互に測定する。
本番write trafficのmirrorや、異なるworkspace/DBを使った数値は比較証跡にしない。Bearer tokenは承認済みIdPから短時間だけ
発行し、shell履歴やJSONへ書かない。

```bash
mkdir -p <change-record-directory>/feedback-canary
read -r -s FEEDBACK_CANARY_BEARER_TOKEN
export FEEDBACK_CANARY_BEARER_TOKEN
scripts/measure-feedback-canary.sh \
  --kotlin-url https://feedback-kotlin.example/feedback/v1 \
  --go-url https://feedback-go.example/feedback/v1 \
  --path '/sessions?applicationKey=fixture&environmentKey=canary&externalWorkspaceKey=fixture&limit=50' \
  --samples 1000 --concurrency 16 --warmup 50 \
  --output <change-record-directory>/feedback-canary/sessions.json
unset FEEDBACK_CANARY_BEARER_TOKEN
sha256sum <change-record-directory>/feedback-canary/sessions.json
```

scriptはKotlin/Goの実行順をbatchごとに反転し、全sampleのstatus/latency、p50/p95/p99、transport error、比較率を
単一JSONへ残す。既定ではerror 0件かつGo p95がKotlin比10%以内の場合だけ成功する。`--allow-http`と基準値変更は
局所harness検証専用とし、canaryの合格証跡には使わない。代表GETを複数測定する場合はendpointごとに新しいJSONを作り、
すべて既定基準を通す。

2026-08-10のローカル事前測定では、同じsourceからcloneしたDB/Object Storageと1 CPU/512MiBを使い、3 endpointを
各実装1,000 sampleで比較した。計6,000 requestのerrorは0で、Go p95はsession一覧29.84%、capabilities 53.69%、
session詳細32.07%短かった。peak RSSはKotlin 209,388KiB、Go 34,112KiBだった。これはharnessとrelease候補の局所合格であり、
production replicaの変更記録では同じcommandを再実行する。

## fault soak

Go-only抽出物では、専用PostgreSQLに対するparallel claim、stale lease回収、idempotency replay、backup cursorを反復し、
定期的にDBを再起動した後の次反復まで検証する。

```bash
scripts/soak-feedback-go.sh --duration 24h --interval-seconds 30 --fault-every 20 \
  --output <change-record-directory>/feedback-go-soak-24h.json
```

summaryと同じprefixのJSONL/test logを保存し、summary内のSHA-256と照合する。稼働済み環境のin-place移行では短縮実行を
24時間acceptanceの代替にしない。未投入環境の初回導入では、DB再起動後を含む短縮実行をrelease証跡としてよいが、
省略判断、実時間、反復数、再起動数、不変条件件数を変更記録へ明記する。

## 観察証跡

開始/終了時刻、workspace集合、各role owner、image digest、V6 query、backup/restore checksum、error/p95、queue lag、
delivery failure、retention削除数、audit件数、rollback演習結果を1つの変更記録へ残す。稼働済み環境のin-place移行では
全traffic移行後14日間かつfull backup 2周期を完了するまでKotlin撤去、Go default化、V7適用を行わない。未投入環境では
長時間観察をpost-deploy確認へ移し、blocking gateの合格後にGo-only化してよい。
