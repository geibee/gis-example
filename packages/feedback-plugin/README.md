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
`--wfg-feedback-launcher-bottom`、`--wfg-feedback-panel-width` などをホスト側で上書きできる。

API契約型は `apps/api/openapi.yaml` から生成する。

```bash
npm --workspace @web-gis/feedback-plugin run generate:contracts
```
