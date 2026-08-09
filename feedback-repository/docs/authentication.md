# 認証

標準経路はFeedback audienceを持つBearer JWTの直接OIDC検証。異なる認証基盤ではホストbackendが自身の
HttpOnly sessionを検証し、mTLSで `POST /v1/exchanges` を呼ぶ。ブラウザ由来のuser/role headerをactorとして信用しない。

brokerはmTLS identityごとのtenant/application/environment/workspace/permission上限を適用し、300秒以内のJWTを発行する。
claimは `actor_issuer`、`actor_sub`、`feedback_tenant`、`feedback_application`、`feedback_environment`、
`feedback_workspace`、`feedback_permissions`。Serviceの実効権限はDB membershipとの積集合である。

契約は `contracts/feedback/token-exchange.openapi.yaml` と `schemas/token-exchange-jwt.schema.json` を正本とする。
