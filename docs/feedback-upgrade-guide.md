# Feedback SDK / API upgrade guide

## 同じ major 内の更新

1. `feedback-compatibility-matrix.md` で API/package/React の組を確認する。
2. lockfile 上の `@feedback/contracts`、`core`、`react`、任意の `maplibre` / `admin-react` を同じ release に揃える。
3. package tarball または承認済み registry から導入し、`npm run typecheck` と consumer conformance test を実行する。
4. manifest を validate し、追加 route の parameter を `store/hash/discard` のいずれかへ明示する。
5. dev/staging の `/capabilities`、投稿、返信、編集、resolve、evidence、deep link を確認する。
6. API を先に更新し、対応 SDK を段階配布する。問題時は直前の SDK build へ戻す。

## Web GIS の段階移行

匿名 snapshot の手順は `feedback-v1-copy-runbook.md` を使う。`feedback-v1-dual-read` でも write は v1 のみで、
旧 API への dual-write はしない。照合差分が空になるまで `feedback-v1` へ進めない。問題時は新側への追加
write がないことを確認して copy run を rollback し、consumer flag を `legacy` へ戻す。

major 更新では新旧 API path を並存させ、manifest/location/target/event の変換表、データ expand-contract、
廃止期限を別 ADR で承認する。既存 major の path や適用済み migration を上書きしない。
