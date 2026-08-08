# @feedback/core

React、DOM、MapLibre、特定routerに依存しない Feedback SDK の中核です。`FeedbackHostAdapter`、v1 fetch
transport、manifest/location/target の解決・検証、capabilities negotiation を提供します。

```ts
import { createFeedbackTransport, type FeedbackHostAdapter } from "@feedback/core";
```

token は host adapter から受け取り、401 refresh は single-flight で実行します。書き込み時の
`Idempotency-Key` と更新時の `If-Match` は transport option で明示します。
manifest から location を解決するとき、未登録 query と `discard` 指定 query は Service へ送る前に除外します。
