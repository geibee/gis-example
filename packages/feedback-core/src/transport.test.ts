import { describe, expect, it, vi } from "vitest";
import { createFeedbackTransport, FeedbackCompatibilityError, FeedbackTransportError } from "./transport";

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
        evidence: { maxBytes: 1, maxCountPerWorkspace: 1, acceptedContentTypes: ["image/png"] },
        features: []
      })
    });
    await expect(transport.getCapabilities()).rejects.toBeInstanceOf(FeedbackCompatibilityError);
  });

  it.each([403, 404, 409, 412, 413, 429, 500])("HTTP %iをProblem Details付きで保持する", async (status) => {
    const transport = createFeedbackTransport({
      baseUrl: "/feedback/v1",
      getAccessToken: async () => "token",
      fetch: async () => jsonResponse({
        type: `/problems/status-${status}`,
        title: "Error",
        status,
        code: `status.${status}`,
        requestId: "request-1"
      }, status)
    });
    const error = await transport.request("/resource").catch((caught) => caught);
    expect(error).toBeInstanceOf(FeedbackTransportError);
    expect(error).toMatchObject({ status, problem: { code: `status.${status}` } });
  });

  it("Idempotency-KeyとIf-Matchを送りbinary証跡を読む", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const transport = createFeedbackTransport({
      baseUrl: "/feedback/v1",
      getAccessToken: async () => "token",
      fetch: async (url, init) => {
        calls.push({ url, headers: init?.headers });
        if (url.endsWith("/evidence")) {
          return {
            ...jsonResponse(null),
          headers: { get: (name: string) => ({
            "content-type": "image/png",
            "content-range": "bytes 0-2/3"
          })[name.toLowerCase()] ?? null },
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
          };
        }
        return jsonResponse({ id: "resource" });
      }
    });
    await transport.request("/resource", {
      method: "PATCH",
      body: { value: 1 },
      idempotencyKey: "idempotency-00001",
      ifMatch: '"2"'
    });
    const binary = await transport.requestBinary("/threads/t1/evidence", { range: "bytes=0-2" });
    expect(calls[0].headers).toMatchObject({
      "Content-Type": "application/merge-patch+json",
      "Idempotency-Key": "idempotency-00001",
      "If-Match": '"2"'
    });
    expect([...binary.bytes]).toEqual([1, 2, 3]);
    expect(binary.contentType).toBe("image/png");
    expect(binary.contentRange).toBe("bytes 0-2/3");
    expect(calls[1].headers).toMatchObject({ Range: "bytes=0-2" });
  });
});
