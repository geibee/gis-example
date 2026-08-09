# 運用

API、notification worker、export worker、retention worker、bootstrapは同じService imageの別commandで起動する。
DB、Evidence storage、Export storageは必須依存で、`/health/ready` が個別状態を報告する。notification backlogは
API readinessを落とさないが、metricとalertで追跡する。

EvidenceとExportはlocal/S3共通interfaceを使い、分散配備ではS3を選ぶ。downloadは認可付きAPIだけを経由し、
bucketを公開しない。workerのclaim/retryを維持し、複数instanceの同時処理は小さく始める。
