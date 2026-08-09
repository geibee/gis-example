import { describe, expect, it } from "vitest";
import { parseFeedbackTarget } from "./target";

describe("FeedbackTargetV1", () => {
  it("4 variantを厳密に検証する", () => {
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "ui-element",
      elementKey: "save",
      relativeX: 0.5,
      relativeY: 1
    })?.kind).toBe("ui-element");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 0,
      relativeY: 0.25
    })?.kind).toBe("screen-position");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-feature",
      provider: "maplibre",
      sourceKey: "parcels",
      featureKey: "P-1",
      longitude: 139.7,
      latitude: 35.6
    })?.kind).toBe("map-feature");
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-position",
      longitude: 139.7,
      latitude: 35.6
    })?.kind).toBe("map-position");
  });

  it("範囲外座標と未知fieldを拒否する", () => {
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 1.1,
      relativeY: 0
    })).toBeNull();
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "map-position",
      longitude: 181,
      latitude: 0
    })).toBeNull();
    expect(parseFeedbackTarget({
      schemaVersion: "1",
      kind: "screen-position",
      relativeX: 0.5,
      relativeY: 0.5,
      secret: "unexpected"
    })).toBeNull();
  });
});
