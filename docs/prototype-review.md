# プロトタイプレビュー管理基盤 — 設計構想と実装計画

業務アプリケーション + GIS (MapLibre) のプロトタイプに対し、顧客・利用者が非同期で
レビューコメントを付け、開発側とスレッド形式で対話・解決管理するための基盤。

本書は設計の SSoT。Phase 0 (技術検証) の実測結果は [第 4 章](#4-phase-0-検証結果-実測) に記録する。

---

## 1. 目的

単なるバグ報告ツールではなく、公共部門・大規模業務システム開発で繰り返し起きる以下の問題を解く。

- 顧客の繁忙により、同期的なレビュー会議を十分に確保できない
- プロトタイプを自由に見せると、今回検証したい事項と無関係な指摘に議論が拡散する
- 「何を確認してもらったか」「何はまだ確認対象でなかったか」が後から曖昧になる
- 画面・地図・業務データを含む指摘のコンテキストを、文章だけでは正確に共有しにくい
- プロトタイプが頻繁に更新されるため、後から当時の画面状態を完全再現できない
- 権限・証跡・監査・データ保護を、通常の SaaS 型フィードバックツール以上に厳格に管理したい

中核機能は次の 6 つ。

1. レビュー対象・レビュー観点の明示
2. 画面上の位置・UI 要素・GIS 地物に紐づくコメント
3. コメント時点の画面を証跡として固定化
4. コメントへの返信・状態管理
5. レビューセッション単位の合意形成管理
6. 権限・監査ログ・証跡管理

---

## 2. 基本思想

### 2.1 中心概念は `Feedback` ではなく `ReviewSession`

レビューセッションごとに「何を見てもらうのか / どの画面か / どの観点か / 何は今回見てほしくないか /
誰がレビューできるか / いつまで可能か」を定義する。これによりレビューを「自由な感想収集」ではなく、
目的を持った検証活動として管理する。

### 2.2 レビュー対象外を「未完成」と同一視しない

プロトタイプではすべてを同じ成熟度で確認できない。初期フェーズでは業務フロー・情報の過不足・
GIS 連動を見たい一方、配色・文言・権限制御・性能・例外処理は後続フェーズで検証する。
そこでレビュー観点に状態を持たせる。

| 状態 | 意味 | UI |
|---|---|---|
| `ACTIVE` | 今回レビューしてほしい | 選択可 |
| `FUTURE` | 今回は選択不可だが、今後レビュー予定 | グレーアウト表示 |
| `OUT_OF_SCOPE` | 今回のプロトタイピングでは原則対象外 | グレーアウト表示 |

`FUTURE` を **表示したうえで選択不可** にすることが要点。「今は見る必要がない」ことと
「存在を忘れている」ことを、顧客から見て明確に区別できる。

### 2.3 過去画面の再現は狙わない

プロトタイプは frontend / backend / API / DB スキーマ / 業務データ / タイルが短期間で変化する。
状態 JSON を保存して将来再レンダリングする方式は、過去 frontend・過去 backend・過去データの保持と
API バージョニングと状態 migration を要求し、レビュー用途には過剰。したがって:

> **将来画面を再現するのではなく、コメント投稿時点のレンダリング結果を証跡として固定化する。**

---

## 3. 想定ユーザー体験

### 3.1 レビュー開始

レビュー用 URL を開くと、最初にレビューセッションの説明を表示する。

> **今回確認いただきたいこと**
> - 案件検索から詳細確認までの業務フロー
> - 地図と案件情報の連動方法
> - 詳細画面に表示すべき情報の過不足
>
> **今回は確認不要です**
> - デザイン・配色 / 性能 / 権限制御 / 詳細なエラー処理

### 3.2 コメントの付与

画面右下の「フィードバック」ボタンでレビューモードに入り、
(1) 対象箇所をクリック → (2) レビュー観点を選択 → (3) コメント入力 → (4) 投稿。
観点の選択肢は `ReviewSession` の設定に従い、`FUTURE` / `OUT_OF_SCOPE` は選択不可。

### 3.3 コメント対象

| 種別 | 対象 | 保持する情報 |
|---|---|---|
| UI 要素 | 入力項目・ボタン・一覧・タブ・モーダル | `data-feedback-id` の安定 ID + 相対座標 |
| 画面座標 | 安定 ID を付けられない箇所・画面全体 | ビューポート相対座標 (0〜1) |
| GIS 地物 | MapLibre 上の地物 | 経緯度 + source / sourceLayer / featureId |
| GIS 地点 | 地物に当たらなかった地図上の位置 | 経緯度 |

座標を px ではなく 0〜1 の相対値で持つのは、画面サイズ差にある程度耐えさせるため。
地図では DOM 要素が存在しないため、「画面のこの辺」ではなく「この地物について」の意味を保持する。

実装は `apps/web/src/review/target.ts` (`resolveScreenTarget` / `resolveMapTarget`)。

---

## 4. Phase 0 検証結果 (実測)

MapLibre 込みキャプチャが本基盤最大の技術的不確実性であるため、最初にスパイクを実施した。

- 検証ページ: `apps/web/spike/review-capture/` (本番バンドル対象外)
- 実装: `apps/web/src/review/capture.ts` (`captureViewport`)
- 環境: Chromium (Playwright 1.56 同梱)、ビューポート 1440x900、html-to-image 1.11.13、maplibre-gl 5.x

再現手順:

```bash
npm --workspace apps/web run dev
# http://localhost:5173/spike/review-capture/index.html
#   ?pdb=0                        preserveDrawingBuffer を無効にした対照実験
#   ?raster=http://other:5199     別オリジンのラスタタイルを重ねる (CORS 検証)
```

「証跡をキャプチャ」を押すと、生成した PNG を自身で再解析し、地図領域・DOM 領域それぞれの
白紙率と平均色を JSON で表示する (目視だけに頼らないため)。

### 4.1 完了条件の判定

> 顧客がビューポート上で見ている情報が、レビュー証跡として実用上十分な精度で 1 枚の画像として保存できること。

**達成。** 業務 DOM (日本語テキスト・SVG・入力欄・スクロール領域)、MapLibre の WebGL 描画
(ラスタタイル・ベクタ地物)、Marker、Popup、NavigationControl、attribution が 1 枚の PNG に合成された。

| シナリオ | pixelRatio | 所要 | PNG サイズ | 地図領域の白紙率 | 判定 |
|---|---:|---:|---:|---:|---|
| 標準 (dpr=1) | 1 | 157 ms | 65 KB | 0.4 % | 地図が写る |
| 別オリジンのラスタタイル (CORS 有) | 1 | 168 ms | 70 KB | 6.9 % | タイルが写る |
| 高 DPI 端末 (dpr=3) | 2 (上限で丸め) | 1,493 ms | 191 KB | 0.4 % | 地図が写る |
| **対照: `preserveDrawingBuffer` 無効** | 1 | 221 ms | 65 KB | **99.8 %** | **地図が消える** |

### 4.2 判明した前提条件

1. **`preserveDrawingBuffer: true` が必須。** WebGL の既定 (`false`) では、フレーム合成後に
   `canvas.toDataURL()` が空画像を返す。**例外は発生しない**ため、設定を落とすと
   「地図だけ真っ白な証跡」が静かに量産される。上表の対照実験がこれを再現している。
2. **MapLibre v5 では `canvasContextAttributes` の下に置く。** v4 までのトップレベル
   `preserveDrawingBuffer` 指定は型エラーになり、仮に通っても無視される。
3. 設定漏れは実行時に気付けないため、二重に守る:
   - `findUnreadableMapCanvases()` が `preserveDrawingBuffer` 無効な地図 Canvas を検出する
     (スパイクでは対照実験のみ 1 件を検出、他は 0 件)
   - `capture.test.ts` が `MapPane.tsx` の配線そのものを固定する

### 4.3 その他の実測事項

- **スクロール補正**: `scrollY=300` の状態でキャプチャすると、画像サイズはビューポートと同じ
  1440x900 で、文書座標 y=1000 の要素が画像内 y≈760 に現れる。フルページではなく
  「顧客がいま見ている 1 画面」を切り出せている。
- **高 DPI**: `devicePixelRatio=3` をそのまま使うと PNG が肥大するため上限 2 で丸める
  (`defaultMaxPixelRatio`)。所要時間は 1.5 秒程度まで伸びるので、投稿 UI 側で待ちを見せる必要がある。
- **CORS**: 別オリジンのタイルは `Access-Control-Allow-Origin` があれば証跡にも写る。
  無い場合、MapLibre のタイル取得そのものが CORS で失敗する (`AJAXError: Failed to fetch`) ため、
  地図にタイルが出ないだけで、**キャンバスが汚染されてキャプチャが失敗することはない**。
  つまり「地図が表示できている = 証跡にも写せる」と考えてよい。
- **レビュー UI 自身の除外**: `data-review-exclude` を付けた要素 (フィードバックボタン等) は
  証跡に含まれない。
- **Popup / Marker / コントロール**: いずれも再現される。ただし MapLibre の Popup は既定で
  `closeOnClick: true` のため、コメント対象を選ぶクリックで閉じる点に注意 (Phase 3 で扱う)。

### 4.4 未検証・残課題

- 本番と同じベクタタイル (`/api/tiles`) + 認証付き `transformRequest` 経路でのキャプチャ
- Web フォント (外部 CSS) を使う場合の埋め込み。失敗時の退避として `skipFonts` を用意済み
- Safari / Firefox での再現性 (今回は Chromium のみ)
- 巨大 DOM (数千ノード) での所要時間

---

## 5. 全体アーキテクチャ

```text
┌────────────────────────────────┐
│ Business / GIS SPA (apps/web)  │
│  Business UI      MapLibre     │
│       └──────┬───────┘         │
│      Review Overlay / SDK      │
│  - ReviewScope 表示            │
│  - Perspective 選択            │
│  - Target 取得                 │
│  - Screenshot 生成             │
│  - Comment UI                  │
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ Review API (apps/api)          │
│  ReviewSession / FeedbackThread│
│  Message / Status              │
│  Authorization / Audit         │
└──────────┬──────────┬──────────┘
           ▼          ▼
     PostgreSQL   Object Storage
     (PostGIS)    (Screenshot)
```

本リポジトリへの当てはめ:

| 要素 | 本リポジトリでの実体 |
|---|---|
| API | `apps/api` (Ktor)。ルートは `authorizedRoutes` で `RouteAuthz` 宣言必須 |
| メタデータ | 既存 PostgreSQL (`app` スキーマ)。DDL は Flyway migration (`V*.sql`) が SSoT |
| スクリーンショット | 既存の `UploadStorage` (dev: local / 本番: S3)。DB に binary を入れない |
| 認証 | 既存 OIDC (`Auth.kt`)。レビュー機能独自のユーザー管理は作らない |
| 監査 | 既存 `AuditLog.kt` + `AuditChange.kt` (before/after を必須引数で受ける) |

### 5.1 RDB を第一候補とする理由

ドキュメント DB でも実装可能だが、`ReviewSession → Thread → Message` の関係が明確で、
権限管理との結合が多く、状態・検索・一覧・集計が増え、監査証跡を SQL で追え、
トランザクション整合性を扱いやすい。既存 DB がそのまま使える点も大きい。

---

## 6. 主要ドメインモデル

```text
Project           projectId / name / organizationId / status
ReviewSession     reviewSessionId / projectId / title / description / startAt / endAt / status / createdBy
ReviewScope       reviewScopeId / reviewSessionId / pageId / description / reviewable
Perspective       perspectiveId / code (BUSINESS_FLOW, INFORMATION, USABILITY, MAP_OPERATION,
                  UI_DESIGN, PERFORMANCE, AUTHORIZATION, ERROR_HANDLING …)
SessionPerspective  reviewSessionId / perspectiveId / status (ACTIVE|FUTURE|OUT_OF_SCOPE) / guidance
FeedbackThread    threadId / reviewSessionId / reviewScopeId / perspectiveId / targetType /
                  targetMetadata / evidenceId / applicationVersion / status / createdBy / createdAt
FeedbackMessage   messageId / threadId / authorId / body / createdAt / editedAt
Evidence          evidenceId / threadId / screenshotPath / viewportWidth / viewportHeight /
                  scrollX / scrollY / pixelRatio / frontendVersion / route / capturedAt
```

- 画面ごとに観点を変えたい場合は `ReviewScopePerspective` で上書きする
- `Evidence` の各項目は `captureViewport()` の戻り値 (`ViewportEvidence`) と 1:1 で対応する
- 監査は既存 `app.audit_logs` に載せる。最低限、Thread 作成 / Message 投稿 / 編集 /
  Resolve / Reopen / ReviewSession 変更 / ReviewScope 変更 / 権限変更を記録する

### 6.1 targetMetadata

`apps/web/src/review/types.ts` の `FeedbackTarget` をそのまま JSON で格納する。

```json
{ "type": "UI_ELEMENT", "feedbackTargetId": "contract-expiration-date", "relativeX": 0.63, "relativeY": 0.41 }
{ "type": "SCREEN_POSITION", "relativeX": 0.63, "relativeY": 0.41 }
{ "type": "MAP_FEATURE", "longitude": 139.7001, "latitude": 35.6902,
  "source": "parcel", "sourceLayer": "parcel", "featureId": "123456" }
{ "type": "MAP_POSITION", "longitude": 139.7001, "latitude": 35.6902 }
```

### 6.2 スレッドの状態

MVP は `OPEN` / `RESOLVED` の 2 値から始め、必要になれば
`NEED_CUSTOMER_RESPONSE` / `IN_PROGRESS` を足す。状態遷移そのものより
**誰が Resolve できるか・Resolve / Reopen の履歴が追えるか**を優先する。

---

## 7. 権限管理

レビュー機能独自の簡易ユーザー管理は作らず、既存の認証・認可基盤 (`Auth.kt` /
`Authorization.kt`) と統合する。ロールが何をできるかは
[`docs/authorization.md`](authorization.md) の原則どおりコード側の純粋関数に置く。

| Role | 主な権限 |
|---|---|
| Reviewer | コメント、返信、閲覧 |
| CustomerAdmin | 顧客側メンバー管理、コメント閲覧 |
| Developer | 返信、ステータス変更 |
| ReviewManager | ReviewSession / Scope 管理 |
| SystemAdmin | システム管理 |

証跡の扱いで外してはいけない原則:

- スクリーンショットを公開バケットに置かない
- URL を知っているだけで他案件のフィードバックを閲覧できないようにする
- 取得は必ず API 側で認可を通す (直リンクを配らない。必要なら短期 URL に限る)

---

## 8. レビュー画面の UX

### 8.1 Review Guide

画面上部または右 Drawer に、常時確認できるガイドを置く。

```text
今回確認してほしいこと    ✓ 業務フロー  ✓ 情報の過不足  ✓ 地図操作
今後確認予定              － デザイン・配色  － 権限制御
今回対象外                － 性能
```

### 8.2 Feedback Overlay

通常操作を邪魔しないよう Overlay として実装し、業務画面側に個別実装を極力入れない。

```text
ReviewProvider / ReviewGuide / FeedbackOverlay / FeedbackTarget
FeedbackMapAdapter / FeedbackDrawer / FeedbackThread / ScreenshotCapture
```

Overlay 自身の DOM には `data-review-exclude` を付ける (証跡に自分が写り込まないようにする)。

---

## 9. API 案

エンドポイントを追加するときは AGENTS.md の手順 (RouteAuthz 宣言 → openapi.yaml 追記 →
生成型の再生成 → verify) を 1 PR に収める。

実装済み (Phase 1):

```http
GET   /api/review-sessions?projectId=...     # 観点・対象画面を含む (REVIEW_READ)
GET   /api/review-sessions/{id}              # 同上 (REVIEW_READ)
POST  /api/review-sessions                   # 観点・対象画面をまとめて指定 (REVIEW_MANAGE)
PATCH /api/review-sessions/{id}              # 観点・対象画面はキー指定時のみ全置換 (REVIEW_MANAGE)
```

今後 (Phase 2 以降):

```http
POST  /api/review-sessions/{id}/threads      # multipart/form-data (metadata JSON + screenshot)
GET   /api/review-sessions/{id}/threads
GET   /api/threads/{threadId}
POST  /api/threads/{threadId}/messages
PATCH /api/threads/{threadId}/status
```

---

## 10. 非機能要件 (公共部門向け)

- **監査**: 操作ログ / コメント履歴 / 状態変更履歴 / 権限変更履歴 / ReviewScope 変更履歴
- **データ保護**: スクリーンショットには個人情報・地理情報・業務情報が含まれうる。
  保存時暗号化 / 転送時暗号化 / 非公開ストレージ / アクセス制御 / 保存期間 / 削除方針を設計する
- **保存期間**: Project / ReviewSession 単位で設定できる余地を残す
  (プロトタイプ期間のみ / 本番稼働まで / 契約終了後 X 年)
- **閉域**: 外部 SaaS へスクリーンショットを送らない。組織内クラウド・閉域構成に
  配置できる独立コンポーネントとする

---

## 11. 実装計画

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | Screenshot スパイク (DOM + MapLibre 合成) | **完了** (第 4 章) |
| 1 | ReviewSession / Perspective / ACTIVE・FUTURE・OUT_OF_SCOPE / ReviewGuide / ReviewScope | **完了** |
| 2 | Feedback Mode / 画面位置クリック / 観点選択 / コメント入力 / 証跡保存 / Thread 作成 | 未着手 |
| 3 | `data-feedback-id` の付与 / FeedbackMapAdapter / コメントピン表示 | 未着手 |
| 4 | Thread Drawer / Message 一覧 / Reply / OPEN・RESOLVED / Reopen | 未着手 |
| 5 | 管理画面 (一覧・フィルタ・証跡確認・セッション別/観点別集計) | 未着手 |
| 6 | AuditLog / Project・Session アクセス制御 / 証跡アクセス制御 / 編集履歴 / 保存期間 | 未着手 |
| 7 | 通知・外部連携 (Email / Teams / Issue 生成)。初期は双方向同期を避ける | 未着手 |

公共部門で本格利用する場合、**Phase 6 までを正式リリース条件**とする。

実装済みのもの:

| 実装 | 置き場所 | Phase |
|---|---|---|
| ビューポート証跡の生成 | `apps/web/src/review/capture.ts` | 0 |
| コメント対象の解決 (UI / 画面座標 / 地物 / 地点) | `apps/web/src/review/target.ts` | 0 |
| 地図の WebGL 設定の配線と固定 | `apps/web/src/components/MapPane.tsx` + `capture.test.ts` | 0 |
| スキーマ (セッション・観点マスタ・観点状態・対象画面) | `db/migration/V5__review_sessions.sql` | 1 |
| セッション API (一覧・詳細・作成・更新) | `ReviewQueries.kt` / `routes/ReviewRoutes.kt` | 1 |
| 認可 (`REVIEW_READ` / `REVIEW_MANAGE`) | `Authorization.kt` ([authorization.md](authorization.md)) | 1 |
| レビューガイド画面 | `apps/web/src/components/ReviewGuide.tsx` / `screens/ReviewScreen.tsx` | 1 |

### 11.1 Phase 1 の設計判断 (設計案からの変更点)

- **観点・対象画面の専用エンドポイントは作らなかった。** `POST /api/review-sessions/{id}/perspectives`
  等に分けず、`ReviewSession` の一部として作成・更新する。「今回のレビューで何を見てもらうか」は
  原子的に決まるべき集合で、部分更新を許すと「何を外したか」が曖昧になるため。
  `PATCH` ではキーを指定したときだけ全置換する。
- **専用ロールは切らなかった。** 設計案の Reviewer / ReviewManager は既存の project
  `viewer` / `editor` に対応させた (対応表は [authorization.md](authorization.md))。
  顧客側メンバーを開発側と分離して管理する必要が出た時点で専用ロールを検討する。
- **レビュー観点はマスタテーブル (`app.review_perspectives`) に置いた。** 組織ごとに観点を
  足す場合もコード変更を伴わない。組込みの 8 観点は V5 マイグレーションで投入する。
- **期間はオフセット付き ISO-8601 のみ受け付ける。** 「いつまで受け付けるか」を機械的に
  比較する値なので、ローカル時刻の解釈揺れを持ち込まない。既存 API の `createdAt`
  (PostgreSQL 既定表記) とは表記が異なるが、同一 DTO 内では ISO-8601 に揃えている。

### 11.1 実装難易度の見立て

| 項目 | 難易度 | 備考 |
|---|---|---|
| ReviewSession / Scope / Perspective / コメント / Thread / Status | 低 | 通常の業務 CRUD |
| UI コメント位置 | 低〜中 | 安定 ID 設計が重要 |
| GIS 地物紐付け | 中 | MapLibre アダプタが必要 (Phase 0 で実装済み) |
| DOM Screenshot | 中 | Phase 0 で解消 |
| MapLibre Screenshot | ~~中〜高~~ | **Phase 0 で解消** (前提条件は 4.2) |
| 権限 / Audit | 中 | 既存基盤に載せる。最初からモデル化する |
| Notification | 中 | 外部システム依存 |

---

## 12. 初期段階では実装しないもの

過去 frontend / backend の再現、DB の時点復元、React State の完全 Snapshot、
複雑な Workflow Engine、Mention、Reaction、スクリーンショットへの高機能描画、
Jira 等との双方向同期、AI 分類・自動要件化。必要性を確認してから追加する。

---

## 13. 将来構想

同じ仕組みは要件定義レビュー・基本設計レビュー・UI/UX レビュー・UAT・操作教育時の質問管理・
本番前確認・業務改善フィードバックへ展開できる。その場合も
「**何をレビュー対象とし、何を対象としていないか**」を明示する
`ReviewSession / ReviewScope / Perspective` が中心概念であり続ける。

本基盤の差別化は、スクリーンショットや画面コメントそのものではなく、次の 7 点にある。

1. レビュー対象を明示できる
2. レビュー観点を制御できる
3. `FUTURE` により「今は見ないが後で見る」を表現できる
4. 画面・GIS コンテキストとコメントを結び付けられる
5. 投稿時点の画面を証跡として固定できる
6. 返信・解決まで一つのレビュー履歴として残せる
7. 権限・監査・データ管理を内包できる

これにより、プロトタイプを単なるデモではなく
**顧客との合意形成を段階的かつ非同期に進めるための正式なレビュー媒体**として扱えるようにする。
