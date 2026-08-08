import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackTransport } from "@feedback/core";
import { FeedbackAdminConsole } from "./index";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1",
  manifestVersion: "1",
  title: "レビュー1",
  description: null,
  status: "open",
  outOfScopePosting: "warn",
  startAt: null,
  endAt: null,
  scopes: [],
  perspectives: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const thread = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: session.id,
  displayNumber: 1,
  location: { schemaVersion: "1", pageKey: "home", routeTemplate: "/", pathParameters: {} },
  target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
  perspectiveCode: "quality",
  status: "open",
  reporter: { principalId: "user-1" },
  evidenceAvailable: false,
  messages: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

afterEach(() => cleanup());

describe("FeedbackAdminConsole", () => {
  it("Web GISなしでsession/thread/deep linkを管理する", async () => {
    const openExternal = vi.fn();
    render(<FeedbackAdminConsole {...scope} transport={createTransport()} openExternal={openExternal} />);
    expect(await screen.findByText("#1 quality")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "対象アプリを開く" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://consumer.example/?feedbackThread=thread-1"));
  });

  it("manifest・retention/export・membership・deliveryを独立tabで取得する", async () => {
    const request = vi.fn(createRequest());
    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 quality");
    for (const tab of ["Manifest", "保存・Export", "メンバー", "通知"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      await waitFor(() => expect(request.mock.calls.some(([path]) => String(path).includes(expectedPath(tab)))).toBe(true));
    }
  });
});

const scope = {
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1"
};

function expectedPath(tab: string): string {
  return ({ Manifest: "/manifest", "保存・Export": "/retention-policy", メンバー: "/memberships", 通知: "/notification-settings" })[tab] ?? "";
}

function createTransport(request = vi.fn(createRequest())): FeedbackTransport {
  return {
    request: request as FeedbackTransport["request"],
    requestBinary: vi.fn(),
    getCapabilities: vi.fn(),
    getReviewContext: vi.fn()
  };
}

function createRequest() {
  return async (path: string) => {
    if (path.startsWith("/sessions?")) return { value: { items: [session] }, etag: null };
    if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
    if (path.endsWith("/deep-link")) return { value: { url: "https://consumer.example/?feedbackThread=thread-1" }, etag: null };
    if (path.includes("/manifest")) return { value: { schemaVersion: "1", applicationKey: "consumer", displayName: "Consumer", manifestVersion: "1", routes: [] }, etag: '"v1"' };
    if (path.startsWith("/retention-policy")) return { value: { evidenceRetentionDays: null, exportRetentionDays: 7 }, etag: '"v1"' };
    if (path.startsWith("/memberships")) return { value: [], etag: null };
    if (path.startsWith("/notification-settings")) return { value: { webhookEnabled: false, webhookEndpoint: null, includeBody: false, includeEvidence: false }, etag: '"v1"' };
    if (path.startsWith("/notification-deliveries")) return { value: [], etag: null };
    throw new Error(`unexpected: ${path}`);
  };
}
