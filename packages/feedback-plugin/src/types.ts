/** UI部品へコメント対象としての安定IDを与える属性。 */
export const feedbackTargetAttribute = "data-feedback-id";

/** MapLibreの描画領域を通常のDOM対象と区別する属性。 */
export const feedbackMapAttribute = "data-feedback-map";

/** SDK自身や機微要素を画面キャプチャから除外する属性。 */
export const captureExcludeAttribute = "data-review-exclude";

/** MapLibreの証跡キャプチャに必要なCanvas設定。 */
export const captureReadyCanvasContextAttributes = { preserveDrawingBuffer: true } as const;

export type RelativePoint = {
  relativeX: number;
  relativeY: number;
};

export type FeedbackTarget =
  | ({ type: "UI_ELEMENT"; feedbackTargetId: string } & RelativePoint)
  | ({ type: "SCREEN_POSITION" } & RelativePoint)
  | {
      type: "MAP_FEATURE";
      longitude: number;
      latitude: number;
      source: string;
      sourceLayer?: string;
      featureId: string;
    }
  | { type: "MAP_POSITION"; longitude: number; latitude: number };

export type FeedbackTargetType = FeedbackTarget["type"];

export type FeedbackPluginNotification = {
  type: "success" | "error" | "unauthorized";
  message: string;
};

export type FeedbackPluginNotificationHandler = (notification: FeedbackPluginNotification) => void;
