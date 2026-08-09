# Feedback Platform Go移行後ロードマップ

> 状態: Go版v1完全互換移行後に開始する製品ロードマップ。
> 前提: [`../feedback-platform-improvement-plan.md`](../feedback-platform-improvement-plan.md) のPhase 8と最終完了チェックリストを満たしていること。
> 基準日: 2026-08-09

並行実装時のagent配置、path ownership、統合barrierは
[`feedback-go-agent-execution-plan.md`](feedback-go-agent-execution-plan.md) を必須手順とする。

## 1. 目的

Go版Feedback ServiceをKotlin版の単なる置換で終わらせず、任意のWebアプリケーションへ導入でき、
公共部門・閉域環境でも継続運用できる独立Feedback Platformへ発展させる。

このロードマップでは、現行v1に既に存在する機能を再実装しない。

- `FeedbackHostAdapter` とframework非依存transportは既に `@feedback/core` に存在する。
- UI elementの `elementKey`、MapLibreの `sourceKey/featureKey`、location/route manifestは既にTarget v1を構成する。
- review session、scope、perspective、out-of-scope posting policyは既に存在する。
- capability negotiation、token exchange、Connector Protocol v1、backup/connector管理も既に存在する。

したがって、移行後はこれらを安定公開し、不足している汎用性・配布・運用・拡張性を段階的に追加する。

## 2. 原則と境界

### 2.1 原則

- `/feedback/v1`、Target schema v1、manifest schema v1、Connector Protocol v1の後方互換を維持する。
- 新機能はcapabilityで検出可能にし、古いSDKが未知機能を受けてもHost UIを壊さない。
- schema変更はexpand、dual-read/dual-write、backfill、contractの順で行う。
- Host ApplicationのDB、業務API、認証方式をFeedback Serverへ取り込まない。
- Feedback障害をHost Applicationのreadinessや業務操作へ波及させない。
- ConnectorやFrontend Adapterはout-of-processまたはpackage境界で拡張し、Goのin-process pluginを採用しない。
- 公共部門向け証跡は専用ワークフローを肥大化させず、署名付きarchiveと標準的な搬送CLIを中心とする。
- 各Waveは単独release・rollback可能にし、次Waveの未完了を既存機能の利用条件にしない。

### 2.2 引き続き対象外とするもの

- Feedback ServerからHost Applicationデータを更新する双方向業務連携
- Host固有のsession/cookie実装をFeedback Server本体へ追加すること
- HTML本文、任意script、公開Object Storage URLの保存
- DOM selectorだけを永続anchorとして使用すること
- 任意のConnectorバイナリをServer processへ動的loadすること
- 利用者の同意や組織ポリシーを無視した本文・画面証跡の外部送信

## 3. Wave依存関係

```text
Go v1 parity complete
        │
        ▼
R0 Stabilize / GA
   ├──────────────┬─────────────────┐
   ▼              ▼                 ▼
R1 Distribution  R2 SDK contract   R9 Runtime evidence collection
   │              ├──────┬──────┐   │
   │              ▼      ▼      ▼   │
   │             R3     R4     R5   │
   │           Anchor   UI   Review  │
   ├──────────────┴──────┴──────┤   │
   ▼                            ▼   ▼
R6 Sidecar                  R7 Ecosystem
   └──────────────┬─────────────┘
                  ▼
          R8 Public / Private Operations
```

R1とR2はR0後に並行できる。R3/R4/R5もR2の公開契約が固定された後は別チームで並行できる。
R9はR0から計測を始めるが、topology変更は十分な実測を得るまで行わない。

## 4. Releaseと互換性の基準

### 4.1 Release段階

| 段階 | 判定 |
|---|---|
| `1.0.0-rc.*` | Go版default化、Kotlin撤去、14日観察を完了 |
| `1.0.0` | Go版で通算30日安定、4回以上のfull backup、restore drill、重大security未解決0件 |
| `1.x` | `/feedback/v1` の後方互換なAPI/schema/package追加 |
| `2.0` | 既存consumerを自動互換化できない変更が不可避な場合のみ |

Server image、CLI、`@feedback/contracts`、`@feedback/core` はrelease manifestで互換組合せを明示する。
すべてを同じversionに固定する必要はないが、CIで検証した組合せ以外を「対応」と表示しない。

