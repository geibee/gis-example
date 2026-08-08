# Feedback SDK / Service セキュリティガイド

- OIDC は issuer/audience/signature/expiry を検証する。異なる認証基盤では、HttpOnly host session を検証する
  broker が短寿命・feedback audience 限定 token を発行する。業務 API token、任意の user/role header は信用しない。
- JIT user 作成と membership 付与を分離し、未知 user/workspace は既定 deny とする。resource ID 経由の
  cross-workspace access は 404、permission 不足は 403 とする。
- location は manifest の route と parameter policy に照合し、生 URL を保存しない。token、メール、自由検索値は
  discard/hash を既定候補とする。
- evidence は content type/magic/size/SHA-256 を検査して private storage に置き、認可 API だけで読む。
  SDK capture は `data-feedback-exclude` / `data-feedback-mask` を使い、失敗時はコメントのみ投稿できる。
- webhook は HMAC 署名、retry、SSRF private/local deny を使い、本文/evidence URL は明示 opt-in まで含めない。
- Export は server job、認可付き期限内 download、spreadsheet formula injection 対策を使う。
- browser CSP は Feedback Service の `connect-src`、必要時だけ evidence preview の `img-src blob:` を許可する。
  package は inline secret/credential を含めず、Admin Console の `VITE_*` に secret を置かない。
- audit は allow/deny/mutate/evidence read/export を追記専用で記録し、password/token/secret/body/evidence を mask、
  巨大値を hash 要約する。

依存更新時は lockfile audit、SBOM、gitleaks、container scan を nightly で確認する。脆弱性を自動 `--force` 更新せず、
互換試験と影響範囲を確認して更新する。実 penetration test、外部 IdP/webhook/bucket 接続は個別承認対象である。
