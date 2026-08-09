import { QueryClient } from "@tanstack/react-query";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  displayNumber: 1,
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
    participantName: "端末利用者",
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
  memberships: [{ projectId: "p1", role: "editor", permissions: ["review.manage"] }]
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
  window.localStorage.setItem("web-gis.feedback.participant-name", "端末利用者");
  window.localStorage.setItem(
    `web-gis.feedback.review-introduction.${session.projectId}.${session.id}`,
    "dismissed"
  );
});

describe("FeedbackOverlay", () => {
  it("受付中レビューを初回表示し、閉じた後も現在画面の対象状態とともに再表示できる", async () => {
    window.localStorage.removeItem(
      `web-gis.feedback.review-introduction.${session.projectId}.${session.id}`
    );
    const guidedSession: ReviewSession = {
      ...session,
      description: "登録から承認までの流れを確認してください。",
      scopes: [
        {
          id: "scope-1",
          pageId: "host.screen.detail",
          route: "/",
          description: "テスト画面",
          reviewable: true,
          displayOrder: 1
        }
      ]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([guidedSession]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([]);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user, unmount } = renderHost(fetchMock);

    const guide = await screen.findByRole("dialog", { name: "受入レビュー" });
    expect(within(guide).getByText("登録から承認までの流れを確認してください。")).toBeInTheDocument();
    expect(within(guide).getByRole("heading", { name: "今回確認してほしいこと" })).toBeInTheDocument();
    expect(within(guide).getByText("テスト画面")).toBeInTheDocument();
    await user.click(within(guide).getByRole("button", { name: "確認してレビューを始める" }));

    const reopen = screen.getByRole("button", { name: "今回のレビューを確認（この画面は対象）" });
    expect(reopen).toBeInTheDocument();
    await user.click(reopen);
    expect(screen.getByRole("dialog", { name: "受入レビュー" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "レビュー案内を閉じる" }));

    unmount();
    const secondView = renderHost(fetchMock);
    await screen.findByRole("button", { name: "今回のレビューを確認（この画面は対象）" });
    expect(screen.queryByRole("dialog", { name: "受入レビュー" })).not.toBeInTheDocument();

    secondView.unmount();
    const nextSession = { ...guidedSession, id: "session-2", title: "次回レビュー" };
    const nextFetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([nextSession]);
      if (url.endsWith(`/api/review-sessions/${nextSession.id}/threads`)) return response([]);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    renderHost(nextFetchMock);
    expect(await screen.findByRole("dialog", { name: "次回レビュー" })).toBeInTheDocument();
  });

  it("localStorageを利用できなくても現在の画面では案内を閉じた状態を維持する", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([]);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user } = renderHost(fetchMock);

    const guide = await screen.findByRole("dialog", { name: "受入レビュー" });
    await user.click(within(guide).getByRole("button", { name: "確認してレビューを始める" }));
    expect(screen.queryByRole("dialog", { name: "受入レビュー" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /今回のレビューを確認/ })).toBeInTheDocument();
  });

  it.each([
    ["受付中セッションがない", response([])],
    ["セッションAPIが失敗する", response({ error: "temporary failure" }, 503)]
  ])("%s場合は案内と投稿導線を表示しない", async (_label, apiResponse) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return apiResponse;
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    renderHost(fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /今回のレビューを確認/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^フィードバック$/ })).not.toBeInTheDocument();
  });

  it("対象選択、Portal描画、証跡付き投稿をホストから独立して提供する", async () => {
    window.localStorage.removeItem("web-gis.feedback.participant-name");
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
    expect(within(composer).getByRole("button", { name: "投稿する" })).toBeDisabled();
    await user.type(within(composer).getByRole("textbox", { name: "投稿者名" }), "山田 太郎");
    await user.type(within(composer).getByRole("textbox", { name: "コメント" }), "保存後の遷移を確認したい");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(submitted).toMatchObject({
      targetType: "UI_ELEMENT",
      target: { feedbackTargetId: "host.save" },
      pageId: "host.screen.detail",
      participantName: "山田 太郎",
      frontendVersion: "test-version"
    }));
    expect(window.localStorage.getItem("web-gis.feedback.participant-name")).toBe("山田 太郎");
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
    expect(within(composer).getByRole("textbox", { name: "投稿者名" })).toHaveValue("端末利用者");
    await user.type(within(composer).getByRole("textbox", { name: "コメント" }), "画像なしでも残す");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(posted).toBe(true));
    expect(screenshot).toBeNull();
  });

  it("DOMピンから返信と解決を行う", async () => {
    let thread = baseThread;
    let submittedReply: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([thread]);
      if (url.endsWith(`/api/threads/${thread.id}/messages`) && init?.method === "POST") {
        submittedReply = JSON.parse(String(init.body)) as Record<string, unknown>;
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
    expect(submittedReply).toMatchObject({ body: "対応します", participantName: "端末利用者" });
    await user.click(await within(drawer).findByRole("button", { name: "解決済みにする" }));
    expect(await within(drawer).findByText("解決済み")).toBeInTheDocument();
  });

  it("APIの降順一覧でも永続化された表示番号を変えない", async () => {
    const newerThread: FeedbackThread = {
      ...baseThread,
      id: "thread-2",
      displayNumber: 2,
      messages: [{ ...baseThread.messages[0], id: "message-2", threadId: "thread-2", body: "新しいコメント" }]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([newerThread, baseThread]);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    renderHost(fetchMock);

    expect(await screen.findByRole("button", { name: /新しいコメント/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /保存ボタンを確認してください/ })).toHaveTextContent("1");
  });

  it("投稿画面とスレッドをパネル外のクリックで閉じる", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([baseThread]);
      if (url.endsWith(`/api/threads/${baseThread.id}`)) return response(baseThread);
      if (url.endsWith("/api/me")) return response(me);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user } = renderHost(
      fetchMock,
      <>
        <button type="button" data-feedback-id="host.save">保存</button>
        <button type="button">パネルの外側</button>
      </>
    );

    await user.click(await screen.findByRole("button", { name: /保存ボタンを確認してください/ }));
    expect(await screen.findByRole("dialog", { name: "フィードバックスレッド" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パネルの外側" }));
    expect(screen.queryByRole("dialog", { name: "フィードバックスレッド" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^フィードバック$/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("dialog", { name: "フィードバックの投稿" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パネルの外側" }));
    expect(screen.queryByRole("dialog", { name: "フィードバックの投稿" })).not.toBeInTheDocument();
  });

  it("右クリックメニューから対象を保持して投稿画面を開く", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/review-sessions?")) return response([session]);
      if (url.endsWith(`/api/review-sessions/${session.id}/threads`)) return response([]);
      throw new Error(`未定義の要求: ${url}`);
    }) as typeof fetch;
    const { user } = renderHost(fetchMock);
    const target = await screen.findByRole("button", { name: "保存" });
    await screen.findByRole("button", { name: /^フィードバック$/ });
    const contextMenuEvent = createEvent.contextMenu(target, { clientX: 160, clientY: 120 });

    fireEvent(target, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    const menu = screen.getByRole("menu", { name: "フィードバックメニュー" });
    await user.click(within(menu).getByRole("menuitem", { name: "フィードバックを残す" }));
    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByText(/host\.save/)).toBeInTheDocument();
  });
});

function ThreadLink() {
  const { openThread } = useFeedbackPlugin();
  return <button type="button" onClick={() => openThread("thread-1")}>ディープリンクを開く</button>;
}
