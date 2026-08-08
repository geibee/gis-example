# フィードバックシステム分離・プラガブル化レビュー

## 1. この文書の目的

本書は、現在のフィードバック機能を Web GIS 本体から別リポジトリへ切り出し、業務・画面構成・
認証基盤が異なる社内システムにも導入できるフィードバック基盤へ移行するための設計レビュー兼、
実装計画の入力資料である。

レビュー対象は 2026-08-09 時点のワークツリーであり、未コミットのフィードバック関連変更も含む。
現行機能の設計履歴と業務要件は [prototype-review.md](prototype-review.md) を正とし、本書では特に
「レビュー対象ソフトウェア」と「レビューシステム」の境界に焦点を当てる。

### 1.1 結論

現状は、同一リポジトリ・同一 PostgreSQL・同一 OIDC issuer / audience・同一プロジェクト体系を
共有する React SPA 向けの参照実装としては十分に機能している。一方で、無関係な他システムへ
そのまま導入できる独立製品にはなっていない。

- フロントエンドは投稿・ピン・スレッドが npm workspace へ分離されているが、API 契約、管理 UI、
  画面マニフェスト、ナビゲーション、本人識別などにホスト固有の前提が残る。
- `API_ROUTE_MODE=review-sidecar` は公開ルートを限定する実行モードであり、データ・認証・マイグレーション・
  リリースを分離した sidecar service ではない。
- 最優先で独立させる境界は、専用 OpenAPI、画面マニフェスト、Feedback Service のデータモデル、
  認証アダプターの 4 つである。
- 業務通信の透過インターセプトは採用しない。sidecar を置く場合は、フィードバック専用 API の中継または
  token exchange に責務を限定する。

## 2. 現在の構成

```text
Web GIS React SPA
  ├─ packages/feedback-plugin
  │    ├─ FeedbackPluginProvider
  │    ├─ FeedbackOverlay / DOM pin / Thread Drawer
  │    ├─ FeedbackMapLibreAdapter
  │    ├─ html-to-image による証跡取得
  │    └─ apps/api/openapi.yaml から生成した型
  ├─ レビュー管理画面
  │    ├─ ReviewSessionManager
  │    ├─ FeedbackManagementPanel
  │    ├─ 証跡・CSV Export・通知設定
  │    └─ Web GIS の AppShell / router / permission / CSS
  └─ Web GIS 固有の route catalog / permalink
                  │ Bearer JWT
                  ▼
Web GIS Kotlin API
  ├─ API_ROUTE_MODE=full
  └─ API_ROUTE_MODE=review-sidecar
       └─ 公開する Ktor route の集合だけを限定
                  │
                  ▼
Web GIS PostgreSQL / app schema
  ├─ projects / users / project_members / audit_logs
  ├─ GIS・業務テーブル
  └─ review_sessions / feedback_threads / evidence / outbox
```

`review-sidecar` モードでも `Application.module` は通常 API と同じ `Database` を生成し、全 Flyway
マイグレーションを適用した後に、共通の OIDC、監査、アップロードストレージ、通知 sender を構築する。
違いは分析ランナーを起動しないことと、認証ブロック内に登録する route 集合だけである。

### 2.1 現状で評価できる点

以下は切り出し後も維持すべき設計である。

- SDK は OIDC ライブラリを直接参照せず、アクセストークン取得・401 時の更新をコールバックで受け取る。
- TanStack Query のキーに `projectId` を含め、プロジェクト変更時のキャッシュ混在を防いでいる。
- `{id}` 形式の route template と、表示文言から独立した `pageId` を導入している。
- DOM 対象は `data-feedback-id`、地図は `data-feedback-map` で明示できる。
- MapLibre 固有の選択・marker 処理を `FeedbackMapLibreAdapter` へ分離している。
- SDK の portal を `data-review-exclude` で証跡から除外している。
- CSS class、data attribute、z-index、主要な配置値を名前空間化している。
- 証跡は公開 URL にせず、認可された API を通して取得する。
- CORS は複数 origin の allowlist であり、未指定時に `anyHost` へ開放しない。
- API の認可宣言、実行時 guard、監査ログは fail-closed になっている。
- OpenAPI と生成型のドリフト検査が品質ゲートに入っている。
- コメント投稿時の証跡取得に失敗しても、コメントのみを投稿できる。
- スレッド番号、具体的な対象画面、メッセージ版履歴、保存期限、通知 outbox を永続化している。

これらは「Web GIS の実装」ではなく「フィードバック基盤の性質」として、独立サービスへ移植する。

## 3. 優先度付きレビュー指摘

### 3.1 Critical: sidecar がデータ・認証・リリース境界を持たない

`apps/api/src/main/kotlin/gis/example/Application.kt` の `review-sidecar` は、レビュー系 route だけを
登録する。しかし起動前処理と依存は通常 API と同じであり、次の暗黙契約を持つ。

- Web GIS の全 Flyway migration を同じ順序で適用できること。
- PostGIS / `gis_data` と、GIS・業務テーブルを含む `app` schema が存在すること。
- `app.projects`、`app.users`、`app.project_members` が正本であること。
- 元アプリと同じ OIDC issuer、audience、subject を使用できること。
- 元アプリの `viewer` / `editor` ロールを使用できること。
- 元アプリと同じ API image を同時にリリースできること。
- 元アプリと同じローカル volume または S3 設定を利用できること。

レビュー用テーブルも `app.projects` と `app.users` へ外部キーで接続されている。したがって、別製品の
隣でこのコンテナだけを起動するには、相手の DB に Web GIS 全体の schema を持ち込む必要がある。

また、現行 compose には独立した `review-sidecar` service がなく、空の PostgreSQL と sidecar だけを
起動する検証経路もない。現状は「モノリスの route profile」であって「別システムへ持ち込める backend」
とは扱わない。

### 3.2 Critical: SDK 契約が Web GIS 全体の OpenAPI に依存する

