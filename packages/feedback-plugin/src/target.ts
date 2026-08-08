import { feedbackTargetAttribute, type FeedbackTarget, type RelativePoint } from "./types";

const relativePrecision = 4;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const toRelative = (value: number, size: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(size) || size <= 0) return 0;
  return Number(clamp01(value / size).toFixed(relativePrecision));
};

export type ViewportSize = { width: number; height: number };
export type ScreenPoint = { clientX: number; clientY: number };

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

export type FeedbackQueriedFeature = {
  source: string;
  sourceLayer?: string;
  id?: string | number;
  properties?: Record<string, unknown> | null;
};

export type FeedbackMapLike = {
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] }
  ): FeedbackQueriedFeature[];
};

export type FeedbackMapClick = {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
};

export type ResolveMapTargetOptions = {
  layers?: string[];
  featureIdProperty?: string;
  featureIdPropertyBySource?: Readonly<Record<string, string>>;
};

export function resolveMapTarget(
  map: FeedbackMapLike,
  event: FeedbackMapClick,
  options: ResolveMapTargetOptions = {}
): FeedbackTarget {
  const longitude = event.lngLat.lng;
  const latitude = event.lngLat.lat;
  const position: FeedbackTarget = { type: "MAP_POSITION", longitude, latitude };
  if (options.layers?.length === 0) return position;

  const [feature] = map.queryRenderedFeatures(
    [event.point.x, event.point.y],
    options.layers ? { layers: options.layers } : undefined
  );
  if (!feature) return position;

  const featureId = readFeatureId(
    feature,
    options.featureIdPropertyBySource?.[feature.source] ?? options.featureIdProperty
  );
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

export function parseFeedbackTarget(value: unknown): FeedbackTarget | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "UI_ELEMENT":
      return isNonBlankString(value.feedbackTargetId) && isRelativePoint(value)
        ? {
            type: value.type,
            feedbackTargetId: value.feedbackTargetId.trim(),
            relativeX: value.relativeX,
            relativeY: value.relativeY
          }
        : null;
    case "SCREEN_POSITION":
      return isRelativePoint(value)
        ? { type: value.type, relativeX: value.relativeX, relativeY: value.relativeY }
        : null;
    case "MAP_FEATURE":
      return isCoordinate(value) && isNonBlankString(value.source) && isNonBlankString(value.featureId)
        ? {
            type: value.type,
            longitude: value.longitude,
            latitude: value.latitude,
            source: value.source.trim(),
            ...(isNonBlankString(value.sourceLayer) ? { sourceLayer: value.sourceLayer.trim() } : {}),
            featureId: value.featureId.trim()
          }
        : null;
    case "MAP_POSITION":
      return isCoordinate(value)
        ? { type: value.type, longitude: value.longitude, latitude: value.latitude }
        : null;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRelativePoint(value: Record<string, unknown>): value is Record<string, unknown> & RelativePoint {
  return (
    isFiniteNumber(value.relativeX) &&
    isFiniteNumber(value.relativeY) &&
    value.relativeX >= 0 &&
    value.relativeX <= 1 &&
    value.relativeY >= 0 &&
    value.relativeY <= 1
  );
}

function isCoordinate(value: Record<string, unknown>): value is Record<string, unknown> & {
  longitude: number;
  latitude: number;
} {
  return (
    isFiniteNumber(value.longitude) &&
    isFiniteNumber(value.latitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    value.latitude >= -90 &&
    value.latitude <= 90
  );
}

function readFeatureId(feature: FeedbackQueriedFeature, featureIdProperty?: string): string | null {
  const raw = featureIdProperty ? feature.properties?.[featureIdProperty] : undefined;
  const candidate = raw ?? feature.id;
  if (candidate === undefined || candidate === null) return null;
  const featureId = String(candidate).trim();
  return featureId === "" ? null : featureId;
}
