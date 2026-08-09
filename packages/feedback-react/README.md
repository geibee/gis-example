# @feedback/react

React 18/19 用の `FeedbackProvider`、`FeedbackOverlay`、DOM/screen pin、Thread Drawer、DOM capture provider
を提供します。利用側は `@feedback/react/styles.css` を読み込み、`@feedback/core` の host adapter と transport
を渡します。MapLibre は依存に含まれません。

```tsx
import { FeedbackOverlay, FeedbackProvider } from "@feedback/react";
import "@feedback/react/styles.css";

<FeedbackProvider adapter={adapter} transport={transport}>
  <FeedbackOverlay deepLinkThreadId={threadId} />
</FeedbackProvider>;
```

右クリック操作は `features.contextMenu: true` の明示時だけ有効です。`portalTarget` には通常DOMまたは
`ShadowRoot` を指定できます。strict CSP では同梱CSSを stylesheet として読み込み、`connect-src` に
Feedback Service、証跡previewを使う場合だけ `img-src blob:` を許可してください。

既定DOM captureは `data-feedback-exclude` を除外し、`data-feedback-mask` を同梱CSSでマスクします。
cross-origin画像/fontはCORS対応または除外が必要です。captureを不要にする場合は
`features.evidenceCapture: false`、独自方式は `adapter.captureEvidence` を使用します。
DOM/screen pin は現在のmanifest locationと page/route/path/queryが一致するthreadだけを表示します。
