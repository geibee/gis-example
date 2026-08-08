import { describe, expect, it } from "vitest";
import { resolveMapLibreFeedbackTarget } from "./index";

const event = {
  point: { x: 10, y: 20 },
  lngLat: { lng: 139.7, lat: 35.6 }
} as never;

describe("MapLibre target adapter", () => {
  it("hostが変換した安定source/feature keyを利用する", () => {
    const feature = { source: "runtime-source", sourceLayer: "parcel", id: 42, properties: { parcelId: "P-42" } };
    const map = { queryRenderedFeatures: () => [feature] } as never;
    expect(resolveMapLibreFeedbackTarget(map, event, {
      toSourceKey: () => "parcels",
      toFeatureKey: (candidate) => String(candidate.properties?.parcelId)
    })).toEqual({
      schemaVersion: "1",
      kind: "map-feature",
      provider: "maplibre",
      sourceKey: "parcels",
      sourceLayer: "parcel",
      featureKey: "P-42",
      longitude: 139.7,
      latitude: 35.6
    });
  });

  it("変換不能なfeatureは位置targetへ下げる", () => {
    const map = { queryRenderedFeatures: () => [{ source: "runtime", id: 42, properties: {} }] } as never;
    expect(resolveMapLibreFeedbackTarget(map, event, {
      toSourceKey: () => null,
      toFeatureKey: () => null
    }).kind).toBe("map-position");
  });
});