### 4.2 Compatibility policy

- API majorはpathで表し、v1の破壊的変更を禁止する。
- schemaはpayload内の `schemaVersion` と `/capabilities` で交渉する。
- SDKのdeprecated APIは最低1 minor releaseかつ6か月の長い方を維持する。
- Serverは最新SDK minorと直前2 minorのconsumer conformanceを継続実行する。
- Connector ProtocolはServer APIと独立versionとし、manifestで対応範囲を宣言する。
- DB upgradeはversionを飛び越えず、N-1からNとfresh installの両方をrelease gateにする。

## 5. R0: Go版v1の安定化とGA

### 5.1 目的

Go移行中の暫定構成を製品baselineへ確定し、以後のロードマップが依存できる安定点を作る。

### 5.2 実施内容

- Go版のAPI/worker/CLI/imageを `1.0.0-rc` としてversion整合させる。
- OpenAPI、package metadata、CHANGELOGに残るalpha version差を解消し、release manifestを唯一のversion対応表にする。
- Kotlin比較専用testを通常のv1 regression suiteへ整理し、Go版だけで意味を説明できるfixture名へ変更する。
- 全環境変数、metrics、log field、object key、archive formatのsupport policyを文書化する。
- capacity test、24時間fault test、restore drill、key rotation drillを実施する。
- 未使用compatibility adapter、debug endpoint、移行専用feature flagへ削除期限を付ける。
- security response、dependency update、release signingのownerを決める。

### 5.3 Public interface

R0では新しい業務APIを追加しない。`/capabilities` にServer build、protocol、schemaの互換情報を追加する場合も、
既存fieldを変更せずoptional fieldとして追加する。

### 5.4 完了条件

- Go版で通算30日間、Sev 1/2、データ欠落、tenant越境が0件。
- full backupが4回以上成功し、そのうち1つを別環境へrestoreできる。
- 主要SLO、resource request/limit、DB pool、worker concurrencyの初期値が測定に基づいている。
- `1.0.0` artifactをclean environmentへ導入し、作成からbackup/notification/retentionまで完走できる。
- migration専用Kotlin比較fixture以外にJDK依存が残っていない。

## 6. R1: 独立repository・配布・upgrade経路

### 6.1 目的

現在のallowlist抽出物を一時生成物ではなくFeedback Platformの正本へ昇格し、`gis-example` をconsumerへする。

### 6.2 Repository構成

```text
feedback-platform/
├ contracts/
├ backend/
├ packages/
│  ├ core/
│  ├ widget-core/
│  ├ web-component/
│  ├ react/
│  ├ maplibre/
│  ├ admin-react/
│  └ testing/
├ apps/
│  ├ admin/
│  ├ token-broker-reference/
│  └ conformance-consumer/
├ deploy/
├ examples/
├ docs/
└ scripts/
```

移転は履歴を追跡できる方法で1回だけ実施し、同じsourceを両repositoryで編集する期間を作らない。
切替commit以降はFeedback Platform側を正本、`gis-example` 側をreleased artifactのconsumerとする。

### 6.3 Release artifact

- multi-arch OCI imageとdigest
- Linux amd64/arm64、Windows amd64、macOS arm64 binary
- npm package tarballとregistry package
- Docker Compose example
- checksum、CycloneDX SBOM、license inventory、provenance、署名
- release manifestとsupport matrix
- upgrade/rollback/migration notes

release manifestはartifact名、version、digest/checksum、対応protocol/schema、最低PostgreSQL versionを機械可読に記録する。

### 6.4 Upgrade

- N-1データを復元した環境でNへupgradeし、API、backup、connectorを検証する。
- fresh installとupgrade後schemaのfingerprintを一致させる。
- rollback可能/不可能の境界をrelease noteへ明記する。
- DB migrationとapplication rolloutを別stepで実行できるartifactを提供する。
- `gis-example` はsource copyではなくOCI/npm version更新だけで追随する。

### 6.5 完了条件

- 独立repositoryだけでbuild/test/package/smoke/release dry-runが成功する。
- `gis-example` からFeedback backend sourceを削除してもconformance E2Eが成功する。
- cleanなprivate registryへartifactを配置し、外部repository参照なしでinstallできる。
- 同一versionのartifact一覧と署名をrelease manifestから検証できる。

