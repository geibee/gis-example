# Feedback consumer 2 conformance fixture

Web GIS とは異なる在庫・承認 SPA を模した repository-local fixture。次の境界を継続検証する。

- React 18 と native History API router（TanStack Router 非依存）
- URL の site key を `externalWorkspaceKey` にする workspace 解決
- OIDC token の転送ではなく、HttpOnly host session を前提とする短寿命 token exchange adapter
- `inventory.list` / `inventory.item` / `approval.request` の独自 manifest
- 英語 message catalog、DOM pin、投稿、deep link、workspace 切替時の state 分離
- `access_token` query の discard と `data-feedback-mask` による画面内機微値の保護
- MapLibre を導入しない consumer でも `@feedback/react` が利用できること

`npm --workspace @feedback/conformance-consumer run test` は API と broker を in-memory mock にして完結する。
standalone composeでは同梱host endpointが署名付きHttpOnly fixture sessionを検証し、client証明書で
reference brokerを呼ぶ。actorはsessionからだけ取得し、ブラウザが送るuser/role headerは使用しない。
業務画面はtoken取得より先に描画されるため、Feedback Service停止中もFeedback subtreeだけがunavailableになる。
