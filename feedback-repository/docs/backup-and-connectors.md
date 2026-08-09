# 証跡バックアップと通知コネクタ

workspaceの自動backupは既定で無効である。管理者が有効化すると、Asia/Tokyoの日次02:00フルと60分差分を
private object storageへ一意なZIPとして保存する。ZIPにはthread、message全版、状態変更、監査ログ、evidence
metadataと画像、各entryのSHA-256を持つmanifestを含む。V5以前を推測せず、manifestに履歴保証開始時点を記録する。
保存期間未設定ではServiceは削除しない。DB自体には別途PITRを構成する。

`feedback-backup-pull`は`feedback.manage`のservice principalで一覧・download APIだけを使い、ZIPと全entryの
checksumを検証してからマウント済み共有フォルダへatomic renameする。検証済み同名ファイルはskipし、remoteは
削除しない。SMB/NFS/SFTP接続と世代管理は組織側の責務である。

通知はFeedback Serviceから外部SaaSへ直接送らない。platform operatorが
`feedback-connector-register`でConnector Protocol v1の別プロセスを登録し、workspace管理者がtypeと
`destinationRef`だけを選ぶ。Webhook、Teams、Slack、SMTP Mailは`feedback-connector-runtime`をprovider別に
起動する。外部URL、channel、mail宛先、SMTP資格情報はruntimeだけが保持する。

deliveryはtimestamp付きHMAC、delivery ID、内部HTTPS、host allowlistを検証し、at-least-onceである。
connectorはdelivery IDを永続的に冪等化する。408、429、5xx、通信失敗だけを自動再試行し、他の4xxは管理画面から
明示再試行する。本文はconnector設定で許可した場合だけ送り、evidence、object key、token、secretは送らない。
旧単一Webhook APIはdeprecated compatibility adapterとして残り、登録時にWebhook connectorへbackfillする。
