import type { FeedbackTargetV1 } from "@feedback/contracts";

export function parseFeedbackTarget(value: unknown): FeedbackTargetV1 | null {
  if (!isRecord(value) || value.schemaVersion !== "1" || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "ui-element":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "elementKey", "relativeX", "relativeY"]) &&
        isStableKey(value.elementKey) && isRelativePoint(value)
        ? {
            schemaVersion: "1",
            kind: "ui-element",
            elementKey: value.elementKey.trim(),
            relativeX: value.relativeX,
            relativeY: value.relativeY
          }
        : null;
    case "screen-position":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "relativeX", "relativeY"]) && isRelativePoint(value)
        ? { schemaVersion: "1", kind: "screen-position", relativeX: value.relativeX, relativeY: value.relativeY }
        : null;
    case "map-feature":
      return hasOnlyKeys(value, [
        "schemaVersion", "kind", "provider", "sourceKey", "sourceLayer", "featureKey", "longitude", "latitude"
      ]) && value.provider === "maplibre" && isStableKey(value.sourceKey) &&
        isStableKey(value.featureKey) && isCoordinate(value)
        ? {
            schemaVersion: "1",
            kind: "map-feature",
            provider: "maplibre",
            sourceKey: value.sourceKey.trim(),
            ...(isStableKey(value.sourceLayer) ? { sourceLayer: value.sourceLayer.trim() } : {}),
            featureKey: value.featureKey.trim(),
            longitude: value.longitude,
            latitude: value.latitude
          }
        : null;
    case "map-position":
      return hasOnlyKeys(value, ["schemaVersion", "kind", "longitude", "latitude"]) && isCoordinate(value)
        ? { schemaVersion: "1", kind: "map-position", longitude: value.longitude, latitude: value.latitude }
        : null;
    default:
      return null;
  }
}

export function assertFeedbackTarget(value: unknown): asserts value is FeedbackTargetV1 {
  if (!parseFeedbackTarget(value)) throw new Error("FeedbackTargetV1に適合しません");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStableKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRelativePoint(value: Record<string, unknown>): value is Record<string, unknown> & {
  relativeX: number;
  relativeY: number;
} {
  return isNumber(value.relativeX) && isNumber(value.relativeY) &&
    value.relativeX >= 0 && value.relativeX <= 1 && value.relativeY >= 0 && value.relativeY <= 1;
}

function isCoordinate(value: Record<string, unknown>): value is Record<string, unknown> & {
  longitude: number;
  latitude: number;
} {
  return isNumber(value.longitude) && isNumber(value.latitude) &&
    value.longitude >= -180 && value.longitude <= 180 && value.latitude >= -90 && value.latitude <= 90;
}
