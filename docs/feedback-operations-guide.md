# Feedback Service 運用ガイド

## process と依存

HTTP API、notification worker、export worker、retention worker、bootstrap は同じ image の別 commandとして起動する。
旧consumerのcopy migrationはホスト側の専用toolとして保持し、独立Service imageへ含めない。toolの台帳とFlyway履歴は
`feedback_migration` schemaに分離し、対象Service schema versionを固定する。通常 PostgreSQL と
private object storageだけを要求する。設定値は `environment-variables.md` を正とし、secretは環境変数から注入する。

## deploy 前後

- backup/restore 手順と対象 database/bucket を人手で確認する。
- Flyway は version 順に適用し、checksum 不一致を修正 migration で回避しない。
- `/health/live`、`/health/ready`、`/feedback/v1/capabilities` を確認する。readiness の
  `database` / `evidenceStorage` / `exportStorage` は必須、`notification: degraded` はAPIを停止しない
  非同期系の要調査状態として扱う。
- 内部ネットワーク限定の `/metrics` を収集する。公開 ingress では `/metrics` を遮断する。
- API error/latency、投稿成功、storage failure、outbox lag、delivery failure、export/purge backlog、tenant 使用量を監視する。
- notification/export/retention worker は claim lease と retry を利用し、同時実行数を小さく始める。export workerは
  通常exportと自動backupを同じloopで処理するため、Evidence/Export両storageへの権限を持たせる。
- 自動backupの最終成功時刻、差分cursor、archive checksum、共有サーバ搬送CLIの終了状態を監視する。
- connector processはproviderごとの別タスク・最小権限・送信先allowlistで配備し、delivery backlog、health、
  delivery ID台帳volumeの容量と永続性を監視する。
- structured log に request/tenant/application/environment/workspace/event ID を残し、本文・token・evidence を出さない。
  request ID は監査と outbox payload まで同じ値で相関する。

## incident と rollback

Service 障害時も consumer の業務画面を表示し、SDK subtree だけを unavailable にする。API release は直前 image へ
戻せるが、適用済み migration は削除せず forward fix する。copy 移行の rollback は専用 runbook を使う。
証跡/Export の object 削除失敗は orphan cleanup で再試行し、公開 URL を代替手段にしない。
backup ZIPはremote側で削除せず、保存期限を設定したworkspaceだけretention workerが削除する。

実 deployment、monitoring、secret manager、backup/restore 訓練は対象環境・権限・費用・停止時間の個別承認後に行う。
