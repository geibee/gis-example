# Feedback Platform 改善・独立化プラン

## 1. 目的

`geibee/gis-example` に実装したフィードバック収集機能を、GIS固有機能から切り離し、任意のWebアプリケーションへ低負荷・低侵襲で組み込める独立した Feedback Platform として再設計する。

本改善では以下を実現する。

- フロントエンドはフレームワーク非依存のSDKを中心に提供する
- React等の主要フレームワーク向けbindingを追加提供する
- UIの最低共通実装としてWeb Componentを提供する
- バックエンドSDKは提供せず、HTTP/OpenAPIを製品境界とする
- アプリケーションとのバックエンド統合はGo製Sidecarを推奨方式とする
- Feedback ServerもGoへ移行し、軽量な単一バイナリ/コンテナとして提供する
- GIS、MapLibre等のアプリ固有連携はAdapter/Pluginとして分離する
- 閉域・公共部門を含むオンプレミス/顧客環境への配備を可能にする

---

## 2. 基本方針

### 2.1 製品境界

Feedback Platformの本質的な製品境界はSDKではなく、以下とする。

1. **Feedback Protocol**
   - OpenAPIで定義されたHTTP API
   - Feedback、Thread、Reply、Attachment、Review Scope等の契約を定義する

2. **Frontend Integration Contract**
   - Host ApplicationからUser / Page / Target / Review Scope等を取得するAdapter Interface

3. **Deployment Contract**
   - Sidecar / Serverの設定、認証、ヘルスチェック、可観測性等の運用契約

SDKやReact bindingはこれらを利用しやすくするための実装であり、製品の中心契約にはしない。

---

## 3. 目標アーキテクチャ

```text
┌──────────────────────────────────────────────┐
│ Host Web Application                         │
│                                              │
│ Business UI                                  │
│    │                                         │
│    ├─ Host Adapter                           │
│    │    ├ User Context                       │
│    │    ├ Page Context                       │
│    │    ├ Target Context                     │
│    │    └ Review Scope                       │
│    │                                         │
│    └─ Feedback Frontend                      │
│         ├ @feedback/core                     │
│         ├ @feedback/web-component            │
│         ├ @feedback/react        (optional)  │
│         └ @feedback/*-adapter    (optional)  │
└───────────────────┬──────────────────────────┘
                    │ same-origin HTTP
                    ▼
┌──────────────────────────────────────────────┐
│ feedback-sidecar (Go)                        │
│                                              │
│ - Host identity受領                          │
│ - Feedback用identity/token変換               │
│ - application/tenant context付与             │
│ - CSRF / rate limit                          │
│ - request validation                         │
│ - audit / trace context                      │
│ - attachment proxy                          │
└───────────────────┬──────────────────────────┘
                    │ Feedback Protocol
                    ▼
┌──────────────────────────────────────────────┐
│ feedback-server (Go)                         │
│                                              │
│ - Feedback / Thread / Reply                  │
│ - Review Scope                               │
│ - Anchor metadata                            │
│ - Attachment metadata                        │
│ - Notification                              │
│ - Retention / Export                         │
│ - Administration API                         │
└───────────────┬──────────────────┬───────────┘
                │                  │
          PostgreSQL         Object Storage
```

---

## 4. Go移行方針

### 4.1 対象

原則として現在の `apps/feedback-service` の責務をGoへ移行する。

対象例:

- API Server
- Authentication / Authorization
- Feedback CRUD
- Thread / Reply
- Review Scope
- Attachment metadata
- Notification processing
- Retention worker
- Export worker
- Bootstrap / migration処理

### 4.2 Goを採用する理由

今回のFeedback機能は、複雑な業務ドメインを表現することよりも、任意システムへ容易に組み込み・配布・運用できることの価値が大きい。

Go化によって以下を狙う。

- JVM不要の単一バイナリ配布
- 小さいコンテナイメージ
- 高速起動
- メモリ使用量削減
- Sidecarとしての導入容易性
- クロスコンパイル
- 依存ライブラリ/runtime管理の単純化
- systemd、Docker、Kubernetes等への展開容易性

### 4.3 避けること

Go移行時にKotlin実装を1対1で翻訳しない。

現在のサービス境界・worker構成を再評価し、以下の単位で責務を再構成する。

