import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  perspectives: [{ code: "MAP_OPERATION", label: "地図操作", status: "active", guidance: null }],
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
  perspectiveCode: "MAP_OPERATION",
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
    expect(await screen.findByText("#1 地図操作")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const detailRoute = await screen.findByRole("checkbox", { name: /注文詳細.*\/orders\/\{id\}/ });
    fireEvent.click(detailRoute);
    expect((detailRoute as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "対象アプリでスレッドを開く" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const deepLink = new URL(String(openExternal.mock.calls[0][0]));
    expect(deepLink.origin).toBe("https://consumer.example");
    expect(deepLink.searchParams.get("feedbackThread")).toBe(thread.id);
  });

  it("新規レビューをJSON入力なしで設定できる", async () => {
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/sessions") return { value: session, etag: '"v1"' };
      return baseRequest(path, options);
    });
    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "新規作成" }));
    expect(screen.getByRole("dialog", { name: "レビューセッションの作成" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /注文一覧.*\/orders/ })).toBeTruthy();
    fireEvent.change(screen.getAllByRole("combobox", { name: "扱い" })[0], { target: { value: "active" } });
    fireEvent.change(screen.getAllByRole("combobox", { name: "扱い" })[3], { target: { value: "active" } });
    const mapAssignments = screen.getAllByRole("checkbox", { name: "地図操作" });
    expect(mapAssignments).toHaveLength(2);
    fireEvent.click(mapAssignments[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "タイトル" }), { target: { value: "受入レビュー" } });
    expect(screen.queryByText("Scope JSON")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "セッションを作成" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/sessions")).toBe(true));
    const createCall = request.mock.calls.find(([path]) => path === "/sessions");
    expect((createCall?.[1] as { body?: unknown } | undefined)?.body).toMatchObject({
      title: "受入レビュー",
      status: "draft",
      scopes: [
        { pageKey: "orders.list", routeTemplate: "/orders", reviewable: true, perspectiveCodes: ["BUSINESS_FLOW"] },
        { pageKey: "orders.detail", routeTemplate: "/orders/{id}", reviewable: true, perspectiveCodes: ["BUSINESS_FLOW", "MAP_OPERATION"] }
      ],
      perspectives: [
        { code: "BUSINESS_FLOW", label: "業務フロー", status: "active", guidance: null },
        { code: "MAP_OPERATION", label: "地図操作", status: "active", guidance: null }
      ]
    });
  });

  it("メイン画面の開始導線から新規作成ダイアログを直接開く", async () => {
    render(<FeedbackAdminConsole {...scope} initialAction="create-review" transport={createTransport()} />);
    const dialog = await screen.findByRole("dialog", { name: "レビューセッションの作成" });
    expect((within(dialog).getByRole("combobox", { name: "状態" }) as HTMLSelectElement).value).toBe("open");
    expect((within(dialog).getAllByRole("combobox", { name: "扱い" })[0] as HTMLSelectElement).value).toBe("active");
    expect(dialog).toBeTruthy();
  });

  it("manifest・retention/export・membership・deliveryを独立tabで取得する", async () => {
    const request = vi.fn(createRequest());
    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 地図操作");
    for (const tab of ["アプリ設定", "保存・エクスポート", "メンバー", "通知"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      await waitFor(() => expect(request.mock.calls.some(([path]) => String(path).includes(expectedPath(tab)))).toBe(true));
    }
  });

  it("アプリ設定をJSON編集ではなく同期済み画面一覧として表示する", async () => {
    render(<FeedbackAdminConsole {...scope} transport={createTransport()} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "アプリ設定" }));
    expect(await screen.findByText("注文一覧")).toBeTruthy();
    expect(screen.getAllByText("2画面")).toHaveLength(2);
    expect(screen.getByText("メインアプリが持つ画面定義を自動で取り込みます。この画面でJSONを編集する必要はありません。")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Manifest JSON" })).toBeNull();
    expect(screen.queryByRole("button", { name: "アプリ設定を保存" })).toBeNull();
  });
});

const scope = {
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1"
};

function expectedPath(tab: string): string {
  return ({ "アプリ設定": "/manifest", "保存・エクスポート": "/retention-policy", メンバー: "/memberships", 通知: "/connector-types" })[tab] ?? "";
}

function createTransport(request: ReturnType<typeof vi.fn> = vi.fn(createRequest())): FeedbackTransport {
  return {
    request: request as unknown as FeedbackTransport["request"],
    requestBinary: vi.fn(),
    getCapabilities: vi.fn(),
    getReviewContext: vi.fn()
  };
}

function createRequest() {
  return async (path: string, _options?: unknown) => {
    if (path.startsWith("/sessions?")) return { value: { items: [session] }, etag: null };
    if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
    if (path.endsWith("/deep-link")) return { value: { url: "https://consumer.example/?feedbackThread=thread-1" }, etag: null };
    if (path.includes("/manifest")) return { value: {
      schemaVersion: "1", applicationKey: "consumer", displayName: "Consumer", manifestVersion: "1",
      routes: [
        { pageKey: "orders.list", template: "/orders", label: "注文一覧" },
        { pageKey: "orders.detail", template: "/orders/{id}", label: "注文詳細" }
      ]
    }, etag: '"v1"' };
    if (path.startsWith("/retention-policy")) return { value: { evidenceRetentionDays: null, exportRetentionDays: 7 }, etag: '"v1"' };
    if (path.startsWith("/backup-policy")) return { value: { policy: { enabled: false, timezone: "Asia/Tokyo", fullBackupAt: "02:00", incrementalIntervalMinutes: 60, includeEvidence: true, retentionDays: null }, nextExecutionAt: null, nextFullAt: null, nextIncrementalAt: null, lastSuccessfulAt: null, changeCursor: 0, auditCursor: 0 }, etag: '"v1"' };
    if (path.startsWith("/backups")) return { value: { items: [] }, etag: null };
    if (path.startsWith("/memberships")) return { value: [], etag: null };
    if (path.startsWith("/notification-settings")) return { value: { webhookEnabled: false, webhookEndpoint: null, includeBody: false, includeEvidence: false }, etag: '"v1"' };
    if (path.startsWith("/notification-deliveries")) return { value: [], etag: null };
    if (path.startsWith("/connector-types")) return { value: [], etag: null };
    if (path.startsWith("/notification-connectors")) return { value: [], etag: null };
    throw new Error(`unexpected: ${path}`);
  };
}
