# フィードバック証跡バックアップ・通知コネクタ

## 自動証跡バックアップ

workspace管理者はFeedback Admin Consoleまたは`/feedback/v1/backup-policy`で自動バックアップを有効化する。
既定は`Asia/Tokyo`、日次フル02:00、60分ごとの差分、証跡画像を含む設定である。ポリシーは初期状態では
無効であり、保存日数を空にした場合、Feedback Serviceはarchiveを自動削除しない。

export workerは次を行う。

1. 投稿・返信・編集・Resolve/Reopenと同じtransactionで追記された変更journalをcursorとして使う。
2. 日次フルを差分より優先し、workspaceごとに1件だけclaimする。
3. CSV、証跡画像、各entryのSHA-256を記載した`manifest.json`をprivate object storageへ保存する。
4. object保存とDB完了が両方成功した場合だけcursorを進める。

規定回数失敗したrunは`failed`で停止し、後続runを自動作成し続けない。原因を是正して管理画面から明示的に
再試行するため、失敗の痕跡とcursorの連続性を保つ。

ZIPには`threads.csv`、`messages.csv`、`message_versions.csv`、`status_events.csv`、
`audit_logs.csv`、`evidence.csv`、`evidence/*`を含む。V5適用前に完全な変更履歴が存在しないことを隠さず、
`manifest.json.historyCoverageStartedAt`へ保証開始時点を記録する。CSVはUTF-8 BOM・CRLFで、Excel等の
数式として解釈される値を無害化する。

本機能はフィードバック証跡archiveであり、PostgreSQLの災害復旧用backupではない。DBは別途PITRを構成する。
本番bucketでは暗号化、versioning、必要に応じたObject Lock/lifecycleを組織の規程に合わせて設定する。

## 共有ファイルサーバへの搬送

`bin/feedback-backup-pull`を組織側スケジューラから実行する。CLIはOAuth 2.0 client credentialsで
短寿命tokenを取得し、未配置のarchiveをダウンロードする。ZIP全体とmanifest内の全entryを検証した後、
一時ファイルを同一ディレクトリでatomic renameする。同名の検証済みarchiveは再取得せず、remote objectは削除しない。

Feedback ServiceとCLIはSMB/NFS/SFTPの資格情報を管理しない。対象共有フォルダはOSまたは実行基盤で先に
マウントし、その明示パスを`FEEDBACK_PULL_DESTINATION_DIR`へ渡す。service principalには対象workspaceの
`feedback.manage`だけを付与する。

## 通知コネクタ

通知コネクタはFeedback Serviceと別プロセスで動作する。Feedback Serviceのnotification workerは
Connector Protocol v1の署名付きdeliveryを内部HTTPS endpointへ送り、コネクタがTeams、Slack、SMTP Mail、
任意Webhookの形式へ変換する。第三者実装は言語を問わず同じprotocolを実装できる。
private network内のendpointへ送る構成ではnotification workerに`FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK=1`を
明示し、HTTPを許可するローカルfixture用設定とは分離する。

platform operatorはconnector processを先に起動し、`bin/feedback-connector-register`でinstallationを登録する。
登録時にdescriptorを取得し、protocol version、connector key、対応eventの整合性をfail-closedで検証する。workspace管理者は管理画面で
登録済みtypeと`destinationRef`を選ぶ。`destinationRef`が指す実URL、channel、mail宛先、SMTP資格情報は
connector processだけが環境変数／Secret Managerから読み、Feedback ServiceのDB・API・ログには保存しない。

イベントは次の4種類である。

- `feedback.thread.created.v1`
- `feedback.message.created.v1`
- `feedback.thread.resolved.v1`
- `feedback.thread.reopened.v1`

配送はat-least-onceである。delivery IDを冪等キーとして扱い、408、429、5xx、通信失敗だけを指数バックオフで
再試行する。その他の4xxは恒久失敗にし、管理画面から明示的に再試行できる。本文はworkspace connectorで
許可した場合だけ送り、証跡画像、object key、token、connector secretは送らない。
connector設定を削除しても配送queueと試行履歴は物理削除せず、未配送分を失敗として確定して証跡を残す。

参照runtimeは`FEEDBACK_CONNECTOR_PROVIDER`で`webhook`、`teams`、`slack`、`smtp-mail`を選ぶ。
providerごとに`bin/feedback-connector-runtime`を独立プロセスとして起動し、delivery ID台帳用の専用永続volumeを
`FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE`へ指定する。4実装は同一のConnector Protocol v1だけを入力契約とし、
宛先ごとの資格情報やmappingを共有しない。health endpointはdescriptorの`healthPath`から登録CLIが解決する。
本番で実在する宛先への疎通確認やテスト送信を行う前に、送信データ、接続先、費用、資格情報、停止方法を
個別承認する。
