# @web-gis/feedback-plugin

社内React SPAへ、既存のレビューAPIを使った投稿・DOM／地図ピン・スレッドを組み込むSDK。
OIDCライブラリ、ルーター、ホストアプリのProviderには依存しない。

## 組み込み例

```tsx
import {
  FeedbackMapLibreAdapter,
  FeedbackOverlay,
  FeedbackPluginProvider,
  defineFeedbackRoutes,
  captureReadyCanvasContextAttributes,
  feedbackMapAttribute,
  useFeedbackPlugin
} from "@web-gis/feedback-plugin";
import { useEffect } from "react";
import "@web-gis/feedback-plugin/styles.css";

// ホストのルーターファイル付近で一度だけ定義し、管理画面とも共有する。
const feedbackRoutes = defineFeedbackRoutes([
  { pageId: "zones.list", path: "/zones", label: "区域一覧" },
  { pageId: "zones.detail", path: "/zones/{id}", label: "区域詳細" }
] as const);

function App() {
  return (
    <FeedbackPluginProvider
      apiBaseUrl="https://feedback-api.internal.example"
      projectId={projectId}
      appVersion={buildVersion}
      routes={feedbackRoutes}
      currentPath={router.location.pathname}
      getAccessToken={() => auth.accessToken}
      refreshAccessToken={() => auth.renew()}
      onNotification={(event) => toaster.show(event.message, event.type)}
      participantNameStorageKey="my-app.feedback.participant-name"
      queryClient={queryClient}
    >
      <BusinessScreen />
      <FeedbackOverlay />
    </FeedbackPluginProvider>
  );
}
```

SDKは業務APIからID一覧を取得しない。ホストが `routes` として明示した一覧だけを画面契約とし、
`/zones/Z-2` のような実URLを `/zones/{id}` へ照合する。SPAの遷移に追従させるため、ルーターが
保持する現在のpathnameを `currentPath` へ渡す。任意のソースファイルパスを実行時に読むのではなく、
ルーターファイルからこの配列をexportしてSDKとレビュー管理画面で共有する。

レビューセッションが開いている画面では、通常DOMまたはMapLibre上を右クリックすると
「フィードバックを残す」メニューからその位置へ直接投稿できる。投稿画面とスレッドは、×ボタン、
Escapeに加えてパネル外のクリックでも閉じられる。

受付中セッションは、ブラウザ・プロジェクト・セッションごとの初回にレビュー案内を自動表示する。
案内には今回の確認観点と対象画面が含まれ、閉じた後も「今回のレビュー」ボタンから再表示できる。
ボタンには現在画面が対象か対象外かも表示される。既読状態の既定キーは
`web-gis.feedback.review-introduction` で、ホストごとに分ける場合は
`FeedbackOverlay` の `reviewIntroductionStorageKey` を指定する。

共通OIDCアカウントを配布するレビューでは、投稿画面・返信欄に「投稿者名」が表示される。
未入力のまま投稿はできず、入力値は既定で `web-gis.feedback.participant-name` へ保存される。
ホストごとにキーを分ける場合は `participantNameStorageKey` を指定する。この名前は自己申告値であり、
OIDCの認証主体、API認可、正式な本人確認の代わりにはならない。APIは両方を分離して記録する。

ピン番号はレビューセッション内で永続化され、新規投稿は常に既存最大番号の次になる。
投稿時の具体URLも保存するため、`/lands/L-1` と `/lands/L-2` のような同じ画面種別の別詳細に
ピンが混ざらない。管理APIの一覧はセッション全体を返すので、管理画面側では全詳細を横断集計できる。

安定したDOM対象には `data-feedback-id` を付ける。

```tsx
<button data-feedback-id="contract.save">保存</button>
```

通知などのディープリンクは、ホストのルーターで `threadId` を読んでSDKへ渡す。

```tsx
function FeedbackDeepLink({ threadId }: { threadId: string | null }) {
  const { openThread, closeThread } = useFeedbackPlugin();
  useEffect(() => {
    if (threadId) openThread(threadId);
    else closeThread();
  }, [closeThread, openThread, threadId]);
  return null;
}
```

`threadId` はレビュー管理画面に限らず、投稿対象のどの画面でも処理する。管理一覧やCSVでは
`/lands/L-1?projectId=...&threadId=...` のようなパーマリンクを生成すると、対象詳細とスレッドを
同時に開ける。

MapLibreの地図要素には `feedbackMapAttribute` を付け、Map生成時は
`canvasContextAttributes: captureReadyCanvasContextAttributes` を指定する。地図準備後に
`FeedbackMapLibreAdapter` へMap、業務レイヤとstyle layerの対応を渡す。

## バックエンド配置

既存API (`API_ROUTE_MODE=full`) のURLをそのまま `apiBaseUrl` に指定できる。分離する場合は同じ
APIイメージを `API_ROUTE_MODE=review-sidecar` でcompanion containerとして起動する。このモードは
`/api/me`、レビューセッション、フィードバック、証跡ガバナンス、通知設定だけを公開し、分析や
業務CRUDを公開しない。

sidecarは通信を透過的にインターセプトしない。Gatewayでレビュー系pathを振り分けるか、SDKを
sidecarのURLへ直接向ける。これによりBearer JWT、`projectId`認可、監査ログ、証跡の非公開保管を
本体と同じfail-closedな経路に保てる。

## CSS変数

`--wfg-feedback-accent`、`--wfg-feedback-z-*`、`--wfg-feedback-launcher-right`、
`--wfg-feedback-launcher-bottom`、`--wfg-feedback-review-guide-right`、
`--wfg-feedback-review-guide-bottom`、`--wfg-feedback-review-guide-width`、
`--wfg-feedback-panel-width` などをホスト側で上書きできる。

API契約型は `apps/api/openapi.yaml` から生成する。

```bash
npm --workspace @web-gis/feedback-plugin run generate:contracts
```
