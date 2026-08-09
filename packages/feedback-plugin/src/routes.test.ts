import { describe, expect, it } from "vitest";
import { defineFeedbackRoutes, feedbackRouteMatches, matchFeedbackRoute } from "./routes";

const routes = defineFeedbackRoutes([
  { pageId: "zones.list", path: "/zones", label: "区域一覧" },
  { pageId: "zones.new", path: "/zones/new", label: "区域作成" },
  { pageId: "zones.detail", path: "/zones/{id}", label: "区域詳細" }
] as const);

describe("feedback routes", () => {
  it("実データのIDを列挙せずルートテンプレートへ解決する", () => {
    expect(matchFeedbackRoute(routes, "/zones/Z-2?tab=history")?.pageId).toBe("zones.detail");
    expect(feedbackRouteMatches("/zones/{id}", "/zones/Z-2")).toBe(true);
    expect(feedbackRouteMatches("/zones/{id}", "/zones/Z-2/history")).toBe(false);
  });

  it("静的ルートをパラメータ付きルートより優先する", () => {
    expect(matchFeedbackRoute(routes, "/zones/new")?.pageId).toBe("zones.new");
  });

  it("重複と不正なテンプレートを拒否する", () => {
    expect(() => defineFeedbackRoutes([
      { pageId: "same", path: "/a", label: "A" },
      { pageId: "same", path: "/b", label: "B" }
    ])).toThrow("pageIdが重複");
    expect(() => defineFeedbackRoutes([
      { pageId: "bad", path: "/zones/prefix-{id}", label: "不正" }
    ])).toThrow("{name}形式");
  });
});
