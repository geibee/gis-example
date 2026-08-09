# Feedback token broker reference

異なる認証基盤を持つホストbackend向けの参照実装。TLS handshakeで検証したclient証明書の
fingerprintまたはsubject CNを `FEEDBACK_BROKER_CLIENT_POLICIES_FILE` のallowlistへ照合し、
tenant/application/environment/workspace/permissionの上限内だけで300秒以内のFeedback audience JWTを発行する。

ブラウザから直接呼ばない。`actor_issuer` / `actor_sub` はホストbackendがHttpOnly session等を検証してから送る。
公開契約は `contracts/feedback/token-exchange.openapi.yaml` と
`contracts/feedback/schemas/token-exchange-jwt.schema.json` を参照する。
