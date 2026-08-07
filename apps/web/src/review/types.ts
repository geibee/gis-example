// レビュー基盤のドメイン型 (docs/prototype-review.md の「Feedback Target モデル」に対応)。
//
// ここは API 契約 (openapi.yaml から生成される src/contracts) とは別に、
// フロントエンドがコメント対象を解決するための表現を持つ。サーバへ送るときは
// targetMetadata として JSON のまま格納される想定。

/** UI 部品にコメント対象としての安定 ID を与える属性 (`data-feedback-id="..."`)。 */
export const feedbackTargetAttribute = "data-feedback-id";

/** MapLibre の描画領域を DOM の画面座標対象と区別する属性。 */
export const feedbackMapAttribute = "data-feedback-map";

/** レビュー用オーバーレイ自身を証跡から除外する属性 (`data-review-exclude`)。 */
export const captureExcludeAttribute = "data-review-exclude";

/**
 * 地図を証跡に写すために MapLibre の `Map` 生成時へ必ず渡す設定。
 *
 * WebGL の既定 (`preserveDrawingBuffer: false`) では、フレーム合成後に
 * `toDataURL()` が空画像を返す。例外は起きないため、設定を落とすと
 * 「地図だけ真っ白な証跡」が静かに量産される。MapLibre v5 では Map 直下ではなく
 * `canvasContextAttributes` に置く点に注意 (v4 までのトップレベル指定は無視される)。
 *
 * 地図チャンクから定数 1 つのために html-to-image を引き込まないよう、
 * 依存を持たないこのモジュールに置く。
 */
export const captureReadyCanvasContextAttributes = { preserveDrawingBuffer: true } as const;

/** ビューポート内の相対位置 (0〜1)。画面サイズ差にある程度耐えるため px で持たない。 */
export type RelativePoint = {
  relativeX: number;
  relativeY: number;
};

/**
 * コメントの対象。
 *
 * - `UI_ELEMENT`   : 安定 ID を持つ UI 部品
 * - `SCREEN_POSITION`: 安定 ID を辿れなかった箇所 / 画面全体への指摘
 * - `MAP_FEATURE`  : MapLibre 上の地物 (「この筆について」)
 * - `MAP_POSITION` : 地物に当たらなかった地図上の地点 (「この辺り」)
 */
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
