import type { MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";
import type { FeedbackTargetV1 } from "@feedback/contracts";

export type FeedbackMapLibreTargetOptions = {
  layers?: string[];
  /** MapLibre source ID を製品横断で安定した source key へ変換する。 */
  toSourceKey(feature: MapGeoJSONFeature): string | null;
  /** feature.id や業務属性を安定した feature key へ変換する。 */
  toFeatureKey(feature: MapGeoJSONFeature): string | null;
};

export type FeedbackMapLibreMap = {
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] }
  ): MapGeoJSONFeature[];
};

/** MapLibre 固有 ID を host adapter で安定 key に変換して FeedbackTargetV1 を作る。 */
export function resolveMapLibreFeedbackTarget(
  map: FeedbackMapLibreMap,
  event: Pick<MapMouseEvent, "point" | "lngLat">,
  options: FeedbackMapLibreTargetOptions
): FeedbackTargetV1 {
  const position: FeedbackTargetV1 = {
    schemaVersion: "1",
    kind: "map-position",
    longitude: event.lngLat.lng,
    latitude: event.lngLat.lat
  };
  if (options.layers?.length === 0) return position;

  const [feature] = map.queryRenderedFeatures(
    [event.point.x, event.point.y],
    options.layers ? { layers: options.layers } : undefined
  );
  if (!feature) return position;
  const sourceKey = options.toSourceKey(feature)?.trim();
  const featureKey = options.toFeatureKey(feature)?.trim();
  if (!sourceKey || !featureKey) return position;
  return {
    schemaVersion: "1",
    kind: "map-feature",
    provider: "maplibre",
    sourceKey,
    ...(feature.sourceLayer ? { sourceLayer: feature.sourceLayer } : {}),
    featureKey,
    longitude: event.lngLat.lng,
    latitude: event.lngLat.lat
  };
}