## 7. R2: Host Adapter・SDK・testing kitの1.0安定化

### 7.1 現状

`@feedback/core` は既に `FeedbackHostAdapter`、transport、manifest/location/target validation、capability negotiationを持つ。
R2では別のAdapter概念を作らず、これを正式なFrontend Integration Contractへ昇格する。

### 7.2 Public contract

`FeedbackHostAdapter` の責務を次へ固定する。

- `getContext`: application/environment/workspace/release/locale
- `getLocation`: manifestに基づくpage/route/path/query
- `getAccessToken` / `refreshAccessToken`: token lifecycle
- `getIdentity`: 表示用identity。認可根拠にはしない
- `navigate`: deep linkからHost routeへ遷移
- `captureEvidence`: Host固有の任意evidence capture
- participant name storage: memory/local/host policyへの対応

現行型を `FeedbackHostAdapterV1` として固定し、`FeedbackHostAdapter` は互換aliasとして維持する。
SPAとrouter固有処理をSDKへ埋め込まないため、次のoptional APIだけを後方互換で追加する。

- `subscribeLocation?(listener): () => void`: route変更時にProviderを再mountせずreview contextを更新
- `getDeepLinkThreadId?(): string | null`: query名やrouterに依存しないdeep link受領

AdapterはDOM、React、MapLibreの型を共通contractへ漏らさない。tokenやcookieをtelemetryへ送らない。

### 7.3 `@feedback/testing`

公式testing packageを追加し、任意Adapterへ同じconformance suiteを適用できるようにする。

- context/location schemaとmanifest照合
- query/path parameterのstore/hash/discard
- token refresh single-flightと401 recovery
- deep link navigation
- evidenceのMIME/size/timestamp
- unavailable時にHost UIを壊さないこと
- PII/tokenをlog、snapshot、errorへ含めないこと

fixture hostとしてVanilla TypeScript、React 18、React 19、MapLibreを維持する。

### 7.4 Typed clientとrequest lifecycle

- OpenAPI operation単位の型付き `FeedbackClient` を `@feedback/core` へ追加する。
- `sessions.list/create`、`threads.get/create/reply/updateStatus` 等をpath文字列なしで呼べるAPIを提供する。
- 低水準 `FeedbackTransport.request()` は互換用escape hatchとして維持するが、新規公式packageは型付きClientを使う。
- request optionへ `signal?: AbortSignal` を追加し、timeout時に実fetchを中断する。
- token refresh single-flight、ETag、Idempotency-Key、Rangeを型付きClientでも維持する。

UI state machineはR4の `@feedback/widget-core` へ分離し、`@feedback/core` にDOM/UI lifecycleを持ち込まない。

### 7.5 完了条件

- `@feedback/core`、`@feedback/testing` が1.0 public API reviewを通過する。
- Vanilla/React 18/React 19/MapLibre fixtureが同じconformance suiteを通る。
- package tarballをclean consumerへinstallしてtypecheck/build/testできる。
- auth failure、network timeout、unsupported capabilityでHost UIが継続利用できる。
- SPA route変更、deep link、request abort、token refresh single-flightをfixtureで検証する。
- bundle size、初期request数、listener解放をregression gateで監視する。

## 8. R3: Target v2とStable Anchor

### 8.1 目的

Target v1の安定キーを維持しつつ、画面改修、業務entity、任意Adapterへ拡張できるTarget v2を追加する。
CSS selectorや座標だけに依存せず、解決できないコメントも一覧から失わない。

### 8.2 Target v2 envelope

Target v2は次の概念を持つ。

- `schemaVersion: "2"`
- `kind`: `ui-element`、`screen-position`、`host-entity`、`adapter`
- 安定識別子: `anchorKey` または `stableKey`
- stable targetはelement内相対位置または地理的位置と、v1へ変換可能なfallbackを必須とする
- `adapter` targetでは `adapterKey`、`targetType`、bounded metadata

`host-entity` は `namespace`、`entityKey`、任意の `anchorKey` を持ち、Feedback Serverはentityの存在確認や業務DB参照をしない。
`adapter` metadataはapplication manifestが参照するversioned JSON Schemaに適合し、size/depth/property数を制限する。