SDK の `generate:contracts` は `../../apps/api/openapi.yaml` を直接参照する。この OpenAPI は
`Web GIS MVP API` 全体を表し、レビュー以外の projects、GIS、業務 CRUD、job、tile も含む。

この状態には次の問題がある。

- SDK を別リポジトリへ移すと生成元の相対パスが成立しない。
- GIS API の変更だけでも SDK の生成物が変化する。
- sidecar が実際に提供する部分 API の機械可読な契約がない。
- API path が `/api/*` で、互換性を示す major version がない。
- SDK と backend が対応する契約バージョンを実行時に確認できない。
- package 利用者がレビュー API 以外の型まで取得する。
- `targetMetadata` が `additionalProperties: true` であり、server は対象型ごとの必須項目・座標範囲を
  保証しない。

フィードバック専用 OpenAPI を新しい SSoT にし、SDK と Feedback Service の双方をそこから生成・検証する。

### 3.3 High: 画面一覧がブラウザ内だけにあり、server 契約になっていない

`defineFeedbackRoutes` は重複、絶対 path、`{name}` parameter を SDK 起動時に検証している。しかし
その配列はホストアプリの bundle 内にしか存在せず、Feedback Service は内容を知らない。

現行 backend は管理画面から受け取った `pageId` と `route` を保存でき、登録済み画面か、route template が
正しいか、対象アプリに属するかを検証しない。SDK が投稿時に送る `pageId` も同様である。

その結果、次を契約で保証できない。

- 同名 `pageId` を持つ別アプリの分離。
- dev / staging / production の分離。
- route catalog の更新履歴と session 作成時の catalog version。
- 詳細画面 parameter の意味と保存可否。
- 管理画面が対象アプリの最新画面一覧を取得できること。
- Export や通知から対象画面を再構築できること。
- 削除・rename された画面に対する過去 feedback の表示方法。

画面 catalog は `FeedbackApplicationManifest` として server へ登録し、session scope と投稿 location を
manifest に対して検証する。

### 3.4 High: tenant、application、workspace が Web GIS の project に埋め込まれている

現在は `projectId: UUID` が API、Query Key、認可、DB、管理画面の共通スコープである。しかし他システムの
案件・組織・テナント構造が Web GIS の `app.projects` と一致する保証はない。

Feedback Service は以下を自身のリソースとして所有する必要がある。

- `tenant`: 契約・運用・データ分離の最上位単位。
- `application`: SDK を組み込む論理アプリケーション。
- `environment`: application の dev / staging / production などの配備先。
- `workspace`: レビューを分離する案件・組織・プロジェクト相当の単位。
- `membership`: 誰がどの workspace で何をできるか。

ホスト側の project ID は `externalWorkspaceKey` として対応付ける。Feedback Service の DB からホスト DB へ
外部キーを張らず、内部 UUID と外部 key の対応を Feedback Service 自身が持つ。

### 3.5 High: 認証と権限が Web GIS 固有である

現行 API は JWT の `sub` を `app.users` へ JIT 登録し、`app.project_members` を読み、Web GIS の
`viewer` / `editor` から全業務権限とレビュー権限を同時に導出する。

別システムでは issuer、audience、claim、ロール体系が異なる。特に「元システムでは編集者だがレビュー管理は
できない」「業務データは閲覧できないがレビューだけ管理する」という構成を表せない。

独立サービスでは安定した権限語彙を次のように定義する。

| Permission | 用途 |
|---|---|
| `feedback.read` | session、thread、message、認可済み evidence の閲覧 |
| `feedback.comment` | thread 作成、返信、自分の message 編集 |
| `feedback.manage` | session 管理、resolve / reopen、Export、保存方針管理 |
| `feedback.admin` | application、environment、manifest、membership、通知接続の管理 |

OIDC 直接検証を標準アダプターとし、issuer、audience、subject claim、display-name claim を設定可能にする。
異なる IdP や audience を使うホストには、ホスト backend または専用 sidecar が mTLS で token exchange を
呼び出し、短寿命の feedback-scoped JWT を取得する。任意の `X-User-Id` や `X-Role` を直接信用しない。

### 3.6 High: 管理 UI と Export が Web GIS アプリに残っている

投稿、DOM pin、MapLibre pin、Thread Drawer は package に移ったが、次は `apps/web` に残る。

- ReviewSession の作成・更新・一覧。
- 画面 scope と観点の設定。
- thread の検索・集計。
- evidence viewer。
- CSV Export と permalink 生成。
- retention policy と purge。
- notification setting と failed delivery の retry。
- レビュー管理権限の route guard。

これらは Web GIS の AppShell、selected project、TanStack Router、通知 UI、CSS に依存する。他アプリへ SDK を
導入しても、レビュー管理者は Web GIS を使わなければ管理できない。

正式な管理面は独立した Feedback Admin Console とする。ホスト内に管理機能を埋め込みたい場合だけ、
同じ API を使う `@feedback/admin-react` を任意提供する。

### 3.7 High: npm package と optional dependency の境界が不十分

`@web-gis/feedback-plugin` は `publishConfig.access=restricted` を持つ一方、`private: true` であり、registry へ
publish できない。package contract test も `npm pack` した tarball を別ディレクトリへ install するところまでは
検証していない。

また MapLibre を使わない一般 SPA にも `maplibre-gl` が peer dependency として要求される。package root が
MapLibre adapter まで export しているため、bundler の tree-shaking と型解決にも依存する。

次の package 境界へ分割する。

- `@feedback/contracts`: OpenAPI 生成型、JSON Schema、version 定数。
- `@feedback/core`: transport、route、location、target、manifest、エラー型。React 非依存。
- `@feedback/react`: Provider、Overlay、DOM pin、Thread UI、既定 capture adapter。
- `@feedback/maplibre`: MapLibre adapter。MapLibre はこの package だけの peer dependency。
- `@feedback/admin-react`: 埋め込み管理 UI。任意導入。

