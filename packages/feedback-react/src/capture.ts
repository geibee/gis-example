import { toBlob } from "html-to-image";
import type { FeedbackEvidenceProvider } from "@feedback/core";

export type DomEvidenceProviderOptions = {
  root?: () => HTMLElement;
  maxPixelRatio?: number;
  maxBytes?: number;
  /** テストやhost固有renderer用。未指定時はhtml-to-imageを使う。 */
  render?: (root: HTMLElement, options: DomCaptureRenderOptions) => Promise<Blob | null>;
};

export type DomCaptureRenderOptions = {
  pixelRatio: number;
  filter(node: Node): boolean;
};

/** exclude/mask を尊重する既定 DOM capture。mask は外部CSSの一時classで画素へ焼き込む。 */
export function createDomEvidenceProvider(options: DomEvidenceProviderOptions = {}): FeedbackEvidenceProvider {
  return async (request) => {
    if (typeof document === "undefined") return null;
    const root = options.root?.() ?? document.body;
    const maskedElements = installMasks(root, request.maskSelector);
    try {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2);
      const blob = await (options.render ?? toBlob)(root, {
        pixelRatio,
        filter: (node) => !(node instanceof Element) || !node.matches(request.excludeSelector)
      });
      if (!blob) return null;
      if (blob.size > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error("取得した証跡が許可サイズを超えています");
      }
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        contentType: "image/png",
        viewportWidth: document.documentElement.clientWidth || window.innerWidth,
        viewportHeight: document.documentElement.clientHeight || window.innerHeight,
        pixelRatio,
        capturedAt: new Date().toISOString()
      };
    } finally {
      maskedElements.forEach((element) => element.classList.remove("feedback-mask-active"));
    }
  };
}

function installMasks(root: HTMLElement, selector: string): HTMLElement[] {
  if (!selector.trim()) return [];
  const elements = Array.from(root.querySelectorAll<HTMLElement>(selector));
  elements.forEach((element) => element.classList.add("feedback-mask-active"));
  return elements;
}
