import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { feedbackTargetFromMapClick, type FeedbackAdapterMap } from "./mapAdapter";

// FeedbackMapAdapter: 地図クリックを「この地物への指摘」に変換できること。
// 地図は DOM を持たないため、この解決ができないと GIS への指摘が
// 「画面のこの辺」に落ちてしまう (本基盤の差別化が失われる)。
describe("feedbackTargetFromMapClick", () => {
  const click = { point: { x: 120, y: 240 }, lngLat: { lng: 139.7001, lat: 35.6902 } };

  const mapWith = (features: Parameters<typeof mockFeatures>[0]): FeedbackAdapterMap => ({
    queryRenderedFeatures: () => mockFeatures(features)
  });

  function mockFeatures(
    features: Array<{
      source: string;
      sourceLayer?: string;
      id?: string | number;
      properties?: Record<string, unknown>;
      layerId: string;
    }>
  ) {
    return features.map(({ layerId, ...rest }) => ({ ...rest, layer: { id: layerId } }));
  }

  it("地物に当たればレイヤ固有の ID 列で MAP_FEATURE にする", () => {
    const map = mapWith([
      { source: "parcel", sourceLayer: "parcel", properties: { chiban: "1-2-3" }, layerId: "parcel-fill" }
    ]);

    const target = feedbackTargetFromMapClick(map, click, {
      layers: ["parcel-fill"],
      // レイヤごとに ID 列が違う (Layer.featureIdColumn) ことを再現する
      featureIdPropertyOf: (styleLayerId) => (styleLayerId === "parcel-fill" ? "chiban" : "fid")
    });

    expect(target).toEqual({
      type: "MAP_FEATURE",
      longitude: 139.7001,
      latitude: 35.6902,
      source: "parcel",
      sourceLayer: "parcel",
      featureId: "1-2-3"
    });
  });

  it("表示中のレイヤが無ければ問い合わせずに地点コメントにする", () => {
    const queryRenderedFeatures = vi.fn();
    const target = feedbackTargetFromMapClick({ queryRenderedFeatures }, click, { layers: [] });

    expect(target).toEqual({ type: "MAP_POSITION", longitude: 139.7001, latitude: 35.6902 });
    expect(queryRenderedFeatures).not.toHaveBeenCalled();
  });

  it("地物に当たらなければ地点コメントにする (この辺りが見づらい、を残せる)", () => {
    const target = feedbackTargetFromMapClick(mapWith([]), click, { layers: ["parcel-fill"] });

    expect(target).toEqual({ type: "MAP_POSITION", longitude: 139.7001, latitude: 35.6902 });
  });

  it("ID 列の指定が無ければ MapLibre の feature.id にフォールバックする", () => {
    const map = mapWith([{ source: "parcel", id: 4242, layerId: "parcel-fill" }]);

    expect(feedbackTargetFromMapClick(map, click, { layers: ["parcel-fill"] })).toMatchObject({
      type: "MAP_FEATURE",
      featureId: "4242"
    });
  });

  it("ID を取り出せない地物は地点コメントに落とす (空 ID を保存しない)", () => {
    const map = mapWith([{ source: "parcel", properties: { fid: "" }, layerId: "parcel-fill" }]);

    expect(
      feedbackTargetFromMapClick(map, click, { layers: ["parcel-fill"], featureIdPropertyOf: () => "fid" }).type
    ).toBe("MAP_POSITION");
  });

  it("問い合わせは表示中のレイヤに限定する", () => {
    const queryRenderedFeatures = vi.fn(() => []);
    feedbackTargetFromMapClick({ queryRenderedFeatures }, click, { layers: ["parcel-fill", "parcel-line"] });

    expect(queryRenderedFeatures).toHaveBeenCalledWith([120, 240], { layers: ["parcel-fill", "parcel-line"] });
  });
});

describe("地図ペインへの配線", () => {
  it("MapPane がレビューモード中の地図クリックをアダプタへ回している", () => {
    // アダプタ単体が正しくても、MapPane が呼ばなければ地図への指摘は
    // 「画面のこの辺 (SCREEN_POSITION)」に落ちる。実行時に気付けないので配線を固定する
    const source = readFileSync(resolve(process.cwd(), "src/components/MapPane.tsx"), "utf8");

    expect(source).toContain("if (feedbackPicking)");
    expect(source).toContain("feedbackTargetFromMapClick(map, event,");
  });
});
