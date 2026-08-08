# Feedback Service 運用ガイド

## process と依存

HTTP API、notification worker、export worker、retention worker、bootstrap、legacy migration は同じ image の
別 command として起動する。通常 PostgreSQL と private object storage だけを要求し、PostGIS と consumer DB は
要求しない。設定値は `environment-variables.md` を正とし、secret は環境変数から注入する。

## deploy 前後

- backup/restore 手順と対象 database/bucket を人手で確認する。
- Flyway は version 順に適用し、checksum 不一致を修正 migration で回避しない。
- `/health/live`、`/health/ready`、`/feedback/v1/capabilities` を確認する。readiness の
  `database` / `storage` は必須、`notification: degraded` は API を停止しない非同期系の要調査状態として扱う。
- 内部ネットワーク限定の `/metrics` を収集する。公開 ingress では `/metrics` を遮断する。
- API error/latency、投稿成功、storage failure、outbox lag、delivery failure、export/purge backlog、tenant 使用量を監視する。
- notification/export/retention worker は claim lease と retry を利用し、同時実行数を小さく始める。
- structured log に request/tenant/application/environment/workspace/event ID を残し、本文・token・evidence を出さない。
  request ID は監査と outbox payload まで同じ値で相関する。

## incident と rollback

Service 障害時も consumer の業務画面を表示し、SDK subtree だけを unavailable にする。API release は直前 image へ
戻せるが、適用済み migration は削除せず forward fix する。copy 移行の rollback は専用 runbook を使う。
証跡/Export の object 削除失敗は orphan cleanup で再試行し、公開 URL を代替手段にしない。

実 deployment、monitoring、secret manager、backup/restore 訓練は対象環境・権限・費用・停止時間の個別承認後に行う。
