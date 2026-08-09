import type { components } from "./generated.js";

export const feedbackApiVersion = "1.0" as const;
export const feedbackApiMajorVersion = 1 as const;
export const feedbackManifestSchemaVersion = "1" as const;
export const feedbackTargetSchemaVersion = "1" as const;

export type FeedbackCapabilities = components["schemas"]["FeedbackCapabilities"];
export type FeedbackHostContextV1 = components["schemas"]["FeedbackHostContextV1"];
export type FeedbackApplicationManifestV1 = components["schemas"]["FeedbackApplicationManifestV1"];
export type FeedbackLocationV1 = components["schemas"]["FeedbackLocationV1"];
export type FeedbackTargetV1 = components["schemas"]["FeedbackTargetV1"];
export type FeedbackReviewContextV1 = components["schemas"]["FeedbackReviewContextV1"];
export type FeedbackParticipant = components["schemas"]["FeedbackParticipant"];
export type FeedbackProblem = components["schemas"]["FeedbackProblem"];
export type FeedbackSessionV1 = components["schemas"]["FeedbackSessionV1"];
export type FeedbackThreadV1 = components["schemas"]["FeedbackThreadV1"];
export type FeedbackMessageV1 = components["schemas"]["FeedbackMessageV1"];

export type { components, operations, paths } from "./generated.js";
