import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemo, useRef } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { FeedbackOverlay, FeedbackProvider } from "@feedback/react";
import type { FeedbackHostAdapter, FeedbackTransport } from "@feedback/core";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "clean-fixture",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1",
  manifestVersion: "1",
  title: "Clean fixture",
  description: null,
  status: "open" as const,
  outOfScopePosting: "warn" as const,
  startAt: null,
  endAt: null,
  scopes: [{ pageKey: "orders.detail", routeTemplate: "/orders/{id}", reviewable: true }],
  perspectives: [{ code: "quality", label: "品質", status: "active" as const, guidance: null }],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const thread = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: session.id,
  displayNumber: 7,
  location: {
    schemaVersion: "1" as const,
    pageKey: "orders.detail",
    routeTemplate: "/orders/{id}",
    pathParameters: { id: "O-7" }
  },
  target: {
    schemaVersion: "1" as const,
    kind: "ui-element" as const,
    elementKey: "order-card",
    relativeX: 0.5,
    relativeY: 0.5
  },
  perspectiveCode: "quality",
  status: "open" as const,
  reporter: { principalId: "fixture-user", displayName: "Fixture", participantName: null },
  evidenceAvailable: false,
  messages: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

afterEach(() => cleanup());

describe("packed Feedback SDK", () => {
  it("routerから独立したadapterで投稿とDOM pinを処理する", async () => {
    const posted = vi.fn();
    render(<MemoryRouter initialEntries={["/orders/O-7"]}><Fixture posted={posted} /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "#7" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "packed package post" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(posted).toHaveBeenCalledOnce());
  });

  it("router navigationの完了後にdeep link drawerを開く", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Fixture posted={vi.fn()} deepLinkThreadId={thread.id} />
      </MemoryRouter>
    );
    expect(await screen.findByText("/orders/O-7?feedbackThread=20000000-0000-4000-8000-000000000001")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /#7/ })).toBeTruthy();
  });
});

function Fixture({ posted, deepLinkThreadId }: { posted: () => void; deepLinkThreadId?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const adapter = useMemo<FeedbackHostAdapter>(() => ({
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "clean-fixture",
      environmentKey: "test",
      externalWorkspaceKey: "workspace-1",
      release: "fixture"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-7" }
    }),
    getAccessToken: async () => "fixture-token",
    navigate: async (target, threadId) => {
      navigateRef.current(`/orders/${target.pathParameters.id}?feedbackThread=${threadId}`);
      await Promise.resolve();
    }
  }), []);
  const transport = useMemo(() => createTransport(posted), [posted]);
  return (
    <FeedbackProvider
      adapter={adapter}
      transport={transport}
      features={{ evidenceCapture: false }}
      messages={{ launcher: "Feedback", comment: "Comment", submit: "Post" }}
    >
      <output>{location.pathname}{location.search}</output>
      <article data-feedback-key="order-card">Order</article>
      <FeedbackOverlay deepLinkThreadId={deepLinkThreadId} />
    </FeedbackProvider>
  );
}

function createTransport(posted: () => void): FeedbackTransport {
  return {
    getCapabilities: async () => ({
      apiVersion: "1.0",
      apiMajorVersion: 1,
      manifestSchemaVersions: ["1"],
      targetSchemaVersions: ["1"],
      evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
      features: []
    }),
    getReviewContext: async () => ({
      session,
      scope: "reviewable",
      posting: "allow",
      permissions: ["feedback.read", "feedback.comment", "feedback.manage"],
      participantPolicy: { mode: "authenticated-identity" },
      evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
    }),
    request: async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        posted();
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      throw new Error(`unexpected fixture request: ${path}`);
    },
    requestBinary: async () => { throw new Error("evidenceなし"); }
  } as FeedbackTransport;
}
