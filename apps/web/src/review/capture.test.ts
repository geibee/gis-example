import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureViewport, defaultMaxPixelRatio, findUnreadableMapCanvases } from "./capture";
import { captureReadyCanvasContextAttributes } from "./types";

const toBlob = vi.hoisted(() => vi.fn());
vi.mock("html-to-image", () => ({ toBlob }));

/** html-to-image に渡ったオプション (最後の呼び出し)。 */
type ToBlobOptions = {
  width: number;
  height: number;
  pixelRatio: number;
  skipFonts: boolean;
  style: Record<string, string>;
  filter: (node: unknown) => boolean;
};
const lastOptions = () => toBlob.mock.calls[toBlob.mock.calls.length - 1][1] as ToBlobOptions;

function setViewport(width: number, height: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
}

beforeEach(() => {
  toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  setViewport(1440, 900);
  window.scrollTo(0, 0);
  Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  document.body.innerHTML = "";
});

describe("captureViewport", () => {
  it("ビューポートのサイズ・スクロール位置・画面を証跡メタデータとして返す", async () => {
    Object.defineProperty(window, "scrollX", { value: 12, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 340, configurable: true });

    const evidence = await captureViewport();

    expect(evidence.viewportWidth).toBe(1440);
    expect(evidence.viewportHeight).toBe(900);
    expect(evidence.scrollX).toBe(12);
    expect(evidence.scrollY).toBe(340);
    expect(evidence.route).toBe(`${window.location.pathname}${window.location.search}`);
    expect(evidence.blob.type).toBe("image/png");
    expect(Number.isNaN(Date.parse(evidence.capturedAt))).toBe(false);
  });

  it("フルページではなく現在のビューポートを切り出す (スクロール量だけ内容をずらす)", async () => {
    Object.defineProperty(window, "scrollX", { value: 12, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 340, configurable: true });

    await captureViewport();

    expect(lastOptions()).toMatchObject({
      width: 1440,
      height: 900,
      style: { transform: "translate(-12px, -340px)", transformOrigin: "top left" }
    });
  });

  it("高 DPI 端末でも解像度倍率を上限で丸める (証跡 PNG の肥大を防ぐ)", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });

    const evidence = await captureViewport();

    expect(evidence.pixelRatio).toBe(defaultMaxPixelRatio);
    expect(lastOptions().pixelRatio).toBe(defaultMaxPixelRatio);
  });

  it("data-review-exclude を付けた要素 (レビュー UI 自身) を証跡から除外する", async () => {
    document.body.innerHTML = `
      <div id="business">業務画面</div>
      <div id="overlay" data-review-exclude>フィードバックボタン</div>`;
    await captureViewport();
    const { filter } = lastOptions();

    expect(filter(document.querySelector("#business"))).toBe(true);
    expect(filter(document.querySelector("#overlay"))).toBe(false);
  });

  it("要素以外のノード (テキストノード) は除外しない", async () => {
    await captureViewport();

    expect(lastOptions().filter(document.createTextNode("コメント対象"))).toBe(true);
  });

  it("呼び出し側の追加除外条件と併用できる", async () => {
    document.body.innerHTML = `<div id="secret" class="masked">個人情報</div>`;
    await captureViewport({ filter: (node) => !node.classList.contains("masked") });

    expect(lastOptions().filter(document.querySelector("#secret"))).toBe(false);
  });

  it("PNG を生成できなかった場合は握り潰さず失敗させる", async () => {
    toBlob.mockResolvedValue(null);

    await expect(captureViewport()).rejects.toThrow("スクリーンショットの生成に失敗しました");
  });
});

describe("findUnreadableMapCanvases", () => {
  const canvasWith = (preserveDrawingBuffer: boolean | null) => {
    const canvas = document.createElement("canvas");
    canvas.className = "maplibregl-canvas";
    canvas.getContext = vi.fn((type: string) =>
      type === "webgl2" && preserveDrawingBuffer !== null
        ? { getContextAttributes: () => ({ preserveDrawingBuffer }) }
        : null
    ) as unknown as HTMLCanvasElement["getContext"];
    document.body.append(canvas);
    return canvas;
  };

  it("preserveDrawingBuffer が無効な地図 Canvas を検出する", () => {
    const unreadable = canvasWith(false);

    expect(findUnreadableMapCanvases(document)).toEqual([unreadable]);
  });

  it("preserveDrawingBuffer が有効なら検出しない", () => {
    canvasWith(true);

    expect(findUnreadableMapCanvases(document)).toEqual([]);
  });

  it("WebGL コンテキストを取得できない環境 (jsdom 等) は判定対象にしない", () => {
    canvasWith(null);

    expect(findUnreadableMapCanvases(document)).toEqual([]);
  });
});

describe("地図キャプチャの前提設定", () => {
  it("MapPane が共有の canvasContextAttributes を使って地図を生成している", () => {
    // preserveDrawingBuffer を落とすと「地図だけ白紙の証跡」が例外なしで量産される。
    // 気付ける場所が実行時に無いため、配線そのものをここで固定する
    // vitest の cwd は apps/web (vitest.config.ts の root)
    const source = readFileSync(resolve(process.cwd(), "src/components/MapPane.tsx"), "utf8");

    expect(source).toContain("canvasContextAttributes: captureReadyCanvasContextAttributes");
    expect(captureReadyCanvasContextAttributes.preserveDrawingBuffer).toBe(true);
  });
});