### 8.3 Aliasと解決規則

manifest schema v2へroute aliasに加えてanchor aliasを追加する。

1. 現在releaseのexact stable key
2. 同一namespace内の直接aliasによるcanonical keyへの変換
3. Host/Adapter resolver
4. location単位のunresolved表示

aliasから別aliasへのchain、循環、canonical keyの再利用を禁止する。廃止keyは削除せず `retired` として履歴を保持する。
解決不能targetは削除せず、Admin/Thread Drawerで「位置未解決」として表示する。
自動的なtext quote、DOM全文、CSS selectorの永続化は既定で行わない。

### 8.4 Compatibility rollout

1. v1 SDKへ未知Targetを無視せずlocation-level fallback表示するtolerant readerを先行releaseする。
2. ServerへTarget v2 validation/storageとv1 fallbackへのdown-convertを追加するが、まだv2を生成しない。
3. Targetを返すすべてのAPIへ共通 `Accept-Feedback-Target-Schema` headerを追加し、未指定時はv1を返す。
4. `/capabilities.targetSchemaVersions` に `2` を追加する。
5. R2 Clientと公式Adapterへv2 opt-inを追加する。
6. manifest v2/Target v2をapplication単位で有効化する。

Target v1を変換・削除せず、Serverはv1/v2原文とschema versionを保持する。header未指定またはv1指定では、
v2 stable targetを必須fallbackのv1 `screen-position` / `map-position` へ変換する。v2 clientだけが明示的にv2を受け取る。

### 8.5 Acceptance

- element key変更をaliasで追跡できる。
- route template/parameter変更後もmanifest aliasとentity keyで解決できる。
- MapLibre style reload、source layer表示切替後もfeature anchorを再表示できる。
- 削除済みentityや未導入AdapterでもThread本文を閲覧できる。
- v1/v2 threadが同じsessionへ混在し、export/backup/notificationが両方を保持する。
- metadataへtoken、evidence、巨大値、未知schemaを保存できない。

## 9. R4: Web Componentとframework binding

### 9.1 目的

Reactを導入していないHostへ同等UIを提供し、React packageとの機能差を共通Runtimeとconformanceで抑える。

### 9.2 Package

Reactに埋まっているcontext取得、thread cache、compose、reply、status更新、evidence lifecycleを
framework非依存の `@feedback/widget-core` controllerへ抽出する。`@feedback/web-component` は同じcontrollerを使い、
`<feedback-widget>` custom elementを提供する。

- UIはShadow DOMで分離する。
- endpointや表示設定は属性でも指定できるが、token/Adapter/RuntimeはJavaScript propertyだけで渡す。
- `feedback-ready`、`feedback-unavailable`、`feedback-thread-open` のtyped eventを公開する。
- themeはCSS custom propertyと限定した `::part` で提供する。
- inline script/evalへ依存せず、strict CSPで動作する。
- global side effectで自動登録せず、`registerFeedbackWidget()` でtag名を明示登録する。
- disconnect時にcontroller、observer、in-flight request、event listener、object URLを解放する。

### 9.3 Reactとの関係

- 既存 `FeedbackProvider`、`FeedbackOverlay`、hooksを1.xで維持する。
- ReactとWeb Componentは `@feedback/widget-core` の同じcommand/event/state transitionを利用する。
- React packageを即座にcustom element wrapperへ置換せず、visual/conformance差分が0になってから内部実装を共通化する。
- React 18/19 peer dependencyとSSR import safetyを維持する。

### 9.4 UX、Accessibility、Localization

- keyboardだけでpin、投稿、thread、closeへ到達できる。
- focus trap/restore、ARIA live、contrast、zoom、reduced motionを検証する。
- WCAG 2.2 AAを目標とし、自動検査とscreen reader手動試験をrelease gateにする。
- 日本語と英語のmessage catalogを標準提供し、Hostがcatalogを差し替えられる。
- overlay z-index、portal/shadow root、mobile viewport、high-DPI evidenceをfixture化する。

### 9.5 完了条件

- Vanilla、React、Web Componentで投稿・pin・thread・evidence・deep linkが同じE2Eを通る。
- Shadow DOM/CSP/SSR/複数widget同居でglobal stateやstyleが衝突しない。
- Host無効化時にlazy chunk、network request、global listenerを残さない。
- public events/properties/CSS tokenをAPI reportで固定し、semver差分をCI検査する。

