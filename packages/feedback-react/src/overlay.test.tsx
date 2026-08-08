import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryFeedbackTelemetry, type FeedbackHostAdapter, type FeedbackTransport } from "@feedback/core";
import { FeedbackOverlay, createLocalStorageParticipantAdapter, feedbackThreadMatchesLocation } from "./overlay";
import { FeedbackProvider } from "./index";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1",
  manifestVersion: "1",
  title: "テストレビュー",
  description: null,
  status: "open" as const,
  outOfScopePosting: "warn" as const,
  startAt: null,
  endAt: null,
  scopes: [{ pageKey: "orders.detail", routeTemplate: "/orders/{id}", reviewable: true }],
  perspectives: [{ code: "usability", label: "使いやすさ", status: "active" as const, guidance: null }],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const thread = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: session.id,
  displayNumber: 1,
  location: {
    schemaVersion: "1" as const,
    pageKey: "orders.detail",
    routeTemplate: "/orders/{id}",
    pathParameters: { id: "O-1" }
  },
  target: { schemaVersion: "1" as const, kind: "screen-position" as const, relativeX: 0.5, relativeY: 0.5 },
  perspectiveCode: "usability",
  status: "open" as const,
  reporter: { principalId: "user-1", displayName: "利用者", participantName: null },
  evidenceAvailable: false,
  messages: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
});

afterEach(() => cleanup());

describe("FeedbackOverlay", () => {
  it("別locationの同じDOM keyへpinを混在させない", () => {
    expect(feedbackThreadMatchesLocation(thread, {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-1" }
    })).toBe(true);
    expect(feedbackThreadMatchesLocation(thread, {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-2" }
    })).toBe(false);
  });

  it("capture失敗時もコメントだけを投稿する", async () => {
    const posted: unknown[] = [];
    const adapter = createAdapter({ captureEvidence: vi.fn(async () => { throw new Error("capture blocked"); }) });
    const telemetry = createInMemoryFeedbackTelemetry();
    const transport = createTransport(async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        posted.push(options.body);
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={adapter} transport={transport} telemetry={telemetry}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ body: "確認してください" });
    expect(posted[0]).not.toHaveProperty("evidence");
    expect(telemetry.snapshot()).toMatchObject({ capture_failure: 1, post_success: 1 });
  });

  it("不確実な送信失敗の再試行で同じIdempotency-Keyとbodyを再利用する", async () => {
    const attempts: Array<{ key?: string; body?: unknown }> = [];
    const transport = createTransport(async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        attempts.push({ key: options.idempotencyKey, body: options.body });
        if (attempts.length === 1) throw new Error("response lost");
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport} features={{ evidenceCapture: false }}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "再試行" } });
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(attempts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("deep link navigation完了後にthread drawerを開く", async () => {
    let finishNavigation: (() => void) | undefined;
    const navigate = vi.fn(() => new Promise<void>((resolve) => { finishNavigation = resolve; }));
    const adapter = createAdapter({ navigate });
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={adapter} transport={transport}>
        <FeedbackOverlay deepLinkThreadId={thread.id} />
      </FeedbackProvider>
    );

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: /#1/ })).toBeNull();
    finishNavigation?.();
    expect(await screen.findByRole("heading", { name: /#1/ })).toBeTruthy();
  });

  it("localStorageを利用できなくてもidentity adapterは失敗しない", () => {
    const storage = {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
      removeItem: () => { throw new Error("disabled"); }
    };
    const adapter = createLocalStorageParticipantAdapter(storage);
    expect(adapter.getParticipantName()).toBeNull();
    expect(() => adapter.setParticipantName("利用者")).not.toThrow();
  });

  it("posting denyでは投稿導線を閉じ、既存threadの閲覧を維持する", async () => {
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      throw new Error(`unexpected: ${path}`);
    }, { posting: "deny" });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    expect((await screen.findByRole("status")).textContent).toContain("投稿できません");
    expect(screen.queryByRole("button", { name: "フィードバック" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "#1" }));
    expect(await screen.findByRole("heading", { name: /#1/ })).toBeTruthy();
  });

  it.each([
    ["authenticated-identity", false],
    ["prompt", true],
    ["authenticated-and-prompt", true]
  ] as const)("participant policy %s のpromptを適用する", async (mode, expected) => {
    const participantPolicy = mode === "authenticated-identity"
      ? { mode }
      : { mode, storage: "memory" as const };
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    }, { participantPolicy });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    expect(screen.queryByLabelText("投稿者名") !== null).toBe(expected);
  });

  it("locale差し替えとShadowRoot portalをhost CSSから分離して利用できる", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider
        adapter={createAdapter()}
        transport={transport}
        portalTarget={shadow}
        messages={{ launcher: "Send feedback" }}
      >
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    await waitFor(() => expect(shadow.querySelector("button")?.textContent).toBe("Send feedback"));
    host.remove();
  });
});

function createAdapter(overrides: Partial<FeedbackHostAdapter> = {}): FeedbackHostAdapter {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "consumer",
      environmentKey: "test",
      externalWorkspaceKey: "workspace-1",
      release: "test"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-1" }
    }),
    getAccessToken: async () => "token",
    navigate: () => undefined,
    ...overrides
  };
}

function createTransport(
  request: (path: string, options?: Parameters<FeedbackTransport["request"]>[1]) => Promise<{
    value: unknown;
    etag: string | null;
  }>,
  contextOverrides: Record<string, unknown> = {}
): FeedbackTransport {
  return {
    request: request as FeedbackTransport["request"],
    requestBinary: vi.fn(),
    getCapabilities: vi.fn(async () => ({
      apiVersion: "1.0",
      apiMajorVersion: 1,
      manifestSchemaVersions: ["1"],
      targetSchemaVersions: ["1"],
      evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
      features: []
    })),
    getReviewContext: vi.fn(async () => ({
      session,
      scope: "reviewable",
      posting: "allow",
      permissions: ["feedback.read", "feedback.comment", "feedback.manage"],
      participantPolicy: { mode: "authenticated-identity" },
      evidencePolicy: { enabled: true, maxBytes: 1024, acceptedContentTypes: ["image/png"] },
      ...contextOverrides
    }))
  } as unknown as FeedbackTransport;
}
