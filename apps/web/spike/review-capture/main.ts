// Phase 0 スパイク (docs/prototype-review.md 第 18 章) の検証ページ。
//
// 目的: 業務 DOM と MapLibre の WebGL Canvas が混在した画面を、証跡として
// 実用に足る 1 枚の PNG に固定化できるかを実測する。本番バンドルには含まれない
// (vite.config.ts の rollupOptions.input に入れていないため build 対象外)。
//
//   npm --workspace apps/web run dev
//   → http://localhost:5173/spike/review-capture/index.html
//     ?pdb=0 を付けると preserveDrawingBuffer 無効で同じ検証を行う (対照実験)
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { captureViewport, findUnreadableMapCanvases, resolveMapTarget } from "../../src/review";
import type { FeedbackTarget } from "../../src/review";

const params = new URLSearchParams(window.location.search);
const preserveDrawingBuffer = params.get("pdb") !== "0";
/** 別オリジンのラスタタイルを重ねて CORS の影響を確認するための指定 (例: ?raster=http://localhost:5199)。 */
const rasterOrigin = params.get("raster");

/** 地図領域が証跡に写ったかを判定するための、地図だけが持つ塗り色。 */
const parcelFillColor = "#0f766e";
const mapBackgroundColor = "#dbeafe";

type RegionReport = {
  /** 完全な白 (= 何も写っていない) ピクセルの割合。 */
  blankRatio: number;
  /** 領域内の平均色。 */
  meanColor: [number, number, number];
  sampledPixels: number;
};

type SpikeReport = {
  preserveDrawingBuffer: boolean;
  rasterOrigin: string | null;
  /** タイル取得等で MapLibre が報告したエラー (CORS 失敗はここに出る)。 */
  mapErrors: string[];
  devicePixelRatio: number;
  pixelRatio: number;
  viewport: { width: number; height: number };
  captureMs: number;
  pngBytes: number;
  unreadableMapCanvases: number;
  mapRegion: RegionReport;
  domRegion: RegionReport;
  error?: string;
};

declare global {
  interface Window {
    spikeReport?: SpikeReport;
    spikeTarget?: FeedbackTarget;
  }
}

// ---------------------------------------------------------------- 画面の組み立て
const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("#root がありません");

document.body.style.margin = "0";
document.body.style.font = "14px system-ui, sans-serif";
document.body.style.color = "#0f172a";

root.innerHTML = `
  <div style="display:flex; height:100vh;">
    <section style="width:380px; padding:16px; overflow:auto; background:#f8fafc; border-right:1px solid #e2e8f0;">
      <h1 style="font-size:18px; margin:0 0 12px;">案件詳細 (スパイク用ダミー)</h1>
      <svg width="120" height="24" viewBox="0 0 120 24" aria-hidden="true">
        <rect x="0" y="4" width="116" height="16" rx="8" fill="#7c3aed" />
        <circle cx="12" cy="12" r="5" fill="#fde68a" />
      </svg>
      <label style="display:block; margin:12px 0 4px;" for="expiration">契約満了日</label>
      <input id="expiration" data-feedback-id="contract-expiration-date" value="2027-03-31"
             style="width:100%; padding:6px; border:1px solid #cbd5f5; border-radius:4px;" />
      <div data-feedback-id="business-summary"
           style="margin-top:16px; padding:12px; background:#fff; border:1px solid #e2e8f0; border-radius:6px;">
        <div id="dom-probe" style="height:32px; background:${parcelFillColor}; border-radius:4px;"></div>
        <p style="margin:8px 0 0;">地物と業務情報の連動を確認するための領域です。</p>
      </div>
      <ul style="margin-top:16px; padding-left:18px; line-height:1.9;">
        <li>スクロール領域の再現</li>
        <li>SVG の再現</li>
        <li>fixed 要素の再現</li>
      </ul>
      <div style="height:600px;"></div>
      <p>スクロール下端</p>
    </section>
    <section id="map" style="flex:1;"></section>
  </div>
  <div data-review-exclude
       style="position:fixed; right:16px; bottom:16px; display:flex; gap:8px; z-index:10;">
    <button id="capture" style="padding:10px 16px; border-radius:8px; border:0; background:#0f172a; color:#fff;">
      証跡をキャプチャ
    </button>
  </div>
  <div id="result" style="position:fixed; left:16px; bottom:16px; max-width:420px; background:#fff;
       border:1px solid #cbd5f5; border-radius:8px; padding:12px; font-family:ui-monospace, monospace;
       font-size:12px; white-space:pre-wrap;" data-review-exclude></div>
`;

