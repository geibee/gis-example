import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureViewport, findUnreadableMapCanvases } from "./capture";
import { captureReadyCanvasContextAttributes } from "./types";

const toBlob = vi.hoisted(() => vi.fn());
vi.mock("html-to-image", () => ({ toBlob }));

beforeEach(() => {
  toBlob.mockReset();
  toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
});
describe("画面キャプチャ", () => {
  it("アプリ版とビューポートを証跡へ固定し、SDK UIを除外する", async () => {
    document.body.innerHTML = `<main id="host"></main><div id="sdk" data-review-exclude></div>`;
    const evidence = await captureViewport({ appVersion: "2026.08.08" });
    const options = toBlob.mock.calls[0][1] as { filter: (node: unknown) => boolean };
    expect(evidence).toMatchObject({ viewportWidth: 1200, viewportHeight: 800, frontendVersion: "2026.08.08" });
    expect(options.filter(document.querySelector("#host"))).toBe(true);
    expect(options.filter(document.querySelector("#sdk"))).toBe(false);
  });

  it("画像生成不能を呼び出し側へ通知する", async () => {
    toBlob.mockResolvedValue(null);
    await expect(captureViewport()).rejects.toThrow("スクリーンショットの生成に失敗しました");
  });
});

describe("MapLibreキャプチャ契約", () => {
  it("preserveDrawingBufferを公開し、設定漏れCanvasを検出する", () => {
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    canvas.getContext = vi.fn(() => ({
      getContextAttributes: () => ({ preserveDrawingBuffer: false })
    })) as unknown as HTMLCanvasElement["getContext"];
    document.body.append(canvas);
    expect(captureReadyCanvasContextAttributes).toEqual({ preserveDrawingBuffer: true });
    expect(findUnreadableMapCanvases(document)).toEqual([canvas]);
  });
});
