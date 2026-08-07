// コメント投稿時点のビューポートを PNG として固定化する (docs/prototype-review.md 第 4〜5 章)。
//
// 方針: 「将来画面を再現する」のではなく「投稿時点のレンダリング結果を証跡として固める」。
// 通常 DOM は html-to-image (SVG foreignObject 経由) で、MapLibre は WebGL Canvas を
// html-to-image が toDataURL で取り込むことで、1 枚の PNG に合成する。
import { toBlob } from "html-to-image";
import { captureExcludeAttribute } from "./types";

/** MapLibre が生成する描画 Canvas のセレクタ (maplibre-gl の公開クラス名)。 */
export const maplibreCanvasSelector = "canvas.maplibregl-canvas";

/**
 * 証跡 PNG の解像度上限。Retina (dpr=3) をそのまま使うと PNG が数 MB になり
 * Blob Storage と一覧表示の双方に効くため、既定で 2 倍までに丸める。
 */
export const defaultMaxPixelRatio = 2;

/** ビルド時に注入されるフロントエンドのバージョン (未設定なら開発ビルド扱い)。 */
export const frontendVersion = import.meta.env.VITE_APP_VERSION ?? "dev";


export type ViewportEvidence = {
  /** PNG 本体。API へは multipart/form-data の一部として送る想定。 */
  blob: Blob;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  /** 実際に適用した解像度倍率 (devicePixelRatio を maxPixelRatio で丸めた値)。 */
  pixelRatio: number;
  /** 投稿時点の画面 (pathname + search)。ReviewScope との突合に使う。 */
  route: string;
  frontendVersion: string;
  capturedAt: string;
  elapsedMs: number;
};

export type CaptureViewportOptions = {
  /** キャプチャ範囲の親要素。既定は document.body。 */
  root?: HTMLElement;
  maxPixelRatio?: number;
  /** 追加の除外条件 (false を返した要素とその子孫を証跡から除く)。 */
  filter?: (node: Element) => boolean;
  /**
   * Web フォントの埋め込みをスキップする。クロスオリジンのフォント CSS を
   * 読めない環境で全体が失敗するのを避けたい場合に true にする。
   */
  skipFonts?: boolean;
};

/**
 * 現在のビューポートを PNG に固定化する。
 *
 * フルページではなく「顧客がいま見ている 1 画面」を対象とする。スクロール量ぶん
 * 内容を逆方向へ平行移動し、ビューポートサイズで切り出す。
 */
export async function captureViewport(options: CaptureViewportOptions = {}): Promise<ViewportEvidence> {
  const root = options.root ?? document.body;
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;

  const viewportWidth = doc.documentElement.clientWidth || view.innerWidth;
  const viewportHeight = doc.documentElement.clientHeight || view.innerHeight;
  const scrollX = Math.round(view.scrollX);
  const scrollY = Math.round(view.scrollY);
  const pixelRatio = Math.min(view.devicePixelRatio || 1, options.maxPixelRatio ?? defaultMaxPixelRatio);

  const startedAt = view.performance.now();
  const blob = await toBlob(root, {
    width: viewportWidth,
    height: viewportHeight,
    pixelRatio,
    skipFonts: options.skipFonts ?? false,
    // ページ全体ではなく現在のビューポートを切り出すため、スクロール量だけ内容をずらす
    style: {
      transform: `translate(${-scrollX}px, ${-scrollY}px)`,
      transformOrigin: "top left"
    },
    filter: (node) => includeNode(node, options.filter)
  });
  const elapsedMs = Math.round(view.performance.now() - startedAt);

  if (!blob) {
    throw new Error("スクリーンショットの生成に失敗しました");
  }

  return {
    blob,
    viewportWidth,
    viewportHeight,
    scrollX,
    scrollY,
    pixelRatio,
    route: `${view.location.pathname}${view.location.search}`,
    frontendVersion,
    capturedAt: new Date().toISOString(),
    elapsedMs
  };
}

function includeNode(node: unknown, extra?: (node: Element) => boolean): boolean {
  // html-to-image は要素以外 (テキストノード等) も filter に渡す
  if (!isElement(node)) return true;
  if (node.hasAttribute(captureExcludeAttribute)) return false;
  return extra ? extra(node) : true;
}

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && (node as Node).nodeType === 1;
}

/**
 * 証跡に写らない WebGL Canvas を洗い出す。
 *
 * `preserveDrawingBuffer: false` (MapLibre の既定) の Canvas は、フレーム合成後に
 * `toDataURL()` が空画像を返す。そのままキャプチャすると「地図だけ真っ白な証跡」が
 * 残り、しかも例外は起きないので気付けない。地図初期化時の設定漏れを検出するために使う。
 */
export function findUnreadableMapCanvases(
  root: ParentNode,
  selector: string = maplibreCanvasSelector
): HTMLCanvasElement[] {
  return Array.from(root.querySelectorAll<HTMLCanvasElement>(selector)).filter(
    (canvas) => preservesDrawingBuffer(canvas) === false
  );
}

/**
 * Canvas が描画バッファを保持しているか。判定できない場合 (WebGL コンテキストが
 * 取れない = jsdom 等) は null を返し、警告の対象にしない。
 */
function preservesDrawingBuffer(canvas: HTMLCanvasElement): boolean | null {
  // 既にコンテキストが存在する Canvas では、同じ型の getContext は生成済みの
  // コンテキストをそのまま返す (新規生成の副作用はない)。MapLibre v5 の既定は
  // webgl2 で、取れない環境では webgl にフォールバックする
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!context) return null;
  return context.getContextAttributes()?.preserveDrawingBuffer === true;
}