### 3.8 Medium: SDK のホスト適応点が足りない

現在注入できる主なものは API base URL、project ID、app version、token、notification、QueryClient である。
次は SDK 内に固定されている。

- REST endpoint と request 形式。
- TanStack Query による cache 実装。
- 日本語文言。
- 投稿者名の localStorage 保存と入力必須。
- `document.body` への portal。
- 通常 DOM 全体の右クリック抑止。
- `html-to-image` による `document.body` capture。
- thread deep-link の query parameter 処理。
- `window.location` からの route 取得。
- CSS の通常 document への適用。

最低限、transport、host context、navigation、identity、evidence capture を interface にする。右クリック、
自動表示、participant-name prompt、evidence capture は feature flag で個別に無効化可能にする。

ホスト CSS や厳格な CSP との衝突を避けるため、portal target と任意の ShadowRoot を受け取れるようにする。
日本語を既定 locale として維持しつつ、全表示文言を message catalog で差し替え可能にする。

### 3.9 Medium: location と target の server-side validation が弱い

現行 server は `targetType` の allowlist と `target` が JSON object であることまでは検証するが、型ごとの
形は検証しない。例えば範囲外の相対座標、緯度経度、空の feature ID を API へ直接送信できる。

`FeedbackTarget` は `schemaVersion` と `kind` を持つ厳密な discriminated union にし、OpenAPI と server の
両方で次を検証する。

- `ui-element`: stable element key、要素内相対座標。
- `screen-position`: viewport 相対座標。
- `map-feature`: map provider、source key、任意の source layer、feature key、投稿時の緯度経度。
- `map-position`: WGS84 経度・緯度。

MapLibre の source ID をそのまま製品横断 ID とみなさず、host adapter が公開する安定した map source key へ
変換する。

### 3.10 Medium: URL、証跡、localStorage のプライバシー契約がない

現在は `pathname + search` を `pageRoute` と evidence metadata に保存する。query parameter に顧客番号、
メールアドレス、一時 token、検索条件が入るアプリでは、その値が DB、監査、通知、CSV へ伝播し得る。

また、既定 capture は `document.body` 全体であり、ホストが除外属性を付け忘れると、個人情報や秘密情報も
画像へ固定される。participant name は平文で localStorage に保存される。

以下を契約に含める。

- route parameter と query parameter は manifest の allowlist だけを保存する。
- parameter ごとに `store`、`hash`、`discard` を指定する。既定は `discard`。
- SDK は `data-feedback-mask` を提供し、対象要素を塗りつぶして capture する。
- capture root、exclude selector、mask selector、最大 pixel ratio、content type、最大 byte size を設定可能にする。
- evidence 取得前にホストが最終確認・加工できる hook を用意する。
- participant name の保存先は host identity adapter とし、localStorage は opt-in の既定実装に下げる。
- retention、監査、削除、Export への含有項目を tenant policy として明示する。

### 3.11 Medium: session 適用規則が一意でない

DB は同一 project に複数の `open` session を作成できる。一方 SDK は `status=open` の一覧から最初に見つかった
1 件だけを選ぶため、作成順や API の並びで表示するレビューが変わる。

初期 v1 は `(application, environment, workspace)` ごとに `open` session を最大 1 件とする。DB の partial
unique index、service の状態遷移、OpenAPI の 409 応答で同じ制約を保証する。将来複数 session を扱う場合は、
API と SDK の major/minor 契約変更として session selector を追加する。

また scope 外画面からの投稿を許すかは偶発動作にしない。session policy に
`outOfScopePosting: "allow" | "warn" | "deny"` を持たせ、server でも強制する。v1 の既定は現在の価値を
維持するため `warn` とし、SDK で警告した上で投稿を許可する。

### 3.12 Medium: write API の再送・競合契約がない

通信断の直後に利用者が投稿を再試行すると同じ thread が複数作成され得る。message 編集と status 更新にも
同時更新の検出がない。

- thread/message 作成は `Idempotency-Key` を受け取り、tenant と principal を含む範囲で結果を再利用する。
- session、message、thread status は `ETag` を返し、更新時に `If-Match` を要求する。
- stale update は 412、同一 workspace の open session 競合は 409 とする。
- 一覧 API は body 内の cursor pagination に統一し、CORS exposed header への依存をなくす。

### 3.13 Medium: sidecar 固有の運用契約と適合試験がない

現状は sidecar 専用 image、compose profile、Helm/ECS 定義、capabilities endpoint、専用 OpenAPI、fresh DB test が
ない。また通常 API と sidecar を同時起動すると、通知 worker の重複起動を環境変数運用で避ける必要がある。

独立 Feedback Service は 1 image とし、HTTP API と notification worker は command または deployment を分ける。
起動時に不要な GIS/job dependency を構築しない。`/health/live`、`/health/ready`、`/feedback/v1/capabilities` を
提供し、DB、object storage、契約 version を観測できるようにする。

### 3.14 主なコード上の根拠

