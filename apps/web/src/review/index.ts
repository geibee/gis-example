// レビュー基盤 (プロトタイプレビュー管理) のフロントエンド公開 API。
// 設計は docs/prototype-review.md を参照。
export {
  captureViewport,
  defaultMaxPixelRatio,
  findUnreadableMapCanvases,
  frontendVersion,
  maplibreCanvasSelector,
  type CaptureViewportOptions,
  type ViewportEvidence
} from "./capture";
export {
  resolveMapTarget,
  resolveScreenTarget,
  type FeedbackMapClick,
  type FeedbackMapLike,
  type FeedbackQueriedFeature,
  type ResolveMapTargetOptions,
  type ScreenPoint,
  type ViewportSize
} from "./target";
export {
  captureExcludeAttribute,
  captureReadyCanvasContextAttributes,
  feedbackTargetAttribute,
  type FeedbackTarget,
  type FeedbackTargetType,
  type RelativePoint
} from "./types";
