import { describe, expect, it, vi } from "vitest";
import {
  createFeedbackRedmineHostAdapter,
  loadFeedbackHostContext,
  locationFromPathname,
  resourceRefFromPathname
} from "./feedbackRedmine";

const context = {
  schemaVersion: "1" as const,
  applicationKey: "gis-example",
  environmentKey: "local",
  externalWorkspaceKey: "local-review",
  release: "test",
  locale: "ja-JP"
};

describe("Feedback Redmine SPA結合", () => {
  it("一覧と詳細URLを公開location/resource契約へ変換する", () => {
    expect(locationFromPathname("/lands")).toEqual({
      schemaVersion: "1",
      pageKey: "lands",
      routeTemplate: "/lands",
      pathParameters: {},
      queryParameters: {}
    });
    expect(locationFromPathname("/lands/L-0001")).toMatchObject({
      pageKey: "lands.detail",
      routeTemplate: "/lands/{id}",
      pathParameters: { id: "L-0001" }
    });
    expect(resourceRefFromPathname("/lands/L-0001")).toEqual({
      schemaVersion: "1",
      kind: "record",
      key: "lands.detail:L-0001"
    });
  });

  it("router購読と保存locationへの遷移だけをadapterへ公開する", async () => {
    const navigate = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const adapter = createFeedbackRedmineHostAdapter(context, {
      pathname: () => "/zones/Z-1",
      navigate,
      subscribe
    });
    expect(adapter.getContext()).toBe(context);
    expect(adapter.getResourceRef()).toMatchObject({ kind: "record", key: "zones.detail:Z-1" });
    const listener = vi.fn();
    expect(adapter.subscribe?.(listener)).toBe(unsubscribe);
    await adapter.navigate(adapter.getLocation()!, "thread-id");
    expect(navigate).toHaveBeenCalledWith("/zones/Z-1");
  });

  it("公開してよいhost contextだけを環境変数から構成する", () => {
    expect(() => loadFeedbackHostContext({})).toThrow(/APPLICATION_KEY/u);
    expect(loadFeedbackHostContext({
      VITE_FEEDBACK_REDMINE_APPLICATION_KEY: "gis-example",
      VITE_FEEDBACK_REDMINE_ENVIRONMENT_KEY: "local",
      VITE_FEEDBACK_REDMINE_WORKSPACE_KEY: "local-review",
      VITE_FEEDBACK_HOST_RELEASE: "test"
    })).toEqual(context);
  });
});