| 観察事項 | 現在の根拠 |
|---|---|
| sidecar でも全 migration・共通依存・OIDC・監査を初期化する | [`Application.kt`](../apps/api/src/main/kotlin/gis/example/Application.kt) |
| sidecar は route 集合だけを切り替える | [`authenticatedReviewSidecarRoutes`](../apps/api/src/main/kotlin/gis/example/Application.kt) |
| baseline が projects/users/GIS/job table を同時に作る | [`V1__baseline.sql`](../apps/api/src/main/resources/db/migration/V1__baseline.sql) |
| review session が Web GIS project/user を参照する | [`V5__review_sessions.sql`](../apps/api/src/main/resources/db/migration/V5__review_sessions.sql) |
| thread/message が Web GIS project/user を参照する | [`V6__feedback_threads.sql`](../apps/api/src/main/resources/db/migration/V6__feedback_threads.sql) |
| JWT subject を Web GIS user と membership へ解決する | [`Auth.kt`](../apps/api/src/main/kotlin/gis/example/Auth.kt)、[`UserQueries.kt`](../apps/api/src/main/kotlin/gis/example/UserQueries.kt) |
| review permission が全業務用 viewer/editor に含まれる | [`Authorization.kt`](../apps/api/src/main/kotlin/gis/example/Authorization.kt) |
| SDK 型生成が Web GIS OpenAPI の相対パスに依存する | [`packages/feedback-plugin/package.json`](../packages/feedback-plugin/package.json) |
| OpenAPI が GIS・業務・review を単一契約に含める | [`apps/api/openapi.yaml`](../apps/api/openapi.yaml) |
| package が private かつ MapLibre を必須 peer にする | [`packages/feedback-plugin/package.json`](../packages/feedback-plugin/package.json) |
| route catalog が SDK の runtime 配列である | [`routes.ts`](../packages/feedback-plugin/src/routes.ts)、[`appRoutes.ts`](../apps/web/src/appRoutes.ts) |
| server が任意の scope pageId/route を保存できる | [`ReviewQueries.kt`](../apps/api/src/main/kotlin/gis/example/ReviewQueries.kt) |
| target body を汎用 JSON object として保存する | [`FeedbackRoutes.kt`](../apps/api/src/main/kotlin/gis/example/routes/FeedbackRoutes.kt)、[`FeedbackQueries.kt`](../apps/api/src/main/kotlin/gis/example/FeedbackQueries.kt) |
| capture が現在の pathname/search を保存する | [`capture.ts`](../packages/feedback-plugin/src/capture.ts) |
| SDK が open session 一覧から 1 件だけを選ぶ | [`queries.ts`](../packages/feedback-plugin/src/queries.ts) |
| 管理 UI・証跡・Export が Web GIS に残る | [`ReviewScreen.tsx`](../apps/web/src/screens/ReviewScreen.tsx)、[`FeedbackManagementPanel.tsx`](../apps/web/src/components/FeedbackManagementPanel.tsx)、[`feedbackExport.ts`](../apps/web/src/feedbackExport.ts) |
| compose に review-sidecar service がない | [`infra/docker-compose.yml`](../infra/docker-compose.yml) |

## 4. 透過的な通信インターセプトを採用しない理由

業務通信を sidecar で透過的に傍受しても、フィードバックに必要な次の情報は得られない。

- React Router 等が解決した論理画面 ID。
- 動的 route parameter の意味と機微性。
- クリックされた DOM element の stable key と要素内座標。
- Canvas 上の MapLibre feature と業務上の feature key。
- portal、個人情報、認証情報などの capture 除外・mask 対象。
- ホストが意図する deep-link navigation。

TLS 終端後の全通信を読む構成は、認証 token と業務データを sidecar の責任範囲へ不必要に広げる。
障害時に業務通信まで巻き込むため、可用性境界としても不利である。

sidecar を採用する場合は次の 2 用途だけに限定する。

1. 同一 origin の `/feedback/v1/*` を中央 Feedback Service へ転送する reverse proxy。
2. ホストセッションを検証し、mTLS で中央サービスから feedback-scoped token を得る token broker。

SDK は専用 API へ明示的に通信する。中央サービスが利用可能でなくてもホスト業務の主要操作は継続できるよう、
Feedback Overlay のみを unavailable 状態にする。

## 5. 目標アーキテクチャ

```text
レビュー対象 React SPA
  ├─ @feedback/react
  ├─ @feedback/maplibre（任意）
  └─ FeedbackHostAdapter
       ├─ getContext / getLocation
       ├─ getIdentity / getAccessToken
       ├─ navigate
       └─ capture / mask
             │
             │ HTTPS /feedback/v1
             │ 直接通信、Gateway、または token broker
             ▼
      独立 Feedback Service
       ├─ 専用 OpenAPI
       ├─ tenant/application/environment/workspace
       ├─ session/thread/message/evidence
       ├─ feedback 固有の認可・監査
       ├─ object storage
       ├─ transactional outbox / webhook
       └─ 専用 PostgreSQL / Flyway history
             ▲
             │
      Feedback Admin Console
       ├─ session / scope / perspective
       ├─ thread search / evidence / export
       ├─ retention / audit
       └─ notification / membership / manifest
```

### 5.1 リポジトリと成果物

別リポジトリでは少なくとも次を成果物として管理する。

```text
feedback-system/
  contracts/
    openapi.yaml
    host-manifest.schema.json
    webhook.schema.json
  packages/
    contracts/
    core/
    react/
    maplibre/
    admin-react/
  apps/
    service/          # Kotlin
    admin-web/        # React
  deploy/
    compose/
    ecs-or-helm/
  conformance/
    react-host/
    maplibre-host/
    oidc-fixture/
```

Feedback Service の migration は専用の schema history を持ち、Web GIS の migration を参照・複製しない。

## 6. ホストとレビューシステムの契約

### 6.1 Application Manifest

ホストは source file path や業務 API を解析させず、ルーター定義から生成した manifest を登録する。

```ts
type FeedbackApplicationManifestV1 = {
  schemaVersion: "1";
  applicationKey: string;
  displayName: string;
  manifestVersion: string;
  routes: Array<{
    pageKey: string;
    template: string;
    label: string;
    group?: string;
    parameters?: Record<string, {
      persistence: "store" | "hash" | "discard";
    }>;
  }>;
};
```

規則:

- `applicationKey` と `pageKey` は application 内で不変の英語識別子とする。
- `template` は `/orders/{orderId}` のように parameter が path segment 全体を占める。
- query parameter は route template へ含めない。必要なものだけ別 allowlist で定義する。
- `pageKey` / template の rename は旧 route を alias として残す expand-contract で行う。
- session は作成時に `manifestVersion` を記録し、後から対象一覧を再現できるようにする。
- server は重複 page key、重複 template、不正 parameter、未知 schema version を拒否する。

