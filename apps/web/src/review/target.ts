// クリック位置から FeedbackTarget を解決する純粋関数群。
//
// DOM 側 (resolveScreenTarget) と MapLibre 側 (resolveMapTarget) を分けているのは、
// 地図が WebGL Canvas 1 枚として描画され DOM 要素を持たないため。地図上の指摘は
// 「画面のこの辺」ではなく「この地物 / この地点」として保存する。
import { feedbackTargetAttribute, type FeedbackTarget } from "./types";

/** 相対座標の保存桁数 (1920px 幅で 0.2px 相当。これ以上の精度は画面差で無意味)。 */
const relativePrecision = 4;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const toRelative = (value: number, size: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(size) || size <= 0) return 0;
  return Number(clamp01(value / size).toFixed(relativePrecision));
};

export type ViewportSize = {
  width: number;
  height: number;
};

export type ScreenPoint = {
  clientX: number;
  clientY: number;
};

/**
 * DOM 上のクリックを FeedbackTarget に変換する。
 *
 * `data-feedback-id` を持つ祖先が見つかれば UI_ELEMENT、見つからなければ SCREEN_POSITION。
 * どちらの場合もビューポート相対座標を持たせ、ピン表示と証跡の突合に使う。
 */
export function resolveScreenTarget(
  point: ScreenPoint,
  element: Element | null,
  viewport: ViewportSize
): FeedbackTarget {
  const relativeX = toRelative(point.clientX, viewport.width);
  const relativeY = toRelative(point.clientY, viewport.height);
  const owner = element?.closest(`[${feedbackTargetAttribute}]`) ?? null;
  const feedbackTargetId = owner?.getAttribute(feedbackTargetAttribute)?.trim();

  if (feedbackTargetId) {
    return { type: "UI_ELEMENT", feedbackTargetId, relativeX, relativeY };
  }
  return { type: "SCREEN_POSITION", relativeX, relativeY };
}

/** MapLibre の `queryRenderedFeatures` 結果のうち、証跡に必要な部分だけを構造的に要求する。 */
export type FeedbackQueriedFeature = {
  source: string;
  sourceLayer?: string;
  id?: string | number;
  properties?: Record<string, unknown> | null;
};

/** maplibre-gl の `Map` を直接 import せずに受けるための最小インタフェース。 */
export type FeedbackMapLike = {
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] }
  ): FeedbackQueriedFeature[];
};

/** MapLibre のクリックイベントのうち、対象解決に使う部分。 */
export type FeedbackMapClick = {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
};

export type ResolveMapTargetOptions = {
  /** 問い合わせ対象のスタイルレイヤ ID。未指定なら全レイヤ。 */
  layers?: string[];
  /**
   * 地物 ID として読む属性名 (レイヤごとに異なるため呼び出し側が指定する)。
   * 未指定・値なしの場合は MapLibre の feature.id にフォールバックする。
   */
  featureIdProperty?: string;
};

/**
 * 地図上のクリックを FeedbackTarget に変換する。
 *
 * 地物に当たれば MAP_FEATURE (source / sourceLayer / featureId を保持) とし、
 * 当たらなければ MAP_POSITION として経緯度だけを保持する。
 */
export function resolveMapTarget(
  map: FeedbackMapLike,
  event: FeedbackMapClick,
  options: ResolveMapTargetOptions = {}
): FeedbackTarget {
  const longitude = event.lngLat.lng;
  const latitude = event.lngLat.lat;
  const position: FeedbackTarget = { type: "MAP_POSITION", longitude, latitude };

  const layers = options.layers;
  if (layers && layers.length === 0) return position;

  const [feature] = map.queryRenderedFeatures([event.point.x, event.point.y], layers ? { layers } : undefined);
  if (!feature) return position;

  const featureId = readFeatureId(feature, options.featureIdProperty);
  if (featureId === null) return position;

  return {
    type: "MAP_FEATURE",
    longitude,
    latitude,
    source: feature.source,
    ...(feature.sourceLayer ? { sourceLayer: feature.sourceLayer } : {}),
    featureId
  };
}

function readFeatureId(feature: FeedbackQueriedFeature, featureIdProperty?: string): string | null {
  const raw = featureIdProperty ? feature.properties?.[featureIdProperty] : undefined;
  const candidate = raw ?? feature.id;
  if (candidate === undefined || candidate === null) return null;
  const featureId = String(candidate).trim();
  return featureId === "" ? null : featureId;
}