## 10. R5: Review workflowの再利用と運用高度化

### 10.1 現状

sessionはdraft/open/closed、page/route scope、perspective、posting policy、start/endを既に持つ。
R5は別モデルへ置換せず、繰り返しレビューと複数application運用を容易にする。

### 10.2 Review profile

繰り返し利用するレビュー定義を `review profile` として追加する。

```text
GET/POST  /feedback/v1/review-profiles
GET/PATCH /feedback/v1/review-profiles/{profileId}
POST      /feedback/v1/review-profiles/{profileId}/archive
GET       /feedback/v1/review-profiles/{profileId}/versions
POST      /feedback/v1/review-profiles/{profileId}/sessions
```

Profileはworkspace/application単位で、name、description、manifest version、scope群、perspective群、
out-of-scope policy、versionを持つ。

- Profile更新は既存sessionへ伝播させない。
- session生成時にProfile ID/versionと全設定のimmutable snapshotを保存する。
- 使用済みProfileは物理削除せずarchiveする。
- 既存 `POST /sessions` はone-off session用として維持する。
- Profile参照は `feedback.read`、作成/更新は `feedback.manage`、application横断操作だけ `feedback.admin` とする。

### 10.3 Perspectiveとscope

- perspective codeはapplication内の安定IDとし、label/guidanceのversion履歴を保持する。
- future/out-of-scope statusをAdmin UIで視覚化し、投稿時warning/denyを維持する。
- scopeはpageKey/routeTemplateに加え、manifest group単位の展開をProfile snapshot作成時に解決する。
- session開始後のscope/perspective変更はversioned audit対象とし、既存threadのperspectiveを暗黙変更しない。
- manifest更新で存在しなくなったpage/perspectiveも過去snapshotとexportから失わない。

### 10.4 Thread workflow

既存 `open/resolved` を旧client向けprojectionとして維持し、version付きworkflow resourceを追加する。

```text
GET/PATCH /feedback/v1/threads/{threadId}/workflow
POST      /feedback/v1/thread-workflow-batches
GET       /feedback/v1/sessions/{sessionId}/workflow-summary
```

workflow stateは `untriaged`、`triaged`、`in-progress`、`resolved`、`rejected`、`duplicate` とする。
assignee、labels、dueAt、resolutionCode、duplicateOfThreadId、versionを保持する。

- 通常遷移は `untriaged -> triaged -> in-progress -> resolved`。
- open系状態から `rejected` / `duplicate` へ遷移できる。
- terminal状態からreopenした場合は `triaged` へ戻す。
- terminal状態はresolutionCode必須、duplicateは同一workspaceのduplicate先必須。
- assigneeは同一workspace memberだけを許可する。
- 旧status APIではopen系を `open`、terminal状態を `resolved` として返す。
- 旧statusをresolvedへ変更した場合はworkflowを `resolved`、reopen時は `triaged` へ写像する。
- batchは最大100件、各version必須、単一transactionのall-or-nothingとする。

workflow変更はaudit、change journal、backup/exportへ含める。
Connectorにはopt-inの `feedback.thread.workflow-changed.v1` eventを追加し、supportedEvents未宣言の既存Connectorへ送らない。

### 10.5 Administrationとreporting

- Profile作成・複製・archive、version履歴、session preview、開始/終了をAdmin UIへ追加する。
- assignee、label、期限、workflow state filter、一括遷移、期限超過summaryを追加する。
- perspective/workflow/page/application別の集計を提供するが、本文の自動分析は必須機能にしない。
- 集計結果はCSV export可能とし、元thread/messageへのdeep linkを維持する。
- Host業務データの更新や承認workflowは行わず、外部連携は明示設定されたConnector eventに限定する。

### 10.6 Migrationとacceptance

- Profile/workflow tableをexpand migrationで追加し、既存sessionはProfileなし、既存threadは互換statusから初期workflowをbackfillする。
- dual-write期間は旧statusとworkflow projectionの一致を監視し、全instance更新後にworkflowを正本化する。
- Profile snapshotとworkflow履歴をbackup/export/auditへ含める。
- Profile更新後も既存session snapshotが不変である。
- 並行workflow更新は412となり、batchの一部だけが更新されない。
- workspace越境assignee/duplicate参照は404となる。
- 旧clientのopen/resolved表示、status更新、notificationが維持される。