```text
cmd/
  feedback-server/
  feedback-sidecar/
  feedback-worker/       # 必要なら統合worker
  feedback-migrate/

internal/
  feedback/
  thread/
  review/
  anchor/
  attachment/
  identity/
  notification/
  retention/
  export/
  persistence/
  transport/
```

初期段階では過剰なClean Architecture化はせず、明確なパッケージ境界とdependency directionを維持する。

---

## 5. フロントエンド構成

### 5.1 パッケージ構成

```text
packages/
  feedback-core/
  feedback-web-component/
  feedback-react/
  feedback-admin-react/
  feedback-maplibre/
  feedback-testing/
```

現行の `feedback-core`、`feedback-react`、`feedback-maplibre` 等の分離思想は維持する。

### 5.2 `@feedback/core`

フレームワーク非依存のHeadless SDKとする。

責務:

- Feedback API client
- Feedback / Thread状態管理
- Host Adapter Interface
- Target / Anchor生成
- Review Scope管理
- event handling
- retry/error normalization
- SDK extension point

UIは持たない。

想定API:

```ts
const feedback = createFeedback({
  endpoint: "/feedback",
  applicationId: "sales-management",
  host: {
    getUser,
    getPageContext,
    getTargetContext,
    getReviewScope,
  },
})
```

### 5.3 Host Adapter

Feedback Platformは業務アプリケーションの内部構造を理解しない。

```ts
interface HostAdapter {
  getUser(): UserContext | Promise<UserContext>
  getPageContext(): PageContext
  getTargetContext(target: EventTarget): TargetContext | null
  getReviewScope(): ReviewScope
}
```

アプリ固有情報はすべてAdapterで変換する。

例:

通常Webアプリ:

```json
{
  "type": "element",
  "route": "/orders/123",
  "stableId": "delivery-date"
}
```

GIS:

```json
{
  "type": "map-feature",
  "layer": "road",
  "featureId": "12345"
}
```

### 5.4 UI提供方法

#### 標準

Web Componentを提供する。

```html
<feedback-widget
  application-id="sample-app"
  endpoint="/feedback">
</feedback-widget>
```

メリット:

- React/Vue/Angular/Svelte/Vanilla JSから利用可能
- Shadow DOMによりCSS干渉を抑制
- 既存システムにも導入しやすい

#### React

React利用者向けには薄いbindingを提供する。

```tsx
<FeedbackProvider client={feedback}>
  <App />
  <FeedbackWidget />
</FeedbackProvider>
```

React固有の状態管理・業務ロジックは持ち込まない。

---

## 6. コメント対象位置のAnchor設計

汎用化において最重要論点の一つとする。

DOM selectorや座標だけを永続化すると、画面変更によってコメント位置が失われるため、Anchorは複数情報を組み合わせる。

推奨モデル:

```json
{
  "targetType": "element",
  "stableId": "order.delivery-date",
  "route": "/orders/:id",
  "entity": {
    "type": "order",
    "id": "123"
  },
  "fallback": {
    "cssSelector": "...",
    "textQuote": "...",
    "boundingBox": {}
  }
}
```

優先順位:

1. Host Applicationが提供するstableId
2. 業務entity identifier
3. Plugin固有identifier
4. CSS selector / text / geometry等のfallback

Feedback Platform側でDOM構造そのものを業務IDとして扱わない。

---

## 7. Review Scope設計

レビュー対象とレビュー観点を明示的なモデルとして扱う。

例:

```json
{
  "scopeId": "prototype-2026-08",
  "areas": [
    {
      "id": "order-list",
      "enabled": true,
      "dimensions": {
        "business-flow": true,
        "wording": true,
        "visual-design": false,
        "performance": false
      }
    }
  ]
}
```

これにより以下を可能にする。

- 現在レビュー対象かどうかを画面上で表現
- 将来レビューする観点をdisabled状態で表示
- コメント時にレビュー観点を選択
- フェーズ単位で対象範囲を変更
- 「今回レビューしてほしくない内容」へのコメントをUI上で抑制
- 集計時にレビュー観点別に分析

Review ScopeはHost Application内部にハードコードせず、Feedback Serverから取得できるようにする。

---

## 8. Sidecar設計

### 8.1 Sidecarを推奨統合方式とする

バックエンドSDKは提供しない。

Host ApplicationはFeedback Protocolを直接呼び出してもよいが、企業システムではSidecar経由を推奨する。

