import { AttributionControl, type Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

// WebGL のみを省き、出典表示はインストール済み MapLibre の実装を通す。
function attributionMap(attribution?: string): MapLibreMap {
  return {
    style: {
      tileManagers: attribution ? {
        source: { used: true, getSource: () => ({ attribution }) }
      } : {}
    },
    _getUIString: () => "出典表示",
    getCanvasContainer: () => document.createElement("div"),
    on: vi.fn(),
    off: vi.fn()
  } as unknown as MapLibreMap;
}

describe("MapLibre の出典表示", () => {
  // CVE-2026-85061: live NamedNodeMap の削除で隣接する危険属性が残る回帰を防ぐ。
  const unsafeAttribution = '<details open onload="void 0" ontoggle="void 0">出典</details>';

  it.each(["custom", "source"] as const)("%s 出典の隣接するイベント属性をすべて除去する", (kind) => {
    const control = new AttributionControl({
      compact: true,
      ...(kind === "custom" ? { customAttribution: unsafeAttribution } : {})
    });
    try {
      const element = control.onAdd(attributionMap(kind === "source" ? unsafeAttribution : undefined));
      const attribution = element.querySelector(".maplibregl-ctrl-attrib-inner details");
      expect(attribution).not.toBeNull();
      expect(attribution).toHaveTextContent("出典");
      expect(attribution).not.toHaveAttribute("onload");
      expect(attribution).not.toHaveAttribute("ontoggle");
    } finally {
      control.onRemove();
    }
  });

  it("正当な出典リンクを維持する", () => {
    const control = new AttributionControl({
      customAttribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>'
    });
    try {
      const element = control.onAdd(attributionMap());
      const link = element.querySelector(".maplibregl-ctrl-attrib-inner a");
      expect(link).toHaveTextContent("© OpenStreetMap contributors");
      expect(link).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    } finally {
      control.onRemove();
    }
  });
});
