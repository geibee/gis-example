import { describe, expect, it } from "vitest";
import {
  parseFeedbackTarget,
  resolveMapTarget,
  resolveScreenTarget,
  type FeedbackMapLike,
  type FeedbackQueriedFeature
} from "./target";

const viewport = { width: 1000, height: 500 };

describe("resolveScreenTarget", () => {
  it("data-feedback-id を持つ祖先があれば UI_ELEMENT にする", () => {
    document.body.innerHTML = `
      <div data-feedback-id="contract-expiration-date">
        <span id="label">契約満了日</span>
      </div>`;
    const label = document.querySelector("#label");

    expect(resolveScreenTarget({ clientX: 630, clientY: 205 }, label, viewport)).toEqual({
      type: "UI_ELEMENT",
      feedbackTargetId: "contract-expiration-date",
      relativeX: 0.63,
      relativeY: 0.41
    });
  });

  it("安定 ID を辿れなければ SCREEN_POSITION にする", () => {
    document.body.innerHTML = `<div id="plain">見出し</div>`;

    expect(resolveScreenTarget({ clientX: 500, clientY: 250 }, document.querySelector("#plain"), viewport)).toEqual({
      type: "SCREEN_POSITION",
      relativeX: 0.5,
      relativeY: 0.5
    });
  });

  it("空の data-feedback-id は無効な安定 ID として扱う", () => {
    document.body.innerHTML = `<div id="blank" data-feedback-id="  ">見出し</div>`;

    expect(resolveScreenTarget({ clientX: 0, clientY: 0 }, document.querySelector("#blank"), viewport).type).toBe(
      "SCREEN_POSITION"
    );
  });

  it("相対座標は 0〜1 に丸める (画面外のクリックでも範囲外の値を保存しない)", () => {
    const target = resolveScreenTarget({ clientX: -40, clientY: 900 }, null, viewport);

    expect(target).toEqual({ type: "SCREEN_POSITION", relativeX: 0, relativeY: 1 });
  });

  it("ビューポートサイズが 0 でも NaN を保存しない", () => {
    const target = resolveScreenTarget({ clientX: 100, clientY: 100 }, null, { width: 0, height: 0 });

    expect(target).toEqual({ type: "SCREEN_POSITION", relativeX: 0, relativeY: 0 });
  });
});

describe("resolveMapTarget", () => {
  const click = { point: { x: 120, y: 240 }, lngLat: { lng: 139.7001, lat: 35.6902 } };

  const mapWith = (features: FeedbackQueriedFeature[]): FeedbackMapLike => ({
    queryRenderedFeatures: () => features
  });

  it("地物に当たれば MAP_FEATURE として source / featureId を保持する", () => {
    const map = mapWith([
      { source: "parcel", sourceLayer: "parcel", id: 999, properties: { fid: "123456" } }
    ]);

    expect(resolveMapTarget(map, click, { featureIdProperty: "fid" })).toEqual({
      type: "MAP_FEATURE",
      longitude: 139.7001,
      latitude: 35.6902,
      source: "parcel",
      sourceLayer: "parcel",
      featureId: "123456"
    });
  });

  it("featureIdProperty に値がなければ MapLibre の feature.id へフォールバックする", () => {
    const map = mapWith([{ source: "parcel", properties: {} , id: 4242 }]);

    expect(resolveMapTarget(map, click, { featureIdProperty: "fid" })).toMatchObject({
      type: "MAP_FEATURE",
      featureId: "4242"
    });
  });

  it("sourceLayer が無い GeoJSON ソースではキーごと省く", () => {
    const map = mapWith([{ source: "highlight", id: "abc" }]);

    expect(resolveMapTarget(map, click)).toEqual({
      type: "MAP_FEATURE",
      longitude: 139.7001,
      latitude: 35.6902,
      source: "highlight",
      featureId: "abc"
    });
  });

  it("地物に当たらなければ MAP_POSITION にする", () => {
    expect(resolveMapTarget(mapWith([]), click)).toEqual({
      type: "MAP_POSITION",
      longitude: 139.7001,
      latitude: 35.6902
    });
  });

  it("ID を取り出せない地物は地点コメントに落とす (空 ID を保存しない)", () => {
    const map = mapWith([{ source: "parcel", properties: { fid: "" } }]);

    expect(resolveMapTarget(map, click, { featureIdProperty: "fid" }).type).toBe("MAP_POSITION");
  });

  it("問い合わせ対象レイヤが空なら地物判定そのものを行わない", () => {
    let queried = false;
    const map = {
      queryRenderedFeatures: () => {
        queried = true;
        return [{ source: "parcel", id: 1 }];
      }
    } as unknown as FeedbackMapLike;

    expect(resolveMapTarget(map, click, { layers: [] }).type).toBe("MAP_POSITION");
    expect(queried).toBe(false);
  });

  it("ソースごとの ID 属性名を使い分ける", () => {
    const map = mapWith([{ source: "building-layer", properties: { building_id: "B-42", fid: "wrong" } }]);

    expect(
      resolveMapTarget(map, click, { featureIdPropertyBySource: { "building-layer": "building_id" } })
    ).toMatchObject({ type: "MAP_FEATURE", featureId: "B-42" });
  });
});

describe("parseFeedbackTarget", () => {
  it("API の JSON を FeedbackTarget に復元する", () => {
    expect(
      parseFeedbackTarget({
        type: "MAP_FEATURE",
        longitude: 139.7,
        latitude: 35.6,
        source: "parcel",
        sourceLayer: "parcel",
        featureId: "10"
      })
    ).toEqual({
      type: "MAP_FEATURE",
      longitude: 139.7,
      latitude: 35.6,
      source: "parcel",
      sourceLayer: "parcel",
      featureId: "10"
    });
  });

  it("範囲外座標や欠損値を描画対象にしない", () => {
    expect(parseFeedbackTarget({ type: "SCREEN_POSITION", relativeX: 2, relativeY: 0.5 })).toBeNull();
    expect(parseFeedbackTarget({ type: "MAP_POSITION", longitude: 200, latitude: 35 })).toBeNull();
    expect(parseFeedbackTarget({ type: "UI_ELEMENT", feedbackTargetId: "field" })).toBeNull();
    expect(
      parseFeedbackTarget({ type: "UI_ELEMENT", feedbackTargetId: "  ", relativeX: 0.2, relativeY: 0.3 })
    ).toBeNull();
  });
});
