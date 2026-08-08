import { describe, expect, it, vi } from "vitest";
import { bindMapLibreFeedbackPins, resolveMapLibreFeedbackTarget } from "./index";

const event = {
  point: { x: 10, y: 20 },
  lngLat: { lng: 139.7, lat: 35.6 }
} as never;

describe("MapLibre target adapter", () => {
  it("hostが変換した安定source/feature keyを利用する", () => {
    const feature = {
      source: "runtime-source",
      sourceLayer: "parcel",
      id: 42,
      properties: { parcelId: "P-42" }
    };
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
    const map = {
      queryRenderedFeatures: () => [{ source: "runtime", id: 42, properties: {} }]
    } as never;
    expect(resolveMapLibreFeedbackTarget(map, event, {
      toSourceKey: () => null,
      toFeatureKey: () => null
    }).kind).toBe("map-position");
  });

  it("style reloadでmarkerを再構築しlayer消滅とmap unloadでcleanupする", () => {
    const listeners = new Map<string, () => void>();
    let layerExists = true;
    const map = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
      getLayer: () => (layerExists ? {} : undefined)
    };
    const removed: number[] = [];
    const createMarker = vi.fn(() => ({ remove: () => removed.push(1) }));
    const binding = bindMapLibreFeedbackPins(map, { requiredLayerIds: ["feedback"], createMarker });
    const thread = {
      target: { schemaVersion: "1", kind: "map-position", longitude: 139.7, latitude: 35.6 }
    } as never;
    binding.update([thread]);
    expect(createMarker).toHaveBeenCalledTimes(1);

    listeners.get("styledata")?.();
    expect(createMarker).toHaveBeenCalledTimes(2);
    expect(removed).toHaveLength(1);

    layerExists = false;
    listeners.get("styledata")?.();
    expect(removed).toHaveLength(2);
    listeners.get("remove")?.();
    expect(listeners.size).toBe(0);
  });
});