登録方法は管理 API と CI の両方を用意する。production では application admin token を使った CI 登録を推奨し、
ブラウザ SDK に manifest 更新権限を与えない。

### 6.2 Environment と deep link

environment は manifest と分離し、配備先ごとの URL と認証設定を持つ。

```ts
type FeedbackEnvironmentV1 = {
  environmentKey: string;
  baseUrl: string;
  allowedOrigins: string[];
  deepLinkThreadParameter: string; // default: "feedbackThread"
};
```

Export や通知の URL は、server が登録済み `baseUrl`、route template、保存を許可された parameter、thread query
parameter から生成する。投稿された外部 origin や生 URL をそのままリンクに使用しない。

### 6.3 Runtime Context と Location

```ts
type FeedbackHostContextV1 = {
  schemaVersion: "1";
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  release: string;
  locale?: string;
};

type FeedbackLocationV1 = {
  schemaVersion: "1";
  pageKey: string;
  routeTemplate: string;
  pathParameters: Record<string, string>;
  queryParameters?: Record<string, string>;
};
```

SDK は現在 URL を独自解析せず、host adapter から context と location を受け取る。SDK 内の既定 router adapter は
manifest と `window.location` から location を解決できるが、利用者は React Router、TanStack Router、Next.js 等に
合わせて差し替えられる。

server は manifest policy に従って parameter を保存・hash・破棄する。`routeTemplate` と `pageKey` の組み合わせが
manifest と一致しなければ 400 とする。

### 6.4 Target

```ts
type FeedbackTargetV1 =
  | {
      schemaVersion: "1";
      kind: "ui-element";
      elementKey: string;
      relativeX: number;
      relativeY: number;
    }
  | {
      schemaVersion: "1";
      kind: "screen-position";
      relativeX: number;
      relativeY: number;
    }
  | {
      schemaVersion: "1";
      kind: "map-feature";
      provider: "maplibre";
      sourceKey: string;
      sourceLayer?: string;
      featureKey: string;
      longitude: number;
      latitude: number;
    }
  | {
      schemaVersion: "1";
      kind: "map-position";
      longitude: number;
      latitude: number;
    };
```

相対座標は 0 以上 1 以下、longitude は -180 以上 180 以下、latitude は -90 以上 90 以下とする。stable key は
trim 後に空を許可せず、長さ上限を OpenAPI、SDK、server、DB で一致させる。

### 6.5 Host Adapter

```ts
type FeedbackHostAdapter = {
  getContext(): FeedbackHostContextV1;
  getLocation(): FeedbackLocationV1 | null;
  getAccessToken(): Promise<string | null>;
  refreshAccessToken?(): Promise<string | null>;
  getIdentity?(): Promise<FeedbackParticipant | null>;
  navigate(location: FeedbackLocationV1, threadId: string): void | Promise<void>;
  captureEvidence?: FeedbackEvidenceProvider;
};
```

`getLocation()` が `null` の画面では、SDK は pin と投稿 launcher を表示しない。deep link で thread を指定された場合、
SDK は thread detail から location を取得し、`navigate` の完了後に drawer を開く。

### 6.6 Participant identity

正式な認証主体と、共通アカウント利用時の自己申告名を分離する現行方針は維持する。ただし自己申告名を常に必須には
しない。

```ts
type ParticipantPolicy =
  | { mode: "authenticated-identity" }
  | { mode: "prompt"; storage: "memory" | "local-storage" | "host" }
  | { mode: "authenticated-and-prompt"; storage: "memory" | "local-storage" | "host" };
```

server は認証 principal、表示用 participant name、identity policy を別フィールドとして監査する。自己申告名は
認可判断に使用しない。

### 6.7 Evidence

```ts
type FeedbackEvidenceProvider = (request: {
  context: FeedbackHostContextV1;
  location: FeedbackLocationV1;
  target: FeedbackTargetV1;
  excludeSelector: string;
  maskSelector: string;
}) => Promise<{
  blob: Blob;
  contentType: "image/png" | "image/webp";
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  capturedAt: string;
} | null>;
```

SDK の `html-to-image` 実装は既定 adapter とし、必須実装にはしない。host は機密画面で capture を無効化したり、
サーバーサイド rendering、ブラウザ extension、独自マスキングへ差し替えられる。

### 6.8 Webhook

通知先との契約は Email / Teams 固有 payload ではなく、次の domain event を正とする。

- `feedback.thread.created.v1`
- `feedback.message.created.v1`
- `feedback.thread.resolved.v1`
- `feedback.thread.reopened.v1`

全 event は event ID、occurredAt、tenant/application/environment/workspace、session/thread ID、actor summary、
deep link を持つ。本文や evidence URL は接続設定で明示的に許可した場合だけ含める。

Webhook は HMAC または非対称署名、timestamp、delivery ID を付与する。少なくとも一度配送とし、受信側は delivery ID で
冪等化する。外部通知は引き続き transactional outbox から行い、feedback transaction 内で外部 HTTP を呼ばない。

## 7. Feedback API v1

専用 OpenAPI の base path は `/feedback/v1` とする。主要 endpoint は以下とする。