// ---------------------------------------------------------------- 地図 (完全オフライン)
const parcels: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 123456,
      properties: { fid: "123456", name: "検証用筆" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [139.69, 35.68],
            [139.71, 35.68],
            [139.71, 35.7],
            [139.69, 35.7],
            [139.69, 35.68]
          ]
        ]
      }
    }
  ]
};

const map = new maplibregl.Map({
  container: "map",
  // 証跡キャプチャの前提: WebGL の描画バッファを保持しないと toDataURL が空画像を返す。
  // MapLibre v5 では Map 直下ではなく canvasContextAttributes に置く
  canvasContextAttributes: { preserveDrawingBuffer },
  center: [139.7, 35.69],
  zoom: 12,
  style: {
    version: 8,
    sources: {
      parcel: { type: "geojson", data: parcels },
      ...(rasterOrigin
        ? {
            raster: {
              type: "raster" as const,
              tiles: [`${rasterOrigin}/{z}/{x}/{y}.png`],
              tileSize: 256,
              minzoom: 12,
              maxzoom: 12
            }
          }
        : {})
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": mapBackgroundColor } },
      ...(rasterOrigin ? [{ id: "raster", type: "raster" as const, source: "raster" }] : []),
      { id: "parcel-fill", type: "fill", source: "parcel", paint: { "fill-color": parcelFillColor } },
      { id: "parcel-line", type: "line", source: "parcel", paint: { "line-color": "#134e4a", "line-width": 2 } }
    ]
  }
});

// タイル取得の失敗 (CORS 等) を握り潰さず記録する
const mapErrors: string[] = [];
map.on("error", (event) => {
  mapErrors.push(event.error?.message ?? String(event.error ?? "unknown"));
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
new maplibregl.Marker({ color: "#be123c" })
  .setLngLat([139.7, 35.69])
  .setPopup(new maplibregl.Popup({ closeButton: false }).setText("Marker + Popup の再現確認"))
  .addTo(map)
  .togglePopup();

// 地図クリック → FeedbackTarget 解決 (Phase 3 のアダプタ相当を実地で確認する)
map.on("click", (event) => {
  window.spikeTarget = resolveMapTarget(map, event, {
    layers: ["parcel-fill"],
    featureIdProperty: "fid"
  });
});

// ---------------------------------------------------------------- キャプチャと自己検証
async function runCapture(): Promise<SpikeReport> {
  const mapRect = document.querySelector("#map")!.getBoundingClientRect();
  const domRect = document.querySelector("#dom-probe")!.getBoundingClientRect();
  const unreadable = findUnreadableMapCanvases(document);

  const evidence = await captureViewport();
  const bitmap = await createImageBitmap(evidence.blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d コンテキストを取得できません");
  // 未描画部分 (透明) を「白紙」として数えたいので白地に載せる
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);

  return {
    preserveDrawingBuffer,
    rasterOrigin,
    mapErrors: [...new Set(mapErrors)],
    devicePixelRatio: window.devicePixelRatio,
    pixelRatio: evidence.pixelRatio,
    viewport: { width: evidence.viewportWidth, height: evidence.viewportHeight },
    captureMs: evidence.elapsedMs,
    pngBytes: evidence.blob.size,
    unreadableMapCanvases: unreadable.length,
    mapRegion: measureRegion(context, mapRect, evidence.pixelRatio),
    domRegion: measureRegion(context, domRect, evidence.pixelRatio)
  };
}

function measureRegion(
  context: CanvasRenderingContext2D,
  rect: DOMRect,
  pixelRatio: number
): RegionReport {
  const x = Math.round(rect.left * pixelRatio);
  const y = Math.round(rect.top * pixelRatio);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  const { data } = context.getImageData(x, y, width, height);

  let blank = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    if (data[index] === 255 && data[index + 1] === 255 && data[index + 2] === 255) blank += 1;
  }
  return {
    blankRatio: Number((blank / pixels).toFixed(4)),
    meanColor: [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)],
    sampledPixels: pixels
  };
}

const resultBox = document.querySelector<HTMLDivElement>("#result")!;
document.querySelector<HTMLButtonElement>("#capture")!.addEventListener("click", () => {
  resultBox.textContent = "キャプチャ中...";
  runCapture().then(
    (report) => {
      window.spikeReport = report;
      resultBox.textContent = JSON.stringify(report, null, 2);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      window.spikeReport = { error: message } as SpikeReport;
      resultBox.textContent = `失敗: ${message}`;
    }
  );
});

map.on("idle", () => {
  document.body.dataset.mapIdle = "true";
});
