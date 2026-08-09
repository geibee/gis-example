# 運用

API、notification worker、export worker、retention worker、bootstrapは同じService imageの別commandで起動する。
DB、Evidence storage、Export storageは必須依存で、`/health/ready` が個別状態を報告する。notification backlogは
API readinessを落とさないが、metricとalertで追跡する。

EvidenceとExportはlocal/S3共通interfaceを使い、分散配備ではS3を選ぶ。downloadは認可付きAPIだけを経由し、
bucketを公開しない。workerのclaim/retryを維持し、複数instanceの同時処理は小さく始める。

自動backupは日次フルと時間差分の証跡ZIPであり、DBのPITRを置き換えない。最終成功、変更・監査cursor、
checksum、失敗run、orphan cleanupを監視する。共有ファイルサーバへの配置はclient credentialsを使う
`feedback-backup-pull`を組織側スケジューラから実行し、SMB/NFS資格情報をServiceへ渡さない。

Webhook、Teams、Slack、SMTP Mailのconnector runtimeはproviderごとの別プロセス・別secret・別delivery ID台帳で
配備する。notification workerからは内部HTTPSとhost allowlistだけを許可し、connector healthと配送履歴を監視する。
