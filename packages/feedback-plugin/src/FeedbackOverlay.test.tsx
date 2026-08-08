import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackThread, Me, ReviewSession } from "./contracts";
import { FeedbackOverlay } from "./FeedbackOverlay";
import { FeedbackPluginProvider } from "./plugin-context";
import { useFeedbackPlugin } from "./state";

const toBlob = vi.hoisted(() => vi.fn());
vi.mock("html-to-image", () => ({ toBlob }));

const session: ReviewSession = {
  id: "session-1",
  projectId: "p1",
  title: "受入レビュー",
  status: "open",
  evidenceRetentionDays: null,
  effectiveEvidenceRetentionDays: 90,
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  perspectives: [
    { code: "FLOW", label: "業務フロー", displayOrder: 1, status: "ACTIVE" },
    { code: "FUTURE", label: "将来観点", displayOrder: 2, status: "FUTURE" }
  ],
  scopes: []
};

const baseThread: FeedbackThread = {
  id: "thread-1",
  projectId: "p1",
  reviewSessionId: session.id,
  perspectiveCode: "FLOW",
  perspectiveLabel: "業務フロー",
  targetType: "UI_ELEMENT",
  targetMetadata: { type: "UI_ELEMENT", feedbackTargetId: "host.save", relativeX: 0.5, relativeY: 0.5 },
  status: "OPEN",
  createdAt: "2026-08-08T01:00:00Z",
  updatedAt: "2026-08-08T01:00:00Z",
  messages: [{
    id: "message-1",
    threadId: "thread-1",
    authorId: "u1",
    authorName: "利用者",
    body: "保存ボタンを確認してください",
    createdAt: "2026-08-08T01:00:00Z",
    editedAt: null
  }]
};

const me: Me = {
  userId: "u1",
  subject: "oidc-u1",
  email: "user@example.test",
  displayName: "利用者",
  systemRole: "user",
  memberships: [{ projectId: "p1", role: "editor" }]
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function renderHost(fetchMock: typeof fetch, children?: ReactNode) {
  vi.stubGlobal("fetch", fetchMock);
  const notifications = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <FeedbackPluginProvider
      apiBaseUrl="https://feedback.example.test"
      projectId="p1"
      appVersion="test-version"
      routes={[{ pageId: "host.screen.detail", path: "/", label: "テスト画面" }]}
      currentPath="/"
      getAccessToken={() => "token"}
      onNotification={notifications}
      queryClient={queryClient}
    >
      {children ?? <button type="button" data-feedback-id="host.save">保存</button>}
      <FeedbackOverlay />
    </FeedbackPluginProvider>
  );
  return { ...result, notifications, queryClient, user: userEvent.setup() };
}

beforeEach(() => {
  toBlob.mockReset();
  toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1024, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 768, configurable: true });
});

describe("FeedbackOverlay", () => {
  it("対象選択、Portal描画、証跡付き投稿をホストから独立して提供する", async () => {
    let submitted: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?") && init?.method !== "POST") return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`) && !init?.method) return response([]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`) && init?.method === "POST") {
        const metadata = (init.body as FormData).get("metadata");
        submitted = JSON.parse(String(metadata)) as Record<string, unknown>;
        return response(baseThread, 201);
      }
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user, notifications } = renderHost(fetchMock);

    await user.click(await screen.findByRole("button", { name: /フィードバック/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(composer.parentElement).toHaveAttribute("data-review-exclude");
    expect(within(composer).queryByRole("radio", { name: "将来観点" })).not.toBeInTheDocument();
    await user.type(within(composer).getByRole("textbox"), "保存後の遷移を確認したい");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(submitted).toMatchObject({
      targetType: "UI_ELEMENT",
      target: { feedbackTargetId: "host.save" },
      pageId: "host.screen.detail",
      frontendVersion: "test-version"
    }));
    expect(notifications).toHaveBeenCalledWith({ type: "success", message: "フィードバックを投稿しました" });
  });

  it("画面キャプチャ失敗時もコメントだけ投稿できる", async () => {
    toBlob.mockRejectedValue(new Error("tainted canvas"));
    let screenshot: FormDataEntryValue | null = null;
    let posted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/threads`) && !init?.method) return response([]);
      if (url.endsWith(`/threads`) && init?.method === "POST") {
        posted = true;
        screenshot = (init.body as FormData).get("screenshot");
        return response(baseThread, 201);
      }
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user } = renderHost(fetchMock);

    await user.click(await screen.findByRole("button", { name: /フィードバック/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByRole("alert")).toHaveTextContent("証跡の取得に失敗しました");
    await user.type(within(composer).getByRole("textbox"), "画像なしでも残す");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(posted).toBe(true));
    expect(screenshot).toBeNull();
  });

  it("DOMピンから返信と解決を行う", async () => {
    let thread = baseThread;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([thread]);
      if (url.endsWith(`/api/threads/${thread.id}/messages`) && init?.method === "POST") {
        const message = { ...thread.messages[0], id: "message-2", body: "対応します" };
        thread = { ...thread, messages: [...thread.messages, message] };
        return response(message, 201);
      }
      if (url.endsWith(`/api/threads/${thread.id}/status`) && init?.method === "PATCH") {
        thread = { ...thread, status: "RESOLVED" };
        return response(thread);
      }
      if (url.endsWith(`/api/threads/${thread.id}`)) return response(thread);
      if (url.endsWith("/api/me")) return response(me);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user } = renderHost(fetchMock, <><button type="button" data-feedback-id="host.save">保存</button><ThreadLink /></>);

    const pin = await screen.findByRole("button", { name: /保存ボタンを確認してください/ });
    expect(pin).toBeInTheDocument();
    await user.click(pin);
    const drawer = await screen.findByRole("dialog", { name: "フィードバックスレッド" });
    await user.type(within(drawer).getByRole("textbox", { name: "返信" }), "対応します");
    await user.click(within(drawer).getByRole("button", { name: "返信する" }));
    expect(await within(drawer).findByText("対応します")).toBeInTheDocument();
    await user.click(await within(drawer).findByRole("button", { name: "解決済みにする" }));
    expect(await within(drawer).findByText("解決済み")).toBeInTheDocument();
  });
});

function ThreadLink() {
  const { openThread } = useFeedbackPlugin();
  return <button type="button" onClick={() => openThread("thread-1")}>ディープリンクを開く</button>;
}
