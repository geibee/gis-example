import { describe, expect, it, vi } from "vitest";
import { createFeedbackTransport, FeedbackCompatibilityError } from "./transport";

const jsonResponse = (value: unknown, status = 200, etag: string | null = null) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { get: (name: string) => name.toLowerCase() === "etag" ? etag : null },
  json: async () => value
});

describe("FeedbackTransport", () => {
  it("401更新をsingle-flightにし、ETagをresourceと分けて返す", async () => {
    let requests = 0;
    const refresh = vi.fn(async () => "renewed");
    const fetch = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      requests += 1;
      if (init?.headers?.Authorization !== "Bearer renewed") {
        return jsonResponse({ type: "auth", title: "expired", status: 401, code: "auth.expired", requestId: "r1" }, 401);
      }
      return jsonResponse({ apiMajorVersion: 1 }, 200, '"v2"');
    });
    const transport = createFeedbackTransport({
      baseUrl: "https://feedback.example/feedback/v1/",
      getAccessToken: async () => "expired",
      refreshAccessToken: refresh,
      fetch
    });

    const [first, second] = await Promise.all([
      transport.request<{ apiMajorVersion: number }>("/resource"),
      transport.request<{ apiMajorVersion: number }>("/resource")
    ]);
    expect(first.etag).toBe('"v2"');
    expect(second.value.apiMajorVersion).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests).toBe(4);
  });

  it("API major不一致を起動時に検出する", async () => {
    const transport = createFeedbackTransport({
      baseUrl: "https://feedback.example/feedback/v1",
      getAccessToken: async () => null,
      fetch: async () => jsonResponse({
        apiVersion: "2.0",
        apiMajorVersion: 2,
        manifestSchemaVersions: ["1"],
        targetSchemaVersions: ["1"],
        evidence: { maxBytes: 1, acceptedContentTypes: ["image/png"] },
        features: []
      })
    });
    await expect(transport.getCapabilities()).rejects.toBeInstanceOf(FeedbackCompatibilityError);
  });
});
