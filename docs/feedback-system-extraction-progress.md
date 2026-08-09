# フィードバックシステム分離 実装状況

設計判断と全体計画は
[`feedback-system-portability-review.md`](feedback-system-portability-review.md) を参照する。
この文書は段階移行中の実装済み境界と、まだ切り替えていない境界を明示する。

## 実装済み

- `contracts/feedback/openapi.yaml`: GIS・業務 API を含まない `/feedback/v1` 専用契約
- `contracts/feedback/schemas`: application manifest、location、target、webhook の JSON Schema
- `@feedback/contracts`: 専用 OpenAPI だけから生成する TypeScript/Kotlin 型と schema/version 定数
- `@feedback/core`: manifest/location/target validator、HostAdapter、transport、capabilities 交渉、
  401 single-flight refresh、Problem Details、ETag、Idempotency-Key
- `@feedback/react`: Service 障害をホスト画面から隔離する Provider/ErrorBoundary、locale、feature flag、portal 境界
- `@feedback/maplibre`: runtime source/feature ID をホストの安定 key へ変換する任意 adapter
- Web GIS consumer 1: `screenDefinitions` から v1 application manifest を生成し、旧 SDK route も同じ正本から派生
- 品質ゲート: 専用 OpenAPI lint、生成型 drift、JSON Schema fixture、package dependency 境界、`npm pack` 内容検査
- `apps/feedback-service`: Web GIS API と別の Ktor application、専用 Docker image、専用 `feedback` Flyway history
- 独立 DB: tenant/application/environment/workspace/membership、session/thread/message/history/evidence、
  retention、audit、idempotency、notification outbox を通常 PostgreSQL だけで管理
- 独立認証認可: feedback 専用 OIDC audience/claim mapping、別 issuer の短寿命 exchange token 検証、
  DB membership と token scope の積集合、`feedback.read/comment/manage/admin`、resource ID 経由の cross-workspace 404
- private evidence: local/S3 adapter、content-type/magic/size/count/SHA-256 検証、認可付き range read
- deployment 分離: HTTP API、HMAC 署名 notification worker、policy 競合を lock する retention/orphan worker、
  one-shot provisioning CLI を同一 image の別 command で提供
- notification endpoint の AES-256-GCM 暗号化、現行鍵/旧鍵を併用する段階的 key rotation
- backend 品質ゲート: dedicated OpenAPI と routing tree の双方向同期、全 resource route の permission/scope 宣言、
  PostGIS を含まない空 PostgreSQLへの migration、V1 schema upgrade/convergence、tenant 分離、並行更新、OIDC/CORS、
  実 HTTP request/response の JSON Schema 適合試験
- `apps/feedback-admin` / `@feedback/admin-react`: Web GIS なしで session/scope/perspective/thread/evidence、
  manifest、membership、retention、Export、通知 retry を管理する独立 Console
- 非同期 CSV/XLSX Export、private download、formula injection 対策、期限 purge
- HMAC 署名 webhook、SSRF deny、本文/evidence 既定除外、retry/dead-letter/manual retry
- Web GIS consumer 1 の `feedback-v1` / `feedback-v1-dual-read` adapter。dual-read の write は新 API のみで、
  401/403/429 を旧 API で迂回しない
- 新 `feedbackThread` と旧 `threadId` の permalink 互換 resolver、manifest 由来 deep link
- v1 利用時の Web GIS 管理 route を独立 Admin Console link へ置換
- `feedback-legacy-migration`: 匿名 snapshot の dry-run/copy/reconcile/rollback。session/thread/message/history/
  evidence/audit/outbox を写し、ID、display number、SHA-256、個別の evidence expiry を維持する
- `apps/feedback-conformance-consumer`: native History router、在庫・承認画面、mock token exchange、site workspace を
  使う consumer 2。Web GIS 固有依存なしで投稿、DOM pin、deep link、workspace state 分離を検証する
- 互換 matrix、upgrade、operations、security guide と consumer 2 fail-closed dependency guard
- tenant/principal/IP rate limit、環境別 issuer allowlist、監査 mask、request ID の監査/log/outbox 相関、
  readiness の必須/任意依存分離、Prometheus 形式の運用 metric、SDK capture/post/unavailable telemetry

## 互換期間として意図的に残しているもの

- `@web-gis/feedback-plugin` と `/api/review-*`・`/api/threads/*` は consumer 1 の旧 API 互換層
- Web GIS はビルド時 flag で `legacy` / read fallback 付き v1 / v1 の順に切り替えられ、既定は `legacy`
- consumer 1 はまだ `apps/api` の review table (`projects/users` と同じ DB・Flyway history) を読み書きする
- legacy mode の管理 UI、browser CSV export、通知 adapter は rollback 用に `apps/web` / `apps/api` に残る
- `API_ROUTE_MODE=review-sidecar` は独立 Service ではなく route profile のまま

これらを新 package へ見せないため、`scripts/check-feedback-contracts.sh` が
`@web-gis`、`apps/api/openapi.yaml`、`projectId` の混入と React/MapLibre の逆依存を fail-closed で検査する。

## Phase 2 の外部接続として残っているもの

- token exchange broker 自体のホスト session 検証・mTLS・短寿命 token 発行 (Service 側の token 検証は実装済み)

Phase 0〜5 のリポジトリ内実装は完了している。実データ copy、旧 API の read-only 化、traffic 切替、旧 DB/object
の削除、remote repository/registry/実 consumer への公開は未実施であり、外部依存文書の個別承認後に行う。
