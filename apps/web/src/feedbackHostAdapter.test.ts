import { describe, expect, it, vi } from "vitest";
import { feedbackApplicationManifest } from "./appRoutes";
import {
  buildWebGisFeedbackPath,
  createWebGisFeedbackHostAdapter,
  resolveWebGisFeedbackThread
} from "./feedbackHostAdapter";

describe("Web GIS FeedbackHostAdapter", () => {
  it("画面manifestをWeb GIS APIから独立したapplication契約として公開する", () => {
    expect(feedbackApplicationManifest.applicationKey).toBe("web-gis");
    expect(feedbackApplicationManifest.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageKey: "lands.detail", template: "/lands/{id}" })
    ]));
  });

  it("現在URLから生queryを捨て、manifest登録済みlocationを返す", () => {
    const adapter = createWebGisFeedbackHostAdapter({
      environmentKey: "test",
      release: "test-release",
      getWorkspaceKey: () => "project-1",
      getPathname: () => "/lands/L-1",
      getSearch: () => "?token=secret&email=user@example.com",
      getAccessToken: () => "token",
      navigate: vi.fn()
    });

    expect(adapter.getContext()).toMatchObject({
      applicationKey: "web-gis",
      environmentKey: "test",
      externalWorkspaceKey: "project-1"
    });
    expect(adapter.getLocation()).toEqual({
      schemaVersion: "1",
      pageKey: "lands.detail",
      routeTemplate: "/lands/{id}",
      pathParameters: { id: "L-1" }
    });
  });

  it("locationとthreadから同一origin向け相対deep linkを再構築する", () => {
    expect(buildWebGisFeedbackPath({
      schemaVersion: "1",
      pageKey: "lands.detail",
      routeTemplate: "/lands/{id}",
      pathParameters: { id: "L 1" },
      queryParameters: { tab: "owner" }
    }, "project-1", "thread-1")).toBe(
      "/lands/L%201?tab=owner&projectId=project-1&feedbackThread=thread-1"
    );
  });

  it("Feedback Serviceのpermalinkからthread parameterを受ける", () => {
    expect(resolveWebGisFeedbackThread({ feedbackThread: "new-thread", threadId: "old-thread" }))
      .toBe("new-thread");
    expect(resolveWebGisFeedbackThread({ threadId: "old-thread" })).toBeNull();
    expect(resolveWebGisFeedbackThread({ feedbackThread: " ".repeat(201) })).toBeNull();
  });
});
