# フィードバックシステム分離 実装状況

設計判断と全体計画は
[`feedback-system-portability-review.md`](feedback-system-portability-review.md) を参照する。
この文書は段階移行中の実装済み境界と、まだ切り替えていない境界を明示する。

## 実装済み

- `contracts/feedback/openapi.yaml`: GIS・業務 API を含まない `/feedback/v1` 専用契約
- `contracts/feedback/schemas`: application manifest、location、target、webhook の JSON Schema
- `@feedback/contracts`: 専用 OpenAPI だけから生成するTypeScript型とschema/version定数
- `@feedback/core`: manifest/location/target validator、HostAdapter、transport、capabilities 交渉、
  401 single-flight refresh、Problem Details、ETag、Idempotency-Key
- `@feedback/react`: Service 障害をホスト画面から隔離する Provider/ErrorBoundary、locale、feature flag、portal 境界
- `@feedback/maplibre`: runtime source/feature ID をホストの安定 key へ変換する任意 adapter
- Web GIS consumer 1: `screenDefinitions` から v1 application manifest を生成し、旧 SDK route も同じ正本から派生
- 品質ゲート: 専用 OpenAPI lint、生成型 drift、JSON Schema fixture、package dependency 境界、`npm pack` 内容検査
- `apps/feedback-service-go`: Web GIS APIと別のGo application、専用distroless image、専用`feedback` migration history
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
  evidence/audit/outbox を写し、ID、display number、SHA-256、個別の evidence expiry を維持する。GIS側の
  `feedback_migration` schema/Flyway履歴だけを使用し、対象Feedback schema version 6以外は拒否する
- `apps/feedback-conformance-consumer`: native History router、在庫・承認画面、mock token exchange、site workspace を
  使う consumer 2。Web GIS 固有依存なしで投稿、DOM pin、deep link、workspace state 分離を検証する
- 互換 matrix、upgrade、operations、security guide と consumer 2 fail-closed dependency guard
- tenant/principal/IP rate limit、環境別 issuer allowlist、監査 mask、request ID の監査/log/outbox 相関、
  readiness の必須/任意依存分離、Prometheus 形式の運用 metric、SDK capture/post/unavailable telemetry
- allowlistからGo-only独立repository形状を作る `assemble-feedback-repository` とclean抽出ゲート、
  standalone package/lockfile/compose、PostgreSQL 16 + MinIO + local OIDCの自己完結構成
- 言語非依存token exchange OpenAPI/JWT schema、mTLS client別scope上限、300秒以内のJWT/JWKSを提供する
  reference broker、署名付きHttpOnly fixture sessionを検証してbrokerを呼ぶconsumer host endpoint
- Exportのlocal/S3共通storage adapter化と、DB/Evidence/Exportを分けたreadiness
- `apps/feedback-service-go`: OpenAPI 42 operation、OIDC/token exchange、認可・監査、session/thread/message、
  evidence、export/backup/retention、notification/connector、membershipを実装したGo 1.26.5 backend
- GoのAPI、notification/export/retention worker、bootstrap、connector register/runtime、backup pull、
  legacy migration、one-shot migratorを単一静的binaryの10 entrypointとして提供
- Kotlin/Flyway V6からGo migratorへ履歴形状とcanonical schema fingerprintでfail-closedにhandoffする境界。
  通常upgradeと旧consumer移行台帳を除くclean fresh baselineは別の固定fingerprintで厳密に識別する
- Kotlin/GoのOpenAPI 42 request differential、PostgreSQL/MinIO実体統合、Go standalone E2E、
  fuzz/staticcheck/govulncheckを品質ゲートへ追加
- server用linux/amd64・linux/arm64とCLI用darwin/arm64・windows/amd64 binary、multi-arch OCI、
  CycloneDX SBOM、release manifest、SHA256SUMSを生成する
  `build-feedback-go-release.sh` とnightly artifact job
- workspace sticky routing、worker role排他切替、V7凍結、rollback、14日/2 full backup観察を定めたGo canary runbook
- Kotlin/JDK/Gradleを含めず、空DB用clean V1をGo migratorへ埋め込む`--go-only`抽出形状。JDKなしのGo/Node/package/
  Compose/全container smokeを独立CI jobで検証する
- 同一clone・同一resource limitのKotlin/Go性能比較、ローカルworkspace sticky routing/rollback、PostgreSQL再起動を含む
  24時間lease/cursor/idempotency soak harness

## 互換期間として意図的に残しているもの

- `@web-gis/feedback-plugin` と `/api/review-*`・`/api/threads/*` は consumer 1 の旧 API 互換層
- Web GIS はビルド時 flag で `legacy` / read fallback 付き v1 / v1 の順に切り替えられ、既定は `legacy`
- consumer 1 はまだ `apps/api` の review table (`projects/users` と同じ DB・Flyway history) を読み書きする
- legacy mode の管理 UI、browser CSV export、通知 adapter は rollback 用に `apps/web` / `apps/api` に残る
- `API_ROUTE_MODE=review-sidecar` は独立 Service ではなく route profile のまま

これらを新 package へ見せないため、`scripts/check-feedback-contracts.sh` が
`@web-gis`、`apps/api/openapi.yaml`、`projectId` の混入と React/MapLibre の逆依存を fail-closed で検査する。

## 導入後の非blocking確認

- 実ホストbackendへのsession検証実装の移植、実PKI/client policy、実OIDC issuerを使うbroker deployment
- npm互換registry/OCI registryの作成と、同一version/tag artifactのpublish
- 本番相当環境でのworkspace単位Go canary、worker role排他切替、gateway rollback、対象環境backupのrestore演習
- 24時間相当の継続fault観察と、14日間かつ2回以上のfull backup観察

Go移行Phase 0〜8の初回導入blocking gateは完了した。Feedback ServiceはGo-onlyで、Kotlin/JDK/Gradleを実行・ビルド要件から
除去済みである。短縮faultは2時間15分、228反復、DB再起動11回、異常0だった。実データcopy、旧APIのread-only化、traffic切替、
旧DB/objectの削除、remote repository/registry/実consumerへの公開は未実施であり、外部依存文書の個別承認後に行う。