### 8.2 Sidecarの責務

- same-origin endpoint提供
- Host Applicationの認証済みidentity受領
- Feedback identityへの変換
- applicationId / tenantId付与
- authorization context付与
- CSRF protection
- rate limiting
- request size制御
- trace / correlation ID
- audit metadata付与
- attachment upload proxy
- upstream timeout/retry
- Feedback Server障害時のfail-safe

### 8.3 Sidecarに持たせない責務

- Feedbackの永続化
- Thread状態管理
- Review Scopeのmaster管理
- Notification business rule
- Host Applicationの業務ロジック

Sidecarはstatelessを原則とする。

---

## 9. 認証・認可

Feedback Serverが各Host Applicationの認証方式を理解する設計は禁止する。

対応すべきHost認証方式例:

- Entra ID
- Keycloak
- Cognito
- Session Cookie
- 独自JWT
- reverse proxy authentication

これらはHost/Sidecar境界で吸収する。

### 推奨trust boundary

```text
Browser
  ↓
Host Application / Reverse Proxy
  ↓ authenticated user context
Feedback Sidecar
  ↓ platform identity
Feedback Server
```

Feedback Serverが扱うidentityは共通形式とする。

```json
{
  "subject": "user-123",
  "displayName": "User A",
  "applicationId": "sales-management",
  "tenantId": "tenant-a",
  "roles": ["reviewer"]
}
```

ユーザー表示名等をクライアントから無条件に信用しない。

---

## 10. Feedback Protocol / API設計

OpenAPIをSSoTとする。

主なresource:

```text
/applications
/review-scopes
/feedback
/feedback/{id}
/feedback/{id}/replies
/feedback/{id}/attachments
/feedback/{id}/status
/targets
/exports
```

Feedbackモデル例:

```json
{
  "id": "...",
  "applicationId": "...",
  "reviewScopeId": "...",
  "target": {},
  "dimension": "business-flow",
  "body": "...",
  "status": "open",
  "author": {},
  "createdAt": "..."
}
```

API設計上、UI都合のDTOと永続モデルを直接一致させない。

---

## 11. データ所有・保持

Feedback Platformを複数システムで利用する場合、データ境界を明示する。

最低限以下をキーとして管理する。

```text
tenant
  └ application
      └ review scope
          └ feedback
```

設定可能とする項目:

- retention period
- attachment retention
- logical delete / physical delete
- export policy
- audit retention
- personal information handling
- maximum attachment size
- allowed MIME types

公共部門・閉域利用を考慮し、外部SaaS依存を必須としない。

---

## 12. 添付ファイル

添付ファイル本体をRDBへ格納しない。

```text
PostgreSQL
  └ attachment metadata

S3-compatible Object Storage
  └ actual object
```

S3互換APIを前提とすることで以下へ対応可能とする。

- AWS S3
- MinIO
- Azure等のAdapter実装
- オンプレミスS3互換storage

ウイルススキャン連携用hookを用意する。

---

## 13. Notification / Worker

既存の複数workerはGo移行時に統合可能性を評価する。

初期案:

```text
feedback-server
feedback-worker
```

程度まで単純化する。

worker内でjob typeを分ける。

```text
notification
retention
export
attachment-cleanup
```

ジョブ量が増えた場合のみ個別分離する。

最初からマイクロサービス化しない。

---

## 14. Admin UI

Feedback Adminは独立アプリケーションとして維持する。

責務:

- Feedback一覧
- Thread確認
- Status変更
- Review Scope設定
- Review dimension設定
- Application設定
- Export
- Retention設定
- Reviewer/Administrator権限管理

Admin UIからHost Application内部の業務データを直接更新しない。

必要ならHost Applicationへのlink/deep linkだけ保持する。

---

## 15. 配布モデル

### Level 1: SaaS / Central Server

```text
Frontend SDK
      ↓
Central Feedback Server
```

PoC・小規模利用向け。

### Level 2: Enterprise推奨

```text
Frontend SDK
      ↓
Feedback Sidecar
      ↓
Central Feedback Server
```

認証・same-origin・企業NW境界を吸収する。

### Level 3: Private Deployment

```text
Frontend SDK
Feedback Sidecar
Feedback Server
PostgreSQL
Object Storage
```

全コンポーネントを利用者環境へ配備。

対象:

- 公共部門
- 金融
- 閉域ネットワーク
- データ持出制限案件