## 11. R6: 任意のGo Sidecar

### 11.1 採用条件

Sidecarは全利用者の必須経路にしない。次のいずれかが必要な環境で採用する。

- BrowserからFeedback Serverへ直接到達できない。
- same-origin、Hostのopaque session、企業proxy/mTLS境界を吸収する必要がある。
- Hostごとにtoken exchange client credentialを隔離したい。
- attachment streamやegress policyをapplication pod単位で制御したい。

direct OIDCと既存token broker経路で要件を満たす場合はSidecarを追加しない。

### 11.2 責務

- same-origin `/feedback/*` reverse proxy
- 既存Token Exchange契約のmTLS endpoint
- `kid` 付き短寿命Feedback JWTの発行とJWKS公開
- CSRF、body size、timeout、request/correlation ID
- attachmentのstream proxy
- Feedback障害時のfeedback-specific 503と短いcircuit break

永続化、permission policy、review rule、notification、長期cacheは持たない。tokenはmemoryだけに保持しTTLを超えて再利用しない。

### 11.3 Deployment profileとtrust boundary

次のprofileを同じconformance suiteで維持する。

- `direct-oidc`: 現行どおりFeedback audienceのBearer JWTでServerへ接続
- `token-exchange`: Host backendがsessionを検証し、既存brokerから300秒以下のFeedback JWTを取得
- `sidecar-exchange`: Host backendがmTLSでSidecarの既存Token Exchange endpointを呼ぶ
- `sidecar-proxy`: Sidecarが同一origin `/feedback/v1/*` をServerへ透過中継

opaque cookieはHost backendだけが検証する。SidecarはBrowser由来の `X-User`、`X-Roles`、forwarded identity headerを
本人性・権限の根拠にしない。mTLS identityごとにtenant/application/environment/workspace/permission上限を持ち、
要求との積集合だけをJWTへ含める。

proxy upstreamは起動設定した単一originだけを許し、request由来URLを使用しない。
hop-by-hop headerと外部由来identity headerを除去し、path/body/status/Range/ETag/Idempotency-Key/Problem Detailsを変換しない。

### 11.4 Deploymentとacceptance

- Kubernetes sidecar、systemd localhost proxy、Compose exampleを提供する。
- readinessはSidecar単体とupstream degradedを分け、Sidecar障害をHost container readinessへ連結しない。
- Keycloak direct bearer、token broker、opaque cookie Host backendの3 fixtureを検証する。
- mTLS不正、権限過剰要求、CSRF、header spoofing、JWT replay、JWKS rotation、broker timeoutをnegative testする。
- Range download、stream upload、429/503、client切断でbody破損や再送増幅が起きない。
- SidecarにFeedback DB/Object Storage資格情報を与えない。
- Sidecarなし/ありで同じFeedback API conformanceを通す。

## 12. R7: Connector・Adapter ecosystem

### 12.1 Connector

Connector Protocol v1を維持し、第三者がServer変更なしでConnectorを提供できるtoolingを追加する。

- manifest/schema validator CLI
- delivery captureとduplicate/retry conformance suite
- reference test serverとfixture event
- OCI image metadata、protocol範囲、health、必要egress、secret名の宣言
- sample Webhook connector template

配布metadata `connector-package.json` にconnector key/version、対応protocol/event、OCI image digest、license、
SBOM digest、署名を記録する。宛先、credential、secretは含めない。

Connector catalogはmetadataと検証結果だけを管理し、Serverが任意imageを自動pull/実行しない。
導入はoperatorが署名、allowlist、network policy、secret scopeを確認して行う。
検証tierは `first-party`、`verified-third-party`、`unverified` とし、verified結果は試験したversion/digestだけに付与する。

### 12.2 Frontend Adapter

公式Adapterは `@feedback/testing` を通し、Target schemaとlifecycleだけを担当する。

- MapLibre AdapterをTarget v2へ対応する。
- DOM/Router固有処理をReact packageから段階的にAdapterへ抽出する。
- AdapterはHost認証、Server URL、permissionを決めない。
- Adapter packageごとにpeer dependency範囲とsupport matrixを公開する。

