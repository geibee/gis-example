# Go migration

Kotlin/Flywayが適用していたV6をhandoff境界とし、Go migratorが所有するversioned migrationはV7から開始する。
Kotlin撤去後も既存履歴のchecksumを検証できるよう、適用済みV1〜V6は`migrations/flyway-v1-v6`へ読取専用で保存する。
fresh installの正本はV1〜V6を収束し、旧consumer移行台帳を除いた
`migrations/baseline/V1__feedback_baseline.sql`であり、Go binaryへ埋め込む。

- `feedback.go_schema_migrations` のbaseline markerと実DB fingerprintを起動前に検証する。
  Flyway V1〜V6 upgradeは `01d03a…`、旧consumer移行台帳を除いた独立repositoryのclean V1は
  `de8ba8…` とし、履歴形状に対応する値以外を拒否する。CHECK/partial indexのtext-array castは
  `pg_dump`/`pg_restore`で同値の別表記になるため、意味を残したrestore安定形へ正規化してからhashする。
- 本番API/workerは未適用migrationを検出したらfail-closedとする。
- Go-only binaryの`feedback-migrate`は、`feedback` relationも履歴もない空DBだけへ埋め込みclean V1を1 transactionで適用し、
  Flyway互換V1履歴を作る。二度目と同時起動はadvisory lock下でno-opになり、部分schema、履歴片側だけ、baseline未同梱は拒否する。
- 既存V1〜V6 DBへ埋め込みbaselineを再適用しない。既存環境では従来どおりV6 marker/fingerprintをread-only検証する。
- migrationはPostgreSQL advisory lock下でversion順に適用し、SQLのSHA-256と開始・完了状態を記録する。
- `migrations/flyway-v1-v6`は既存履歴照合専用で、編集・再生成しない。修正はGo所有の新しいversioned migrationを追加する。
