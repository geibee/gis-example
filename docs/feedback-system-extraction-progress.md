# フィードバックシステム分離 実装状況

設計判断と全体計画は
[`feedback-system-portability-review.md`](feedback-system-portability-review.md) を参照する。
この文書は段階移行中の実装済み境界と、まだ切り替えていない境界を明示する。

## 実装済み

- `contracts/feedback/openapi.yaml`: GIS・業務 API を含まない `/feedback/v1` 専用契約
- `contracts/feedback/schemas`: application manifest、location、target、webhook の JSON Schema
- `@feedback/contracts`: 専用 OpenAPI だけから生成する型と schema/version 定数
- `@feedback/core`: manifest/location/target validator、HostAdapter、transport、capabilities 交渉、
  401 single-flight refresh、Problem Details、ETag、Idempotency-Key
- `@feedback/react`: Service 障害をホスト画面から隔離する Provider/ErrorBoundary、locale、feature flag、portal 境界
- `@feedback/maplibre`: runtime source/feature ID をホストの安定 key へ変換する任意 adapter
- Web GIS consumer 1: `screenDefinitions` から v1 application manifest を生成し、旧 SDK route も同じ正本から派生
- 品質ゲート: 専用 OpenAPI lint、生成型 drift、JSON Schema fixture、package dependency 境界、`npm pack` 内容検査

## 互換期間として意図的に残しているもの

- `@web-gis/feedback-plugin` と `/api/review-*`・`/api/threads/*` は consumer 1 の旧 API 互換層
- `apps/api` の review table は Web GIS の `projects/users` と同じ DB・Flyway history を利用する
- 管理 UI、browser CSV export、通知 adapter は `apps/web` / `apps/api` に残る
- `API_ROUTE_MODE=review-sidecar` は独立 Service ではなく route profile のまま

これらを新 package へ見せないため、`scripts/check-feedback-contracts.sh` が
`@web-gis`、`apps/api/openapi.yaml`、`projectId` の混入と React/MapLibre の逆依存を fail-closed で検査する。

## 次の段階

Phase 2 では Kotlin の独立 application と専用 Flyway history を追加する。空 PostgreSQL で起動し、
PostGIS、`app.projects`、`app.users`、Web GIS OIDC audience を要求しないことを統合試験で保証する。
その実装が完了するまでは、現行 DB の外部キー削除・旧 API の write 停止・データ移行を行わない。
