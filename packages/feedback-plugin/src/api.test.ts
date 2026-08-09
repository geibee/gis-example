import { describe, expect, it, vi } from "vitest";
import { createFeedbackApiClient, FeedbackApiError } from "./api";

describe("Feedback APIクライアント", () => {
  it("401時にトークンを一度更新して同じ要求を再送する", async () => {
    const seen: string[] = [];
    const requestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
      return seen.length === 1
        ? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        : new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const refresh = vi.fn(async () => "renewed-token");
    const client = createFeedbackApiClient({
      apiBaseUrl: "https://feedback.example.test",
      getAccessToken: () => "expired-token",
      refreshAccessToken: refresh,
      fetch: requestFetch as typeof fetch
    });

    await expect(client.getReviewSessions("p1", "open")).resolves.toEqual([]);
    expect(seen).toEqual(["Bearer expired-token", "Bearer renewed-token"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("更新後も401ならunauthorized通知と型付きエラーを返す", async () => {
    const notify = vi.fn();
    const client = createFeedbackApiClient({
      apiBaseUrl: "",
      getAccessToken: () => "expired",
      refreshAccessToken: async () => "also-expired",
      onNotification: notify,
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch
    });

    await expect(client.getMe()).rejects.toEqual(expect.objectContaining<Partial<FeedbackApiError>>({ status: 401 }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "unauthorized" }));
  });
});