---

## 16. Deployment

提供物:

```text
OCI Images
  feedback-server
  feedback-sidecar
  feedback-worker

Binary
  Linux amd64
  Linux arm64
  Windows amd64
  macOS arm64   # local development用途

Helm Chart

Docker Compose

Example manifests
```

Sidecar導入例:

```yaml
containers:
  - name: application
    image: example-app

  - name: feedback-sidecar
    image: feedback/sidecar
    env:
      - name: FEEDBACK_SERVER
        value: http://feedback-server
      - name: FEEDBACK_APPLICATION_ID
        value: example-app
```

---

## 17. Versioning / Compatibility

Frontend SDK、Sidecar、Serverを独立リリースするため、互換性ルールを最初から定義する。

### Protocol

```text
/api/v1/
```

破壊的変更のみmajor versionを変更する。

### Capability negotiation

必要に応じて:

```text
GET /capabilities
```

を提供する。

例:

```json
{
  "protocolVersion": "1.2",
  "features": [
    "thread",
    "review-scope",
    "attachments",
    "map-anchor"
  ]
}
```

SDKはServer versionそのものではなくcapabilityを見る。

---

## 18. Observability

Sidecar / Server共通で以下を実装する。

- structured logging
- OpenTelemetry trace
- metrics
- health endpoint
- readiness endpoint
- correlation ID

推奨endpoint:

```text
/health/live
/health/ready
/metrics
```

Feedback障害によってHost Application自体を利用不能にしない。

Frontend SDKもFeedback API失敗時は業務画面を壊さず、Feedback機能のみdegradeさせる。

---

## 19. セキュリティ

最低限以下を標準機能とする。

- CSPを考慮したFrontend SDK
- XSS sanitize
- CSRF protection
- upload MIME/type/size validation
- authorization
- tenant isolation
- rate limit
- audit log
- secrets非ログ出力
- OpenAPI schema validation
- dependency / container vulnerability scan

Feedback本文はuntrusted inputとして扱う。

HTMLを保存・描画する場合は必ずsanitizeする。

---

## 20. Repository再編

Feedback Platformを `gis-example` から独立repositoryへ切り出す。

推奨:

```text
feedback-platform/
├ contracts/
│  └ openapi/
│
├ frontend/
│  ├ core/
│  ├ web-component/
│  ├ react/
│  └ adapters/
│      └ maplibre/
│
├ backend/
│  ├ cmd/
│  │  ├ feedback-server/
│  │  ├ feedback-sidecar/
│  │  ├ feedback-worker/
│  │  └ feedback-migrate/
│  └ internal/
│
├ admin/
│
├ deploy/
│  ├ helm/
│  ├ docker/
│  └ compose/
│
├ examples/
│  ├ vanilla/
│  ├ react/
│  └ sidecar/
│
└ docs/
```

`gis-example` 側には以下のみ残す。

```text
@feedback/core
@feedback/react
@feedback/maplibre

Feedback Sidecar
```

つまり `gis-example` 自体をFeedback Platformのconsumer/reference implementationにする。

---

## 21. 移行フェーズ

### Phase 0: Contract固定

最初に現在のFeedback機能を棚卸しする。

成果物:

- Feature inventory
- OpenAPI v1
- Feedback domain model
- Host Adapter Interface
- Anchor model
- Authentication contract
- Review Scope model

ここではまだGo移行しない。

### Phase 1: Frontend境界整理

- `feedback-core` を完全にGIS非依存化
- Host Adapter確立
- MapLibre依存をadapterへ移動
- Web Component追加
- React binding薄型化
- conformance test作成

### Phase 2: Go Feedback Server

Kotlin Feedback Serviceと同じOpenAPIをGoで実装する。

優先順:

1. Feedback CRUD
2. Thread / Reply
3. Review Scope
4. Authentication
5. Attachment
6. Admin API
7. Notification
8. Retention / Export

Contract TestをKotlin版・Go版の双方に適用する。

### Phase 3: Go Sidecar

- identity forwarding
- application context
- same-origin API
- token exchange
- trace/audit
- attachment proxy
- fail-safe

を実装する。

### Phase 4: Parallel Run

```text
Frontend
  ↓
same OpenAPI
  ├ Kotlin Feedback Service
  └ Go Feedback Server
```

Contract / Integration / E2Eテストを双方で実施する。

