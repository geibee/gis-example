import { describe, expect, it, vi } from "vitest";
import type { FeedbackApiClient } from "./api";
import { FeedbackApiError } from "./api";
import { createDualReadFeedbackApiClient } from "./api-dual-read";

function client(overrides: Partial<FeedbackApiClient> = {}): FeedbackApiClient {
  return {
    getMe: vi.fn(),
    getReviewSessions: vi.fn(async () => []),
    getFeedbackThreads: vi.fn(async () => []),
    getFeedbackThread: vi.fn(),
    createFeedbackThread: vi.fn(),
    createFeedbackMessage: vi.fn(),
    updateFeedbackMessage: vi.fn(),
    getFeedbackMessageHistory: vi.fn(async () => []),
    updateFeedbackThreadStatus: vi.fn(),
    ...overrides
  };
}

describe("dual-read adapter", () => {
  it("一覧をIDで統合しコピー済みresourceは新APIを正とする", async () => {
    const primary = client({
      getFeedbackThreads: vi.fn(async () => [
        { id: "copied", status: "RESOLVED" },
        { id: "new", status: "OPEN" }
      ] as never)
    });
    const legacy = client({
      getFeedbackThreads: vi.fn(async () => [
        { id: "old", status: "OPEN" },
        { id: "copied", status: "OPEN" }
      ] as never)
    });

    const result = await createDualReadFeedbackApiClient(primary, legacy).getFeedbackThreads("session-1");

    expect(result.map(({ id }) => id)).toEqual(["old", "copied", "new"]);
    expect(result.find(({ id }) => id === "copied")?.status).toBe("RESOLVED");
  });

  it("新APIの404だけを旧APIへfallbackする", async () => {
    const oldThread = { id: "old-thread" } as never;
    const primary = client({
      getFeedbackThread: vi.fn(async () => { throw new FeedbackApiError(404, "not found"); })
    });
    const legacy = client({ getFeedbackThread: vi.fn(async () => oldThread) });

    await expect(createDualReadFeedbackApiClient(primary, legacy).getFeedbackThread("old-thread"))
      .resolves.toBe(oldThread);
  });

  it("新APIの403を旧APIで迂回しない", async () => {
    const primary = client({
      getFeedbackThread: vi.fn(async () => { throw new FeedbackApiError(403, "forbidden"); })
    });
    const legacyRead = vi.fn();
    const legacy = client({ getFeedbackThread: legacyRead });

    await expect(createDualReadFeedbackApiClient(primary, legacy).getFeedbackThread("hidden"))
      .rejects.toMatchObject({ status: 403 });
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it("writeは新APIだけへ送る", async () => {
    const primaryWrite = vi.fn(async () => ({ id: "message-new" }) as never);
    const legacyWrite = vi.fn();
    const primary = client({ createFeedbackMessage: primaryWrite });
    const legacy = client({ createFeedbackMessage: legacyWrite });

    await createDualReadFeedbackApiClient(primary, legacy)
      .createFeedbackMessage("thread-1", { body: "返信" });

    expect(primaryWrite).toHaveBeenCalledOnce();
    expect(legacyWrite).not.toHaveBeenCalled();
  });
});