### 12.3 Versioningとacceptance

- Connector Protocol、Target schema、npm packageを独立versionにする。
- Serverは対応範囲外manifestを登録時に拒否する。
- sample third-party Connector/Adapterを本体repository外でbuildし、公開artifactだけからconformanceを通す。
- connector crash、duplicate、slow responseがServer APIと他connectorへ波及しない。
- tampered/unsigned artifact、digest不一致、過剰egressをinstallation前に検出する。

## 13. R8: 閉域・公共部門向け運用

### 13.1 Offline distribution

1つのoffline bundleへ次を含める。

- OCI image archiveとdigest
- npm tarball、Go CLI binary
- Compose/Helm/systemd example
- DB migration、checksum、署名検証tool
- CycloneDX SBOM、license、脆弱性scan結果
- install/upgrade/rollback/backup/restore手順

bundle作成後のinstallはpublic internet、public registry、telemetry SaaSを要求しない。
private CA、HTTP proxy、private OIDC、MinIO、private SMTP/Webhookを設定可能にする。

### 13.2 Evidenceとbackup搬送

- Feedback本文・message履歴・audit・設定・connector結果をfull/incremental archiveへ維持する。
- object storageへの定期出力と `feedback-backup-pull` による共有ファイルサーバ搬送を標準経路とする。
- archive manifestへformat version、coverage、cursor、entry checksum、生成buildを記録する。
- 既存ZIP byte列を変えずに任意のdetached署名とkey IDを追加できるようにする。
- remote archiveをCLIから削除せず、保存期間はServer policy/Object Storage lifecycleへ委ねる。
- Object Lock/WORMはstorage capabilityとして任意対応し、必須依存にしない。
- pullごとにarchive ID、workspace、checksum/署名結果、取得時刻、配置先相対path、終了codeをappend-only搬送台帳へ残す。
- SMB/NFS/SFTP資格情報をFeedback Serverへ渡さず、pull実行hostだけが共有サーバ資格情報を持つ。

### 13.3 Security profile

- non-root、read-only root filesystem、secret file非同梱、egress allowlist
- customer-managed key、旧鍵rotation、custom CA
- auditとapplication logへ本文、token、secret、evidenceを出さない
- security patch用offline差分bundle
- FIPS等の準拠は対象環境・Go cryptographic module・運用を個別検証し、未認証状態で準拠を標榜しない

API、各worker、connectorごとの許可egress表をreleaseし、閉域profileでは未記載宛先をnetwork policyでdenyする。

### 13.4 DRと運用証跡

- DB backupとObject Storage versioning/archiveを同じrecovery pointとして管理する。
- 標準/強化profileごとに組織がRPO/RTOを設定し、runbookへ実測値を記録する。
- 少なくとも年2回のrestore drillを想定し、archive checksum、件数、cursor、deep linkを検証する。
- upgrade/rollback、鍵rotation、connector追加、retention変更を監査対象にする。

### 13.5 完了条件

- internet非接続のclean networkでinstall、OIDC login、投稿、backup pull、restoreを完走する。
- private CA/registry/MinIO/SMTPだけの構成でruntime egress違反がない。
- artifact、SBOM、license、scan、署名、運用手順がrelease単位で対応付けられる。
- backup CSVを特定製品なしで標準toolから閲覧でき、manifestから改変を検出できる。

## 14. R9: Workerとscaling topologyの最適化

### 14.1 計測を先行する

R0から次をworkspace/job type別に収集し、Go GA後30日以上の本番相当データをtopology変更の入力にする。

- API request rate/latency/error
- DB pool wait、transaction時間、lock wait/deadlock
- outbox/connector/export/backup/retention queue depthとoldest age
- claim数、retry、lease expiry、duplicate
- Object Storage throughput/error
- process RSS/CPU/GC、startup/shutdown時間

本文、target metadata、user identifierをmetric labelにしない。

### 14.2 Deployment profile

- `compact`: 小規模・単一node向け。`feedback-worker --roles=notification,export,backup,retention` で複数roleを起動
- `standard`: API、notification、export/backup、retention、connectorを別processにする現行相当。production既定
- `scale`: API、notification、export、backup、retentionを個別deploymentとしてrole別にhorizontal scale

