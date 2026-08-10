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
配備する。台帳はappend-onlyで、起動時に行単位で走査して直近100,000件だけをmemoryへ保持する。不正UUIDまたは
200 bytes超の行は起動失敗とし、破損volumeを保全して調査する。notification workerからは内部HTTPSとhost allowlistだけを
許可し、connector healthと配送履歴を監視する。

Go imageはUID/GID 65532、read-only root filesystem、capability全drop、権限昇格禁止で起動する。`/tmp`は
noexec/nosuid/nodevの一時mountとし、Evidence/Export/connector台帳とbackup pull destinationは明示volumeへ分離する。
role別egressは`canary-and-rollback.md`の許可先以外をdenyする。

Go/Kotlin切替期間のworkspace sticky routing、worker ownership、V7凍結、rollback条件は
[`canary-and-rollback.md`](canary-and-rollback.md)を使う。

旧consumer snapshotを取り込む場合だけ`feedback-legacy-migration`をone-shotで実行する。CLIは本体のV6 handoffを
先に検証し、`feedback_migration` schemaと専用Flyway履歴を初回だけtransaction作成する。fresh installの収束済みV1と
既存環境のV1〜V6はどちらも論理V6として受理するが、部分適用、checksum差分、V7以降のDBは拒否する。
専用journalは本体clean baseline、API、workerから作成せず、copy runの監査証跡として保持する。
