import { describe, expect, it, vi } from "vitest";
import {
  parseFeedbackTarget,
  resolveMapTarget,
  resolveScreenTarget,
  type FeedbackMapLike,
  type FeedbackQueriedFeature
} from "./target";

const viewport = { width: 1000, height: 500 };

describe("DOM対象解決", () => {
  it("安定IDを持つ祖先をUI_ELEMENTへ変換する", () => {
    document.body.innerHTML = `<div data-feedback-id="contract.expiration"><span id="label">契約満了日</span></div>`;
    expect(resolveScreenTarget({ clientX: 630, clientY: 205 }, document.querySelector("#label"), viewport)).toEqual({
      type: "UI_ELEMENT",
      feedbackTargetId: "contract.expiration",
      relativeX: 0.63,
      relativeY: 0.41
    });
  });

  it("安定IDがなければ範囲内のSCREEN_POSITIONへ変換する", () => {
    const target = resolveScreenTarget({ clientX: -10, clientY: 900 }, null, viewport);
    expect(target).toEqual({ type: "SCREEN_POSITION", relativeX: 0, relativeY: 1 });
  });
});
describe("MapLibre対象解決", () => {
  const click = { point: { x: 120, y: 240 }, lngLat: { lng: 139.7001, lat: 35.6902 } };
  const mapWith = (features: FeedbackQueriedFeature[]): FeedbackMapLike => ({
    queryRenderedFeatures: vi.fn(() => features)
  });

  it("レイヤ固有属性からMAP_FEATUREへ変換する", () => {
    const map = mapWith([{ source: "building", properties: { building_id: "B-42" } }]);
    expect(resolveMapTarget(map, click, { featureIdPropertyBySource: { building: "building_id" } })).toEqual({
      type: "MAP_FEATURE",
      longitude: 139.7001,
      latitude: 35.6902,
      source: "building",
      featureId: "B-42"
    });
  });

  it("地物がなければMAP_POSITIONへ変換する", () => {
    expect(resolveMapTarget(mapWith([]), click)).toEqual({
      type: "MAP_POSITION",
      longitude: 139.7001,
      latitude: 35.6902
    });
  });
});

describe("保存対象の復元", () => {
  it("妥当な対象だけを復元する", () => {
    expect(parseFeedbackTarget({ type: "SCREEN_POSITION", relativeX: 0.2, relativeY: 0.4 })).toEqual({
      type: "SCREEN_POSITION",
      relativeX: 0.2,
      relativeY: 0.4
    });
    expect(parseFeedbackTarget({ type: "SCREEN_POSITION", relativeX: 2, relativeY: 0.4 })).toBeNull();
  });
});
