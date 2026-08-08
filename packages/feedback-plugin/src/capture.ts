import { toBlob } from "html-to-image";
import { captureExcludeAttribute } from "./types";

export const maplibreCanvasSelector = "canvas.maplibregl-canvas";
export const defaultMaxPixelRatio = 2;

export type ViewportEvidence = {
  blob: Blob;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  pixelRatio: number;
  route: string;
  frontendVersion: string;
  capturedAt: string;
  elapsedMs: number;
};

export type CaptureViewportOptions = {
  root?: HTMLElement;
  maxPixelRatio?: number;
  filter?: (node: Element) => boolean;
  skipFonts?: boolean;
  appVersion?: string;
};

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
    style: {
      transform: `translate(${-scrollX}px, ${-scrollY}px)`,
      transformOrigin: "top left"
    },
    filter: (node) => includeNode(node, options.filter)
  });
  const elapsedMs = Math.round(view.performance.now() - startedAt);
  if (!blob) throw new Error("スクリーンショットの生成に失敗しました");
  return {
    blob,
    viewportWidth,
    viewportHeight,
    scrollX,
    scrollY,
    pixelRatio,
    route: `${view.location.pathname}${view.location.search}`,
    frontendVersion: options.appVersion ?? "unknown",
    capturedAt: new Date().toISOString(),
    elapsedMs
  };
}

function includeNode(node: unknown, extra?: (node: Element) => boolean): boolean {
  if (!isElement(node)) return true;
  if (node.hasAttribute(captureExcludeAttribute)) return false;
  return extra ? extra(node) : true;
}

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && (node as Node).nodeType === 1;
}

export function findUnreadableMapCanvases(
  root: ParentNode,
  selector: string = maplibreCanvasSelector
): HTMLCanvasElement[] {
  return Array.from(root.querySelectorAll<HTMLCanvasElement>(selector)).filter(
    (canvas) => preservesDrawingBuffer(canvas) === false
  );
}

function preservesDrawingBuffer(canvas: HTMLCanvasElement): boolean | null {
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!context) return null;
  return context.getContextAttributes()?.preserveDrawingBuffer === true;
}
