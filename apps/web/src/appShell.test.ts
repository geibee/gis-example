import { describe, expect, it } from "vitest";
import { nextPaneMode } from "./appShell";

describe("nextPaneMode", () => {
  it("分割表示から指定したペインを隠す", () => {
    expect(nextPaneMode("split", "business")).toBe("map");
    expect(nextPaneMode("split", "map")).toBe("business");
  });

  it("最後のペインを隠すと反対側へ切り替える", () => {
    expect(nextPaneMode("business", "business")).toBe("map");
    expect(nextPaneMode("map", "map")).toBe("business");
  });

  it("非表示のペインを表示すると分割表示へ戻す", () => {
    expect(nextPaneMode("map", "business")).toBe("split");
    expect(nextPaneMode("business", "map")).toBe("split");
  });
});