既存entrypointを維持し、roleごとにconcurrency、timeout、shutdownを独立させる。
`feedback-export-worker` のexport+backup互換を維持し、scale profileで専用backup roleを使う場合はqueue ownershipを排他的にする。
1 roleのpanic/fatal errorで他roleのclaim状態を壊さない。

### 14.3 Scale-out profile

- APIと各workerは同じbinaryから個別horizontal scaleできる状態を維持する。
- queue lagに応じたworker replica/concurrency調整例を提供する。
- claim完了更新はtoken/fencing条件付きとし、期限切れworkerが新ownerの結果を上書きできない。
- PostgreSQL queueを先にindex、batch、claim size、transaction短縮で改善する。
- external queue導入は、最大安全concurrencyでもqueue age SLOを継続超過し、DB lock/IOが主因である証跡がある場合だけADRで判断する。
- table partitioning/read replicaも容量・query plan・復旧時間の実測を導入条件とする。

### 14.4 Performance gate

- small/standard/large fixtureを固定し、release間benchmarkを保存する。
- scaling変更前後でat-least-once、順序、cursor、audit、duplicate意味論を変えない。
- 24時間load/fault test後に未回収lease、永久running job、cursor gapが0である。
- topology選択を環境変数とdeployment manifestだけで行え、API契約を変更しない。

## 15. Program-level test matrix

| Dimension | 必須fixture |
|---|---|
| Frontend | Vanilla、React 18、React 19、Web Component、MapLibre |
| Authentication | direct OIDC、token exchange、Sidecar mTLS exchange/proxy、invalid/replay |
| Deployment | Compose、Kubernetes、systemd、offline private registry |
| Storage | PostgreSQL 16、AWS S3互換、MinIO、filesystem dev adapter |
| Upgrade | fresh、N-1→N、rollback可能境界、backup restore |
| Target | v1/v2混在、alias、unresolved、MapLibre reload |
| Review | profile snapshot、workflow、scope/perspective変更、out-of-scope policy |
| Connector | reference 4種、third-party fixture、duplicate/timeout/429 |
| Accessibility | keyboard、screen reader、contrast、zoom、reduced motion |
| Security | tenant越境、SSRF、XSS、CSRF、JWT、secret/PII log漏えい |

各Waveは該当行のfixtureを追加し、既存行を削除して合格させてはならない。

## 16. Product metricsと中止条件

### 16.1 成功指標

- 新規Hostが既存backend SDKなしで導入できる。
- Adapter conformance違反を導入前に検出できる。
- 画面改修後のunresolved target比率を測定し、aliasで低減できる。
- Feedback障害がHost業務画面のavailabilityへ波及しない。
- backup成功、共有サーバ搬送、restore drillを組織ポリシーに合わせて運用できる。
- third-party Connector追加にServer改修が不要である。

### 16.2 Wave中止・再設計条件

- 新機能のためにv1 consumerを暗黙破壊する。
- Host DB参照や任意identity header信頼が必要になる。
- schema/worker変更でrollback経路を説明できない。
- package/Connector拡張が本体releaseとのlockstepを要求する。
- public/private deploymentの一方だけを成立させるhard dependencyを導入する。

条件に該当したWaveは実装を継続せず、ADRとcontract proposalへ戻す。

## 17. 最終到達状態

- Feedback Platformが独立repository、独立release、署名付きartifactを持つ。
- Go Serverを中央配置またはapplication隣接で利用できる。
- direct OIDC、token exchange、任意Sidecarを環境に応じて選択できる。
- `@feedback/core`、React、Web Componentを同じClient/widget controller契約で利用できる。
- Target v1/v2とaliasにより位置未解決を安全に扱える。
- review profile、thread workflow、scope/perspectiveで反復レビューを運用できる。
- Connector/Adapterを本体変更なしで追加し、conformanceを検証できる。
- SaaS、Kubernetes、systemd、閉域offline環境へ同じprotocolで配備できる。
- 定期archiveをObject Storageから共有ファイルサーバへ搬送し、標準形式で証跡管理できる。
- 小規模統合workerと大規模分離workerを、APIやデータ互換性を変えず選択できる。
