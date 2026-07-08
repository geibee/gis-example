// 純ロジックのユニットテストの見本。DOM もプロバイダも不要な関数は
// このようにそのまま呼んで検証する。
import { describe, expect, it } from "vitest";
import {
  mergeChoiceOptions,
  moveLayerBefore,
  normalizeZoneLayerFilter,
  nullableInteger,
  orderLayers,
  parseDraftValue,
  parsePartyTags
} from "./utils";
import { makeLayer } from "./testing/fixtures";

describe("parseDraftValue", () => {
  it("数値・真偽値の文字列を型付きの値へ変換する", () => {
    expect(parseDraftValue(" 42 ")).toBe(42);
    expect(parseDraftValue("-1.5")).toBe(-1.5);
    expect(parseDraftValue("TRUE")).toBe(true);
    expect(parseDraftValue("false")).toBe(false);
  });

  it("数値・真偽値でなければトリムした文字列のまま返す", () => {
    expect(parseDraftValue(" 大手町 ")).toBe("大手町");
    expect(parseDraftValue("1-2-3")).toBe("1-2-3");
  });
});

describe("parsePartyTags", () => {
  it("読点・カンマ区切りをトリムし重複を除いて配列化する", () => {
    expect(parsePartyTags("地権者、 売主, 地権者,")).toEqual(["地権者", "売主"]);
  });
});

describe("nullableInteger", () => {
  it("空文字は null、整数はそのまま返す", () => {
    expect(nullableInteger("  ", "階数")).toBeNull();
    expect(nullableInteger("3", "階数")).toBe(3);
  });

  it("整数でない入力はフィールド名入りのエラーを投げる", () => {
    expect(() => nullableInteger("2.5", "階数")).toThrow("階数 は整数で入力してください");
  });
});

describe("レイヤ並び替え", () => {
  const layers = [makeLayer({ id: "a" }), makeLayer({ id: "b" }), makeLayer({ id: "c" })];

  it("moveLayerBefore は対象レイヤの前へ移動する", () => {
    expect(moveLayerBefore(layers, "c", "a").map((layer) => layer.id)).toEqual(["c", "a", "b"]);
  });

  it("moveLayerBefore は不明な ID なら並びを変えない", () => {
    expect(moveLayerBefore(layers, "x", "a")).toBe(layers);
  });

  it("orderLayers は保存順を優先し、未知のレイヤは末尾へ置く", () => {
    expect(orderLayers(layers, ["b", "x", "a"]).map((layer) => layer.id)).toEqual(["b", "a", "c"]);
  });
});

describe("normalizeZoneLayerFilter", () => {
  const zoneLayers = [makeLayer({ id: "zl-1" }), makeLayer({ id: "zl-2" })];

  it("選択中の区域レイヤが存在すればそのまま返す", () => {
    const filters = { zoneLayerId: "zl-2" };
    expect(normalizeZoneLayerFilter(filters, zoneLayers)).toBe(filters);
  });

  it("選択が無効なら先頭の区域レイヤへ寄せる", () => {
    expect(normalizeZoneLayerFilter({ zoneLayerId: "gone" }, zoneLayers)).toEqual({ zoneLayerId: "zl-1" });
  });

  it("区域レイヤがなければ選択を落とす", () => {
    expect(normalizeZoneLayerFilter({ zoneLayerId: "gone", status: "有効" }, [])).toEqual({ status: "有効" });
  });
});

describe("mergeChoiceOptions", () => {
  it("既定値と実データを結合し、空値・重複を除く", () => {
    expect(mergeChoiceOptions(["有効"], ["検討中", " ", null], "有効")).toEqual(["有効", "検討中"]);
  });
});
