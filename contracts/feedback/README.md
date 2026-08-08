# @feedback/contracts

Feedback Service v1 の OpenAPI 3.1、application manifest/location/target/webhook の JSON Schema、生成済み
TypeScript/Kotlin 型を提供する契約 package です。GIS API や特定ホストの route 型には依存しません。

```ts
import type { FeedbackLocationV1, FeedbackTargetV1 } from "@feedback/contracts";
```

OpenAPI と各 schema は `@feedback/contracts/openapi.yaml`、`@feedback/contracts/schemas/*` から参照できます。
`npm run generate` は `src/generated.ts` と `kotlin/FeedbackContractTypes.kt` を同じ専用OpenAPIから生成します。
両方がdrift検査対象で、Kotlin型は `feedback.contract.generated` packageとして利用できます。
registry が決まるまでは `private: true` のため、配布検証には repository 内の `npm pack` を使用します。