機能差がなくなった時点でGo版をdefaultとする。

### Phase 5: GIS Exampleをconsumer化

`gis-example` からFeedback Server実装を削除し、外部Feedback Platformを利用する。

GIS固有部分は `feedback-maplibre` adapterとしてのみ残す。

### Phase 6: Kotlin版廃止

- migration確認
- data compatibility確認
- operational runbook更新
- rollback手段確認

後にKotlin `feedback-service` を廃止する。

---

## 22. テスト戦略

### Contract Test

OpenAPIを基準にServer実装を検証。

### Frontend Conformance Test

任意Host Adapterが満たすべき条件を共通test suiteとして提供する。

### E2E

最低限:

```text
Vanilla JS + Web Component
React
MapLibre
Sidecar
Direct Server
```

をテストする。

### Anchor Regression

画面変更後も既存Feedbackを可能な限り再表示できることをテストする。

例:

- DOM nesting変更
- CSS class変更
- React component変更
- route parameter変更
- Map style変更

---

## 23. 非機能目標

初期目標値として以下を置く。

### Sidecar

- stateless
- single binary
- graceful shutdown
- fast startup
- low idle memory
- Host Application障害と独立してrestart可能

### Server

- horizontal scaling可能
- DB transaction境界明確化
- object storage外部化
- workerとの責務分離
- zero-downtime migrationを考慮

### Frontend

- Feedback機能障害がHost UIへ波及しない
- framework runtimeを不要にするcore/componentを提供
- CSS isolation
- lazy load可能
- Feedback無効時のbundle/runtime影響を最小化

---

## 24. 設計上の禁止事項

以下は避ける。

1. Feedback ServerがHost ApplicationのDBへ直接アクセスする
2. Feedback ServerがHost固有認証方式を個別実装する
3. DOM selectorだけをAnchor IDとする
4. ReactをFeedback Platform必須dependencyとする
5. Backend language別SDKを大量に維持する
6. Sidecarに永続状態を持たせる
7. Feedback機能障害でHost Applicationを停止させる
8. GIS固有概念をFeedback Coreへ持ち込む
9. Server implementation detailをFrontend contractへ漏らす
10. Go移行を現Kotlinコードの単純翻訳として実施する

---

## 25. 最終的な利用者体験

### Frontend

```bash
npm install @feedback/web-component
```

または

```bash
npm install @feedback/react
```

### Application

```ts
const feedback = createFeedback({
  endpoint: "/feedback",
  applicationId: "my-app",
  host: myHostAdapter,
})
```

### Kubernetes

Feedbackを有効にする場合のみSidecarを追加する。

```yaml
feedback:
  enabled: true
  applicationId: my-app
  server: http://feedback-server
```

利用アプリケーション側はFeedback Serverの実装言語、DB、notification方式、retention処理等を意識しない。

---

## 26. 完成状態

本改善の完了条件は以下とする。

- `gis-example` からFeedback Platformが独立している
- Go製Feedback ServerがKotlin版の必要機能を置換している
- Go製Sidecarを追加するだけでBackend統合できる
- Vanilla JS / ReactアプリへFeedback UIを導入できる
- GIS固有機能がPlugin/Adapterとして分離されている
- Host Application固有の認証方式をFeedback Serverが知らない
- OpenAPIがServerとの唯一の必須Backend契約となっている
- Stable Anchorにより画面変更後もコメント追跡が可能
- Review Scope / Review Dimensionが汎用モデル化されている
- Public Cloud / Kubernetes / 閉域環境のいずれにも配置できる
- Feedback Platform障害がHost Application本体へ波及しない
- SDK / Sidecar / Server間のversion compatibility policyが定義されている

---

## 27. 推奨する最初の実装単位

最初から全機能をGoへ移さず、以下を最初のvertical sliceとする。

```text
React / Web Component
        ↓
feedback-core
        ↓
Go Sidecar
        ↓
Go Feedback Server
        ↓
PostgreSQL
```

対象機能:

1. Feedback投稿
2. Stable Anchor
3. Feedback一覧表示
4. Thread / Reply
5. Review Dimension
6. Host identity
7. applicationId分離

このvertical sliceが成立した時点で、Feedback Platformの基本アーキテクチャは検証できる。

その後にAttachment、Notification、Retention、Export、Admin高度化を順次移行する。
