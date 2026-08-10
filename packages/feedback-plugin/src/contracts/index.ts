// API 契約の定義元は apps/api/openapi.yaml。generated.ts は generate:contracts で更新する。
import type { components } from "./generated";

export type { components, operations, paths } from "./generated";

type Schemas = components["schemas"];

export type Me = Schemas["Me"];
export type ReviewScope = Schemas["ReviewScope"] & { perspectiveCodes?: string[] };
export type ReviewSession = Omit<Schemas["ReviewSession"], "scopes"> & { scopes: ReviewScope[] };
export type FeedbackThread = Schemas["FeedbackThread"];
export type FeedbackMessage = Schemas["FeedbackMessage"];
export type FeedbackMessageCreateRequest = Schemas["FeedbackMessageCreateRequest"];
export type FeedbackMessageUpdateRequest = Schemas["FeedbackMessageUpdateRequest"];
export type FeedbackMessageVersion = Schemas["FeedbackMessageVersion"];
export type FeedbackThreadStatusPatchRequest = Schemas["FeedbackThreadStatusPatchRequest"];
export type FeedbackThreadCreateMetadata = Schemas["FeedbackThreadCreateMetadata"];
