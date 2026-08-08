import { describe, expect, it } from "vitest";
import type { FeedbackThread } from "./contracts";
import { feedbackThreadMatchesPath } from "./thread-route";

const thread = {
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
