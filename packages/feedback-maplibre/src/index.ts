import type { MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";
import type { FeedbackTargetV1, FeedbackThreadV1 } from "@feedback/contracts";

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

export type FeedbackMapLibreMarker = { remove(): void };

export type FeedbackMapLibrePinMap = {
  on(event: "styledata" | "remove", listener: () => void): void;
  off(event: "styledata" | "remove", listener: () => void): void;
  getLayer?(id: string): unknown;
};

export type FeedbackMapLibrePinBindingOptions = {
  /** style reload 後に必要な host layer が存在するかを判定する。 */
  requiredLayerIds?: readonly string[];
  createMarker(
    thread: FeedbackThreadV1,
    target: Extract<FeedbackTargetV1, { kind: "map-feature" | "map-position" }>
  ): FeedbackMapLibreMarker;
};

/** style reload・layer消滅・map unloadで marker を必ず再構築/破棄する lifecycle adapter。 */
export function bindMapLibreFeedbackPins(
  map: FeedbackMapLibrePinMap,
  options: FeedbackMapLibrePinBindingOptions
): { update(threads: readonly FeedbackThreadV1[]): void; destroy(): void } {
  let current: readonly FeedbackThreadV1[] = [];
  let markers: FeedbackMapLibreMarker[] = [];
  let destroyed = false;
  const clear = () => {
    markers.forEach((marker) => marker.remove());
    markers = [];
  };
  const render = () => {
    clear();
    if (destroyed) return;
    if (options.requiredLayerIds?.some((layer) => !map.getLayer?.(layer))) return;
    markers = current.flatMap((thread) => {
      const target = thread.target;
      return target.kind === "map-feature" || target.kind === "map-position"
        ? [options.createMarker(thread, target)]
        : [];
    });
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    map.off("styledata", render);
    map.off("remove", destroy);
    clear();
  };
  map.on("styledata", render);
  map.on("remove", destroy);
  return {
    update(threads) {
      current = [...threads];
      render();
    },
    destroy
  };
}
