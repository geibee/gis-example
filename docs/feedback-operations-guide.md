# Feedback Service 運用ガイド

## process と依存

HTTP API、notification worker、export worker、retention worker、bootstrap は同じ image の別 commandとして起動する。
旧consumerのcopy migrationは通常processから分離した`feedback-legacy-migration` one-shot commandとして提供する。
toolの台帳とFlyway履歴は`feedback_migration` schemaに分離し、対象Serviceを論理V6へ固定する。CLIが初回だけ専用migrationを
transaction適用し、本体clean baselineやAPI/workerはこのschemaを作らない。通常 PostgreSQL とprivate object storageだけを
要求する。設定値は `environment-variables.md` を正とし、secretは環境変数から注入する。

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
  delivery ID台帳volumeの容量と永続性を監視する。台帳はappend-onlyで、起動時には直近100,000件だけをmemoryへ保持する。
  不正UUIDまたは200 bytes超の行があると安全側に起動失敗するため、復旧時は元volumeを保全して破損原因を調査する。
- Go imageはUID/GID 65532、read-only root filesystem、capability全drop、権限昇格禁止で起動する。`/tmp`は
  noexec/nosuid/nodevの一時mount、Evidence/Export/connector台帳とbackup pull destinationは用途別の明示volumeにし、
  role別egressは`feedback-go-canary-runbook.md`の許可表以外をdenyする。
- structured log に request/tenant/application/environment/workspace/event ID を残し、本文・token・evidence を出さない。
  request ID は監査と outbox payload まで同じ値で相関する。

## incident と rollback

Service 障害時も consumer の業務画面を表示し、SDK subtree だけを unavailable にする。API release は直前 image へ
戻せるが、適用済み migration は削除せず forward fix する。copy 移行の rollback は専用 runbook を使う。
証跡/Export/backupのobject削除失敗は、DB側の論理purge後にgrace付きorphan cleanupで再試行し、公開URLを代替手段にしない。
backup ZIPはremote側で削除せず、保存期限を設定したworkspaceだけretention workerが削除する。

実 deployment、monitoring、secret manager、backup/restore 訓練は対象環境・権限・費用・停止時間の個別承認後に行う。
Go版への段階切替とrole別rollbackは [`feedback-go-canary-runbook.md`](feedback-go-canary-runbook.md) を使う。
