import "./styles.css";

export { createFeedbackApiClient, FeedbackApiError } from "./api";
export { createFeedbackV1ApiClient } from "./api-v1";
export { createDualReadFeedbackApiClient } from "./api-dual-read";
export type { FeedbackV1ApiClientOptions } from "./api-v1";
export type {
  FeedbackApiClient,
  FeedbackApiClientOptions,
  TokenGetter,
  TokenRefresher
} from "./api";
export {
  captureViewport,
  defaultMaxPixelRatio,
  findUnreadableMapCanvases,
  maplibreCanvasSelector
} from "./capture";
export type { CaptureViewportOptions, ViewportEvidence } from "./capture";
export { FeedbackMapLibreAdapter } from "./FeedbackMapLibreAdapter";
export type { FeedbackMapLayer, FeedbackMapLibreAdapterProps } from "./FeedbackMapLibreAdapter";
export { FeedbackOverlay } from "./FeedbackOverlay";
export type { FeedbackOverlayProps } from "./FeedbackOverlay";
export { defaultReviewIntroductionStorageKey } from "./ReviewSessionIntroduction";
export { defaultParticipantNameStorageKey, FeedbackPluginProvider } from "./plugin-context";
export type { FeedbackPluginProviderProps } from "./plugin-context";
export { defineFeedbackRoutes, feedbackRouteMatches, matchFeedbackRoute } from "./routes";
export type { FeedbackRouteDefinition } from "./routes";
export { feedbackThreadMatchesPath } from "./thread-route";
export { feedbackPluginKeys } from "./queries";
export { useFeedbackPlugin } from "./state";
export type { FeedbackMode, PickedFeedbackTarget } from "./state";
export {
  parseFeedbackTarget,
  resolveMapTarget,
  resolveScreenTarget
} from "./target";
export type {
  FeedbackMapClick,
  FeedbackMapLike,
  FeedbackQueriedFeature,
  ResolveMapTargetOptions,
  ScreenPoint,
  ViewportSize
} from "./target";
export {
  captureExcludeAttribute,
  captureReadyCanvasContextAttributes,
  feedbackMapAttribute,
  feedbackTargetAttribute
} from "./types";
export type {
  FeedbackPluginNotification,
  FeedbackPluginNotificationHandler,
  FeedbackTarget,
  FeedbackTargetType,
  RelativePoint
} from "./types";
export type {
  FeedbackMessage,
  FeedbackMessageCreateRequest,
  FeedbackMessageUpdateRequest,
  FeedbackMessageVersion,
  FeedbackThread,
  FeedbackThreadCreateMetadata,
  FeedbackThreadStatusPatchRequest,
  Me,
  ReviewSession
} from "./contracts";
