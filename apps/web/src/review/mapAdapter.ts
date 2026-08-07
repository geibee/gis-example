// FeedbackMapAdapter (docs/prototype-review.md Phase 3)。
//
// MapLibre は WebGL Canvas 1 枚で描画されるため、DOM クリックの横取り
// (FeedbackOverlay) では「どの地物への指摘か」が分からない。地図クリックだけは
// レイヤ構成を知っているここで MAP_FEATURE / MAP_POSITION まで解決する。
//
// maplibre-gl を import しないのは、この判断ロジックを地図チャンクの外でも
// テストできるようにするため (受けるのは構造的な最小インタフェース)。
import {
  mapPositionTarget,
  mapTargetFromFeature,
  type FeedbackMapClick,
  type FeedbackQueriedFeature
} from "./target";
import type { FeedbackTarget } from "./types";

export type FeedbackMapAdapterOptions = {
  /** 問い合わせ対象のスタイルレイヤ ID (表示中のものだけを呼び出し側が渡す) */
  layers: string[];
  /**
   * スタイルレイヤ ID → 地物 ID として読む属性名。
   * レイヤごとに ID 列が違う (`Layer.featureIdColumn`) ため関数で受ける
   */
  featureIdPropertyOf?: (styleLayerId: string) => string | undefined;
};

/** 当たった地物 + そのスタイルレイヤ ID (ID 列の解決に使う) */
export type FeedbackQueriedFeatureWithLayer = FeedbackQueriedFeature & { layer: { id: string } };

/** maplibre-gl の `Map` を import せずに受けるための最小インタフェース */
export type FeedbackAdapterMap = {
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] }
  ): FeedbackQueriedFeatureWithLayer[];
};

/**
 * 地図クリックをコメント対象へ変換する。
 *
 * 表示中のレイヤが 1 つも無い場合や、地物に当たらなかった場合は地点コメントにする
 * (「この辺りが見づらい」という指摘も残せるようにするため)。
 */
export function feedbackTargetFromMapClick(
  map: FeedbackAdapterMap,
  event: FeedbackMapClick,
  options: FeedbackMapAdapterOptions
): FeedbackTarget {
  if (options.layers.length === 0) return mapPositionTarget(event);

  const [feature] = map.queryRenderedFeatures([event.point.x, event.point.y], { layers: options.layers });
  const featureIdProperty = feature ? options.featureIdPropertyOf?.(feature.layer.id) : undefined;
  return mapTargetFromFeature(feature, event, featureIdProperty);
}