| Endpoint | 用途 |
|---|---|
| `GET /capabilities` | server contract version、機能、upload 上限の取得 |
| `GET /me` | principal と workspace ごとの feedback permission |
| `PUT /applications/{applicationKey}/manifest` | manifest の登録・更新 |
| `GET /applications/{applicationKey}/manifest` | 管理 UI 用画面 catalog |
| `GET /review-context` | context/location に適用される open session と投稿 policy |
| `GET/POST /sessions` | session 一覧・作成 |
| `GET/PATCH /sessions/{sessionId}` | session 詳細・更新 |
| `GET/POST /sessions/{sessionId}/threads` | thread 一覧・投稿 |
| `GET /threads/{threadId}` | thread 詳細 |
| `POST /threads/{threadId}/messages` | 返信 |
| `PATCH /messages/{messageId}` | 本人による message 編集 |
| `GET /messages/{messageId}/versions` | message 版履歴 |
| `PATCH /threads/{threadId}/status` | resolve / reopen |
| `GET /threads/{threadId}/evidence` | 認可付き evidence 取得 |
| `POST /exports` | 大量データ向け非同期 CSV/XLSX export |
| `GET/PATCH /retention-policy` | 保存方針 |
| `GET/PATCH /notification-settings` | 通知設定 |

### 7.1 API 共通規則

- JSON response は OpenAPI 3.1 と JSON Schema で完全に型付けする。
- エラーは `application/problem+json` を使い、`type`、`title`、`status`、`detail`、`code`、`requestId` を返す。
- 401 は未認証・token 無効、403 は認証済みだが permission 不足、404 は非メンバーへの存在秘匿にも使う。
- list は `{ items, nextCursor, totalCount? }` とし、offset と独自 response header に依存しない。
- write は成功時に resource の `ETag` を返す。PATCH は `If-Match` 必須とする。
- create は `Idempotency-Key` を受け付ける。同一 principal / workspace / endpoint / key の再送は同じ結果を返す。
- API は request ID を受け継ぐか採番し、監査・application log・outbox delivery と相関できるようにする。
- SDK の major version と API major version を一致させ、minor capability は `/capabilities` で判定する。
- CORS allowlist は environment 登録値を正とし、credentials の有無と許可 header を契約化する。

### 7.2 Review context

SDK は session 一覧から先頭を選ばず、現在 context/location に対して server が解決した結果を取得する。

```ts
type ReviewContextV1 = {
  session: ReviewSessionV1 | null;
  scope: "reviewable" | "excluded" | "unregistered";
  posting: "allow" | "warn" | "deny";
  permissions: string[];
  participantPolicy: ParticipantPolicy;
  evidencePolicy: {
    enabled: boolean;
    maxBytes: number;
    acceptedContentTypes: string[];
  };
};
```

これにより manifest、session scope、利用者権限、環境 policy の解釈を SDK ごとに重複させない。

## 8. Feedback Service のデータ境界

専用 DB では概ね次を所有する。

```text
tenants
applications
application_environments
application_manifests
workspaces
workspace_external_keys
users
workspace_memberships
review_sessions
review_session_perspectives
review_scopes
feedback_threads
feedback_messages
feedback_message_versions
review_evidence
retention_policies
notification_settings
notification_outbox
notification_deliveries
audit_logs
idempotency_records
```

### 8.1 データ設計規則

- 内部 ID は UUID、ホスト提供 key は長さ制限付き text として分ける。
- 全 workspace resource は tenant/application/workspace を単一 query で解決できるようにする。
- 他システムの DB table へ外部キーを張らない。
- evidence blob reference は公開 URL ではなく private object key とする。
- target と location は schema version を保持し、将来変換できるようにする。
- application manifest は上書きだけでなく version を保存する。
- audit log は追記専用で、認証失敗、認可拒否、mutate、evidence read、export を記録する。
- 機微値の mask と巨大値の要約を監査ライブラリに集約する。
- open session は `(application_id, environment_id, workspace_id)` の partial unique index で最大 1 件にする。
- message version、thread number、idempotency record の並行更新を DB transaction で保証する。

### 8.2 保存ストレージ

本番は S3 互換 object storage を標準とし、local filesystem は開発・単一ホスト用途に限定する。保存 adapter は
`store/open/delete` と object metadata を契約にし、DB transaction 失敗時の orphan cleanup、削除失敗時の再試行、
retention 延長との競合を検証する。

## 9. フロントエンド package 境界

### 9.1 `@feedback/core`

- React、DOM、MapLibre、TanStack Query に依存しない。
- manifest/location/target の validator と matcher を持つ。
- `FeedbackTransport` interface と OpenAPI fetch 実装を持つ。
- token refresh の single-flight、Problem Details、Idempotency-Key、ETag を扱う。
- host adapter と capabilities negotiation の型を公開する。

### 9.2 `@feedback/react`

- `FeedbackProvider`、`FeedbackOverlay`、DOM pin、Thread Drawer を提供する。
- query/cache 実装は package 内部詳細とし、公開 API から TanStack Query 型を漏らさない。
- host が QueryClient を共有できる最適化は任意 adapter として残す。
- locale message、theme token、portal target、ShadowRoot、feature flag を受け取る。
- context menu は既定で opt-in とし、ホストの通常右クリックを不意に奪わない。
- React error boundary と unavailable UI を提供し、Feedback Service 障害を業務画面から隔離する。

### 9.3 `@feedback/maplibre`

- MapLibre だけを peer dependency とする。
- host の source/layer/feature ID を安定 source key / feature key へ変換する adapter を受け取る。
- `preserveDrawingBuffer` の性能コストと、capture provider を差し替える選択肢を文書化する。
- map unload、style reload、layer 消滅、marker cleanup を適合テストする。

### 9.4 `@feedback/admin-react` と Admin Console

- Admin Console を正式な管理 UI とする。
- `admin-react` は同じ画面をホストへ埋め込む必要がある場合の任意 package とする。
- Export の列定義、deep link、locale、timezone は server と共有する契約から構成する。
- XLSX/CSV は spreadsheet formula injection を無効化する。
- 大量 export は browser が全 thread を収集せず、非同期 server job と期限付き認可 download を使う。

## 10. 認証・認可・セキュリティ

### 10.1 直接 OIDC モード

- Feedback Service が設定済み issuer の JWKS で JWT を検証する。
- issuer ごとに audience、subject claim、email/display-name claim を定義する。
- application/environment が許可する issuer 以外を拒否する。
- user JIT 登録は membership を自動付与しない。既定 deny とする。

