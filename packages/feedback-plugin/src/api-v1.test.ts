import { describe, expect, it, vi } from "vitest";
import { createFeedbackV1ApiClient } from "./api-v1";

const capabilities = {
  apiVersion: "1.0",
  apiMajorVersion: 1,
  manifestSchemaVersions: ["1"],
  targetSchemaVersions: ["1"],
  evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
  features: []
};

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "web-gis",
  environmentKey: "local",
  externalWorkspaceKey: "project-1",
  manifestVersion: "1",
  title: "レビュー",
  description: null,
  status: "open",
  outOfScopePosting: "warn",
  startAt: null,
  endAt: null,
  scopes: [{ pageKey: "lands.detail", routeTemplate: "/lands/{id}", reviewable: true }],
  perspectives: [{ code: "usability", label: "使いやすさ", status: "active", guidance: null }],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

function thread(status: "open" | "resolved" = "open") {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    sessionId: session.id,
    displayNumber: 1,
    location: {
      schemaVersion: "1",
      pageKey: "lands.detail",
      routeTemplate: "/lands/{id}",
      pathParameters: { id: "L-1" },
      queryParameters: {}
    },
    target: {
      schemaVersion: "1",
      kind: "ui-element",
      elementKey: "land.save",
      relativeX: 0.5,
      relativeY: 0.25
    },
    perspectiveCode: "usability",
    status,
    reporter: { principalId: "user-1", displayName: "利用者", participantName: "山田" },
    evidenceAvailable: true,
    messages: [{
      id: "30000000-0000-4000-8000-000000000001",
      threadId: "20000000-0000-4000-8000-000000000001",
      author: { principalId: "user-1", displayName: "利用者", participantName: "山田" },
      body: "確認してください",
      createdAt: "2026-08-09T00:00:00Z",
      editedAt: null,
      version: 1
    }],
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    version: status === "open" ? 1 : 2
  };
}

describe("Feedback API v1 互換adapter", () => {
  it("sessionとthreadを旧UIの型へ変換する", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/capabilities")) return Response.json(capabilities);
      if (url.includes("/sessions?")) return Response.json({ items: [session], nextCursor: null, totalCount: 1 });
      if (url.endsWith(`/sessions/${session.id}/threads`)) {
        return Response.json({ items: [thread()], nextCursor: null, totalCount: 1 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createFeedbackV1ApiClient({
      apiBaseUrl: "/feedback/v1",
      applicationKey: "web-gis",
      environmentKey: "local",
      routes: [{ pageId: "lands.detail", path: "/lands/{id}", label: "土地詳細" }],
      getAccessToken: () => "token",
      fetch
    });

    const sessions = await client.getReviewSessions("project-1", "open");
    const threads = await client.getFeedbackThreads(session.id);

    expect(sessions[0]).toMatchObject({ projectId: "project-1", status: "open" });
    expect(sessions[0].perspectives[0]).toMatchObject({ label: "使いやすさ", status: "ACTIVE" });
    expect(threads[0]).toMatchObject({
      projectId: "project-1",
      pageRoute: "/lands/L-1",
      perspectiveLabel: "使いやすさ",
      targetType: "UI_ELEMENT",
      status: "OPEN"
    });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/capabilities"))).toHaveLength(1);
  });

  it("投稿をv1 location target evidenceへ変換しETagでstatusを更新する", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/capabilities")) return Response.json(capabilities);
      if (url.includes("/sessions?")) return Response.json({ items: [session] });
      if (url.endsWith(`/sessions/${session.id}/threads`)) {
        return Response.json(thread(), { status: 201 });
      }
      if (url.endsWith(`/threads/${thread().id}/status`)) {
        return Response.json(thread("resolved"), { headers: { ETag: '"2"' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = createFeedbackV1ApiClient({
      apiBaseUrl: "/feedback/v1",
      applicationKey: "web-gis",
      environmentKey: "local",
      routes: [{ pageId: "lands.detail", path: "/lands/{id}", label: "土地詳細" }],
      getAccessToken: () => "token",
      createIdempotencyKey: () => "idempotency-00001",
      fetch
    });
    await client.getReviewSessions("project-1", "open");

    const created = await client.createFeedbackThread(
      session.id,
      {
        perspectiveCode: "usability",
        body: "確認してください",
        participantName: "山田",
        targetType: "UI_ELEMENT",
        target: { type: "UI_ELEMENT", feedbackTargetId: "land.save", relativeX: 0.5, relativeY: 0.25 },
        pageId: "lands.detail",
        route: "/lands/L-1?projectId=project-1",
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        pixelRatio: 1,
        frontendVersion: "test",
        capturedAt: "2026-08-09T00:00:00Z"
      },
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    );
    const updated = await client.updateFeedbackThreadStatus(created.id, { status: "RESOLVED" });

    const createRequest = requests.find(({ url }) => url.endsWith(`/sessions/${session.id}/threads`));
    const createBody = JSON.parse(String(createRequest?.init?.body));
    expect(createBody.location).toEqual({
      schemaVersion: "1",
      pageKey: "lands.detail",
      routeTemplate: "/lands/{id}",
      pathParameters: { id: "L-1" },
      queryParameters: {}
    });
    expect(createBody.target).toMatchObject({ kind: "ui-element", elementKey: "land.save" });
    expect(createBody.evidence).toMatchObject({ contentType: "image/png", dataBase64: "AQID" });
    expect(new Headers(createRequest?.init?.headers).get("Idempotency-Key")).toBe("idempotency-00001");
    const statusRequest = requests.find(({ url }) => url.endsWith(`/threads/${thread().id}/status`));
    expect(new Headers(statusRequest?.init?.headers).get("If-Match")).toBe('"v1"');
    expect(updated.status).toBe("RESOLVED");
  });
});
