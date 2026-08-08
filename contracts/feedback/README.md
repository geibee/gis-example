# @feedback/contracts

Feedback Service v1 の OpenAPI 3.1、application manifest/location/target/webhook の JSON Schema、生成済み
TypeScript 型を提供する契約 package です。GIS API や特定ホストの route 型には依存しません。

```ts
import type { FeedbackLocationV1, FeedbackTargetV1 } from "@feedback/contracts";
```

OpenAPI と各 schema は `@feedback/contracts/openapi.yaml`、`@feedback/contracts/schemas/*` から参照できます。
registry が決まるまでは `private: true` のため、配布検証には repository 内の `npm pack` を使用します。