### 10.2 Token exchange モード

- browser はホスト backend / sidecar へ同一 origin の token endpoint を呼ぶ。
- broker はホストセッションを検証し、中央 Feedback Service と mTLS で通信する。
- 返す JWT は短寿命とし、tenant/application/environment/workspace、feedback permission、actor を audience 限定で持つ。
- 業務 API 用 access token を中央 Feedback Service へ転送しない構成を選べるようにする。

### 10.3 CSP と browser security

SDK の導入要件として次を明示する。

- `connect-src`: Feedback Service または同一 origin gateway。
- `img-src`: evidence preview に必要な `blob:`。不要な場合は capture/preview を無効化可能にする。
- `style-src`: inline style を要求しない実装を優先し、nonce または stylesheet URL を選べるようにする。
- cross-origin image/font は capture 時の CORS 対応または除外が必要。
- ShadowRoot 利用時の stylesheet 注入方法。
- frame 内導入時の `frame-ancestors` と coordinate contract。

### 10.4 可用性と rate limit

- Feedback Service の失敗でホストアプリの起動・主要画面 rendering を失敗させない。
- context/session query は timeout と限定 retry を持つ。
- comment write は自動再送より Idempotency-Key を優先する。
- tenant/principal/IP 単位の rate limit と evidence size/count quota を設ける。
- object storage や notification の障害を readiness と user-facing error で区別する。

## 11. 段階的な実装計画

### Phase 0: 契約の凍結

実施内容:

- feedback 専用 OpenAPI 3.1 を新設する。
- application manifest、location、target、webhook の JSON Schema を作成する。
- package/API versioning と compatibility policy を決める。
- current API から v1 への field mapping と移行対象データを一覧化する。
- 現行 Web GIS を consumer 1 とする adapter の設計を固定する。

完了条件:

- GIS endpoint を含まない専用契約から TypeScript/Kotlin の型を生成できる。
- location/target の全 variant を schema validator と server test で検証できる。
- manifest から動的詳細画面と deep link を再構成できる。
- 現行 thread/session/evidence の全 field に移行先が定義されている。

### Phase 1: SDK package の分割

実施内容:

- contracts/core/react/maplibre package を作成する。
- REST と TanStack Query を公開 component から分離する。
- HostAdapter、transport、capture、navigation、identity、locale、portal の拡張点を実装する。
- MapLibre を optional package へ移す。
- `private: true` を外し、restricted registry 用 package metadata と changelog を整備する。

完了条件:

- `npm pack` した各 package を別の clean React repository fixture へ install できる。
- MapLibre が未インストールでも `@feedback/react` を build/run できる。
- React 18/19、Vite、代表的な router adapter で投稿・pin・deep link が動く。
- Web GIS 固有 import と `../../apps/api/openapi.yaml` 参照が package から消える。

### Phase 2: 独立 Feedback Service

実施内容:

- Kotlin の独立 application/module と専用 Flyway を作成する。
- tenant/application/environment/workspace/membership を実装する。
- session/thread/message/evidence/retention/audit を現行実装から移植する。
- OIDC adapter、token exchange 検証、private object storage を実装する。
- API と notification worker の deployment を分離する。

完了条件:

- 空の通常 PostgreSQL と object storage だけで service を起動できる。
- PostGIS、`gis_data`、Web GIS migration、Web GIS project/user table を要求しない。
- 専用 OpenAPI と routing tree が双方向同期する。
- 全 route に feedback permission と resource scope が宣言される。
- evidence、監査、retention、message history の現行保証を維持する。

### Phase 3: Admin Console と外部連携

実施内容:

- session、scope、perspective、thread、evidence、retention、membership、manifest の独立管理 UI を作成する。
- server-side CSV/XLSX export を実装する。
- webhook/outbox と Email/Teams/Issue adapter を Feedback Service へ移す。
- 管理者 deep link から対象アプリへ遷移できるようにする。

完了条件:

- Web GIS を起動せずに全レビュー管理操作を完結できる。
- Export の全リンクが登録済み environment と manifest から生成される。
- evidence や secret を webhook へ既定で送らない。
- 配送署名、retry、dead-letter 相当の管理、監査が検証される。

### Phase 4: Web GIS を consumer へ移行

実施内容:

- Web GIS の route catalog から manifest を生成する。
- project ID を `externalWorkspaceKey` として対応付ける。
- SDK Provider を新 HostAdapter/API へ切り替える。
- 管理 route は Admin Console link または `admin-react` へ置換する。
- session/thread/message/evidence/audit/outbox を移行する。
- 互換期間は旧 API を read-only または dual-read adapter で維持する。

完了条件:

- 現行の投稿、DOM/MapLibre pin、返信、編集、resolve、証跡、ガイド、Export、通知に機能差分がない。
- 既存 thread ID、display number、message history、evidence retention を保持する。
- 既存 permalink は redirect または互換 resolver で対象画面と thread を開ける。
- dual-write を採用する場合は照合レポートが 0 差分になってから切り替える。

ロールバック:

- DB migration はコピー方式を基本とし、旧 DB を即時削除しない。
- 切替前に旧 API を再選択できる feature flag を用意する。
- evidence blob は移行完了と checksum 照合まで旧参照を保持する。

### Phase 5: 別システムによる適合確認と正式公開

実施内容:

- Web GIS と画面・業務・認証構成が異なる React SPA を consumer 2 として導入する。
- private registry へ pre-release を publish する。
- conformance suite、upgrade guide、operations guide、security guide を整備する。

完了条件:

- consumer 2 が Web GIS の DB、OIDC audience、project role、route code を参照せず利用できる。
- application/environment/workspace の分離と cross-tenant deny を統合テストで確認する。
- package と API の互換 matrix、サポート期間、廃止手順が公開される。

## 12. テストと品質ゲート

