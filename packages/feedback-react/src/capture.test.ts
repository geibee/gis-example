import { describe, expect, it } from "vitest";
import { createDomEvidenceProvider } from "./capture";

describe("DOM evidence provider", () => {
  it("maskを外部CSS classで一時適用しexcludeをcapture対象から外す", async () => {
    const root = document.createElement("main");
    const masked = document.createElement("p");
    masked.setAttribute("data-feedback-mask", "");
    const excluded = document.createElement("aside");
    excluded.setAttribute("data-feedback-exclude", "");
    root.append(masked, excluded);
    document.body.appendChild(root);
    let resolveBlob: ((value: Blob) => void) | undefined;
    const render = async (_root: HTMLElement, options: { filter(node: Node): boolean }) => {
      expect(options.filter(excluded)).toBe(false);
      return await new Promise<Blob>((resolve) => { resolveBlob = resolve; });
    };

    const capture = createDomEvidenceProvider({ root: () => root, maxBytes: 10, render });
    const pending = capture({
      context: {
        schemaVersion: "1",
        applicationKey: "consumer",
        environmentKey: "test",
        externalWorkspaceKey: "workspace-1",
        release: "test"
      },
      location: { schemaVersion: "1", pageKey: "orders", routeTemplate: "/orders", pathParameters: {} },
      target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
      excludeSelector: "[data-feedback-exclude]",
      maskSelector: "[data-feedback-mask]"
    });
    expect(masked.classList.contains("feedback-mask-active")).toBe(true);
    resolveBlob?.(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const evidence = await pending;

    expect(evidence?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(masked.classList.contains("feedback-mask-active")).toBe(false);
    root.remove();
  });
});
