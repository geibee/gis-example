# Feedback v1 コピー移行 runbook

この手順は Phase 4 の `feedback-legacy-migration` CLI を使い、旧 Web GIS のレビュー情報を
独立 Feedback Service へコピーするための境界を定める。実データの抽出・適用・切替・削除は
[`feedback-system-external-dependencies.md`](feedback-system-external-dependencies.md#8-データ移行と-consumer-2)
の人手承認対象であり、このリポジトリでは匿名 fixture のみを実行する。

## snapshot 契約

入力 JSON は `LegacyFeedbackSnapshot` と同じ形で、次を含む。

- application/environment/external workspace と manifest version
- session、scope、perspective、thread、現在 message と全 message version
- evidence の bytes、SHA-256、旧 object reference、保存期限
- feedback resource に限定した audit と notification outbox

ユーザー membership はコピーしない。Feedback Service の issuer/subject に対する membership を先に
provision し、旧ユーザー ID は履歴上の principal ID としてのみ保持する。URL は manifest に再照合し、
`store/hash/discard` policy を適用する。登録外 route、不正 target、欠落履歴、SHA 不一致は全体を失敗させる。

## 実行順序

Go releaseの`feedback-legacy-migration` entrypointをone-shotで使う。接続先とevidence storageはFeedback Serviceと
同じ環境変数を参照する。CLIは本体V6 handoffを先に検証し、専用`feedback_migration` schemaと専用Flyway履歴を
初回だけtransaction作成する。既存V1〜V6 upgradeと独立repositoryの収束済みclean V1を論理V6として区別して受理し、
履歴/fingerprint不一致、V7以降、専用schemaの部分適用、専用migration checksum差分は拒否する。

このCLIは単一Go image/binaryへ同梱するが、API/workerからは起動しない。本体clean baselineへ旧consumer台帳を含めず、
copyを実施するDBだけが専用journalを持つ。Kotlin rollback期間に旧配布物を使う場合も、同一SQL/checksumの
`feedback_migration.flyway_schema_history`を共有する。

```bash
feedback-legacy-migration dry-run --input anonymized-snapshot.json
feedback-legacy-migration apply --input anonymized-snapshot.json \
  --run-id <dry-runのrunId> --confirm-copy
feedback-legacy-migration reconcile --input anonymized-snapshot.json --run-id <runId>
```

`apply` は新 DB と新 private storage へコピーするだけで、旧 DB/object を更新・削除しない。outbox は
過去履歴として `delivered` で取り込み、通知の重複配送を起こさない。書き込み切替は別の承認作業である。

照合結果の `differences` が空であること、thread ID/display number/message history/evidence SHA-256/
保存期限を確認してから `feedback-v1-dual-read`、次に `feedback-v1` へ進める。dual-read 中も write は
新 API のみで、401/403/429 は旧 API へ fallback しない。

## rollback

```bash
feedback-legacy-migration rollback --input anonymized-snapshot.json \
  --run-id <runId> --confirm-rollback
```

rollback は reconcile を先に実行し、コピー後の session/thread/message/history/evidence に差分や追加が
あれば拒否する。成功時は台帳で当該 run に属する新側 resource と copied evidence だけを削除し、旧側には
触れない。アプリの flag は別途 `legacy` へ戻す。実データの旧 object 削除は移行完了後もこの CLI では
行わない。