### 12.1 Contract

- 専用 OpenAPI lint と生成物 drift check。
- server routing tree と OpenAPI paths の双方向同期。
- request/response の実 JSON schema validation。
- manifest/location/target/webhook JSON Schema の fixture test。
- old/new version の consumer-driven contract test。
- API major/minor と SDK capabilities negotiation test。

### 12.2 SDK

- DOM stable target、screen position、route parameter、mask/exclude。
- capture 失敗時のコメント投稿。
- 401 single-flight refresh、403、404、409、412、413、429、5xx。
- Idempotency-Key 再送と二重投稿防止。
- application/environment/workspace 変更時の cache 分離。
- deep link navigation 完了後の drawer open。
- localStorage 不可、participant prompt 各 mode、locale 差し替え。
- portal target、ShadowRoot、host CSS、strict CSP。
- service unavailable 時に host UI が継続すること。
- MapLibre package 未導入時の core/react build。
- MapLibre style reload、feature変換、marker cleanup、capture policy。

### 12.3 Packaging

- `npm pack` の files/exports/types/CSS を検査する。
- tarball を workspace 外の clean Vite React fixture へ install/build/test する。
- React 18/19 と対応 TypeScript version の matrix test。
- maplibre/react/admin の optional dependency が意図せず root package に混入しないことを検査する。
- prerelease から stable への semver compatibility test を行う。

### 12.4 Backend standalone

- 空 PostgreSQL への全 migration 適用、既存 feedback DB の upgrade、schema convergence。
- PostGIS extension と Web GIS table が存在しない状態での起動。
- OIDC issuer/audience/claim mapping と token exchange。
- tenant/application/environment/workspace の cross-boundary access deny。
- 1 workspace 1 open session の並行更新。
- thread number、message version、idempotency の並行処理。
- private evidence、range/size/content-type、retention、orphan cleanup。
- audit allow/deny/read/export と機微値 mask。
- outbox claim、retry、署名、重複配送、poison delivery。
- CORS の単一・複数・不正・未許可 origin。

### 12.5 Consumer conformance

- manifest を登録し、一覧画面と `{id}` 詳細画面を管理 UI から選べる。
- 実 URL が正しい page/location に変換される。
- parameter policy により機微な値が保存・Export・監査へ漏れない。
- SDK の投稿から Admin Console の一覧・証跡・deep link まで往復できる。
- Export URL が対象アプリを開き、指定 thread を自動表示する。
- OIDC を共有する consumer と token exchange consumer の双方を検証する。

## 13. 運用・リリース契約

- API、SDK、DB migration、Admin Console を同一 release train に強制せず、compatibility matrix を持つ。
- API は少なくとも 1 つ前の SDK minor をサポートし、breaking change は新 major path/package で行う。
- `/capabilities` に API version、target schema version、manifest schema version、evidence limits、feature flags を返す。
- structured log に tenant/application/environment/workspace/request/event ID を含めるが、comment 本文と機微 parameter は
  既定で記録しない。
- metric は API latency/error、投稿成功、capture failure、storage failure、outbox lag、delivery failure、purge backlog を持つ。
- tenant ごとの保存容量、投稿数、export 数、rate limit を観測する。
- backup/restore は DB と object storage の整合点、evidence checksum、outbox 再送を含めて訓練する。
- secret は環境変数または secret manager から注入し、manifest や npm package に含めない。

## 14. 実装時に変更してはいけない性質

- 認証 principal と自己申告 participant name を混同しない。
- 非メンバーへ resource の存在を漏らさない。
- evidence を公開 bucket や恒久署名 URL で配らない。
- capture 失敗だけを理由にコメント投稿を失敗させない。
- message 編集履歴を上書きで失わない。
- resolve / reopen と返信を暗黙に結合しない。
- retention 未設定の既存 evidence へ暗黙の削除期限を導入しない。
- notification 外部サービスを正本にしない。
- host DB と Feedback Service DB を外部キーで結合しない。
- SDK がホストの業務 API や router source file を実行時解析しない。
- sidecar に業務通信全体の復号・傍受権限を与えない。

## 15. 実装開始前の決定事項

本書では次を既定として固定する。変更する場合は Architecture Decision Record を追加する。

1. 中央集約型 Feedback Service を採用する。
2. 業務通信の透過インターセプトは採用しない。
3. Feedback Service は専用 DB または専用 database/schema と専用 Flyway history を所有する。
4. OIDC 直接検証を標準、mTLS token exchange を異なる認証基盤向けの拡張とする。
5. Admin Console を正式な管理 UI とし、埋め込み管理 UI は任意 package とする。
6. v1 は application/environment/workspace ごとに open session を最大 1 件とする。
7. scope 外投稿の既定は警告付き許可とし、session policy で deny へ変更可能にする。
8. 生 URL と query は保存せず、manifest allowlist で許可した parameter だけを保存する。
9. MapLibre は optional package とする。
10. 現行 Web GIS は最初の consumer とし、別系統 React SPA を正式公開前の consumer 2 とする。

## 16. 次セッションの着手順

次の実装セッションでは、いきなりコードを移動せず Phase 0 から開始する。

1. 新しい feedback 専用 OpenAPI の resource 名、base path、Problem Details、pagination を定義する。
2. manifest/location/target の JSON Schema と TypeScript/Kotlin 生成方法を決める。
3. 現行 OpenAPI、DTO、DB 列から新契約への mapping table を作る。
4. `@feedback/core` が公開する interface と package exports を固定する。
5. 独立 DB の table/foreign-key 境界と Web GIS データ移行方式を設計する。
6. Phase 0 の contract/conformance test を先に追加する。

Phase 0 のレビューが完了するまでは、`packages/feedback-plugin` を別リポジトリへ物理移動したり、現行 DB の
外部キーを削除したりしない。契約を先に確定し、現行アプリを adapter 経由で段階移行する。
