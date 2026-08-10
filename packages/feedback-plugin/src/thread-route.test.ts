import { describe, expect, it } from "vitest";
import type { FeedbackThread } from "./contracts";
import { feedbackThreadDeepLink, feedbackThreadMatchesPath } from "./thread-route";

const thread = {
  id: "thread-1",
  pageRoute: "/lands/L-1?projectId=p1"
} as FeedbackThread;

describe("feedbackThreadMatchesPath", () => {
  it("同じ詳細IDだけにピンを表示しquery差は無視する", () => {
    expect(feedbackThreadMatchesPath(thread, "/lands/L-1?tab=history")).toBe(true);
    expect(feedbackThreadMatchesPath(thread, "/lands/L-2")).toBe(false);
  });

  it("旧データは証跡URLへフォールバックし、URLなしは読み取り互換で表示する", () => {
    expect(feedbackThreadMatchesPath({ ...thread, pageRoute: null, evidence: { route: "/buildings/B-1" } } as FeedbackThread, "/buildings/B-1")).toBe(true);
    expect(feedbackThreadMatchesPath({ ...thread, pageRoute: null } as FeedbackThread, "/lands/L-9")).toBe(true);
  });
});

describe("feedbackThreadDeepLink", () => {
  it("投稿時のqueryを保ったままprojectとthreadを指定する", () => {
    expect(feedbackThreadDeepLink(thread, "workspace-1")).toBe(
      "/lands/L-1?projectId=workspace-1&feedbackThread=thread-1"
    );
  });

  it("証跡routeをfallbackに利用する", () => {
    expect(feedbackThreadDeepLink({
      ...thread,
      pageRoute: null,
      evidence: { route: "/buildings/B-1?tab=owner" }
    } as FeedbackThread, "workspace-1")).toBe(
      "/buildings/B-1?tab=owner&projectId=workspace-1&feedbackThread=thread-1"
    );
  });

  it("画面情報がない投稿や外部URLにはリンクを作らない", () => {
    expect(feedbackThreadDeepLink({ ...thread, pageRoute: null } as FeedbackThread, "workspace-1")).toBeNull();
    expect(feedbackThreadDeepLink({ ...thread, pageRoute: "https://example.test/lands/L-1" }, "workspace-1")).toBeNull();
  });
});
