import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackThread, ReviewSession } from "../contracts";
import { makeFeedbackThread, makeReviewSession } from "../testing/fixtures";
import { renderWithProviders } from "../testing/renderWithProviders";
import { server } from "../testing/server";

// html-to-image は jsdom では動かないため PNG 生成だけ差し替え、
// captureViewport 本体 (ビューポート寸法・スクロール補正・メタデータ) は実物を動かす
const toBlob = vi.hoisted(() => vi.fn());
const createFeedbackThread = vi.hoisted(() => vi.fn());
vi.mock("html-to-image", () => ({ toBlob }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  createFeedbackThread
}));

// フィードバックオーバーレイ (docs/prototype-review.md Phase 2) の完成条件:
// 顧客が任意の画面からコンテキスト付きコメントを投稿できる
describe("FeedbackOverlay", () => {
  /** 投稿 API へ渡すメタデータと証跡を検証できるようにする。 */
  function captureSubmission() {
    const received: { metadata: unknown; screenshotBytes: number | null }[] = [];
    createFeedbackThread.mockImplementation(
      async (reviewSessionId: string, metadata: unknown, screenshot: Blob | null): Promise<FeedbackThread> => {
        received.push({ metadata, screenshotBytes: screenshot?.size ?? null });
        return {
          id: "ft-1",
          projectId: "p1",
          reviewSessionId,
          perspectiveCode: "BUSINESS_FLOW",
          perspectiveLabel: "業務フロー",
          targetType: "UI_ELEMENT",
          targetMetadata: {},
          status: "OPEN",
          createdAt: "2026-08-12T10:15:00+09:00",
          updatedAt: "2026-08-12T10:15:00+09:00",
          messages: []
        };
      }
    );
    return received;
  }

  beforeEach(() => {
    createFeedbackThread.mockReset();
    toBlob.mockResolvedValue(new Blob(["fake-png-bytes"], { type: "image/png" }));
  });

  /**
   * レビューモードに入る。ランチャーの表示は me → projects → review-sessions の
   * 3 往復を待つため、findBy の既定 1 秒では足りないことがある
   */
  async function enterFeedbackMode(user: ReturnType<typeof renderWithProviders>["user"]) {
    const launcher = await screen.findByRole("button", { name: /フィードバック/ }, { timeout: 5000 });
    await user.click(launcher);
  }

  it("受付中のセッションが無ければフィードバック機能を出さない", async () => {
    server.use(http.get("*/api/review-sessions", () => HttpResponse.json<ReviewSession[]>([])));
    renderWithProviders({ path: "/zones" });

    expect(await screen.findByRole("button", { name: "区域" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /フィードバック/ })).not.toBeInTheDocument();
  });

  it("安定 ID に紐づく既存コメントを現在画面へピン表示する", async () => {
    server.use(
      http.get("*/api/review-sessions/:id/threads", () =>
        HttpResponse.json<FeedbackThread[]>([makeFeedbackThread()])
      )
    );
    const { user } = renderWithProviders({ path: "/zones" });

    const pin = await screen.findByRole("button", {
      name: "業務フロー: 土地タブの名称を確認してください"
    });
    await user.click(pin);

    expect(screen.getByRole("complementary", { name: "コメントの概要" })).toHaveTextContent(
      "土地タブの名称を確認してください"
    );
  });

  it("画面座標コメントは証跡 route が現在画面と一致するときだけ表示する", async () => {
    const evidence = (route: string) => ({
      id: `ev-${route}`,
      contentType: "image/png",
      byteSize: 128,
      viewportWidth: 1024,
      viewportHeight: 768,
      scrollX: 0,
      scrollY: 0,
      pixelRatio: 1,
      frontendVersion: "test",
      route,
      capturedAt: "2026-08-12T10:15:00+09:00",
      expiresAt: null
    });
    server.use(
      http.get("*/api/review-sessions/:id/threads", () =>
        HttpResponse.json<FeedbackThread[]>([
          makeFeedbackThread({
            id: "ft-zones",
            targetType: "SCREEN_POSITION",
            targetMetadata: { type: "SCREEN_POSITION", relativeX: 0.4, relativeY: 0.5 },
            evidence: evidence("/zones?status=open"),
            messages: [
              {
                id: "fm-zones",
                threadId: "ft-zones",
                body: "区域画面の座標コメント",
                createdAt: "2026-08-12T10:15:00+09:00"
              }
            ]
          }),
          makeFeedbackThread({
            id: "ft-lands",
            targetType: "SCREEN_POSITION",
            targetMetadata: { type: "SCREEN_POSITION", relativeX: 0.6, relativeY: 0.5 },
            evidence: evidence("/lands"),
            messages: [
              {
                id: "fm-lands",
                threadId: "ft-lands",
                body: "土地画面だけの座標コメント",
                createdAt: "2026-08-12T10:15:00+09:00"
              }
            ]
          })
        ])
      )
    );
    renderWithProviders({ path: "/zones" });

    expect(
      await screen.findByRole("button", { name: "業務フロー: 区域画面の座標コメント" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "業務フロー: 土地画面だけの座標コメント" })
    ).not.toBeInTheDocument();
  });

  it("どの画面からでも対象をクリックしてコメントを投稿できる", async () => {
    const received = captureSubmission();
    const { user } = renderWithProviders({ path: "/zones" });

    await enterFeedbackMode(user);
    expect(screen.getByText("コメントしたい箇所をクリックしてください")).toBeInTheDocument();

    // 業務画面の任意の要素をコメント対象として指定する
    await user.click(screen.getByRole("button", { name: "土地" }));

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByText(/投稿時点の画面を証跡として保存します/)).toBeInTheDocument();

    await user.click(within(composer).getByRole("radio", { name: "地図操作" }));
    await user.type(within(composer).getByRole("textbox"), "この境界をクリックしたい");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(await screen.findByText("フィードバックを投稿しました")).toBeInTheDocument();
    expect(received[0].metadata).toMatchObject({
      perspectiveCode: "MAP_OPERATION",
      body: "この境界をクリックしたい",
      targetType: "UI_ELEMENT",
      target: { feedbackTargetId: "navigation.lands" },
      viewportWidth: 1024,
      viewportHeight: 768
    });
    expect(received[0].screenshotBytes).toBeGreaterThan(0);
  });

  it("対象クリックは業務画面の操作として実行されない (レビューモード中は横取りする)", async () => {
    const { user, router } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);

    await user.click(screen.getByRole("button", { name: "土地" }));

    expect(router.state.location.pathname).toBe("/zones");
    expect(await screen.findByRole("dialog", { name: "フィードバックの投稿" })).toBeInTheDocument();
  });

  it("安定 ID を持つ要素は UI_ELEMENT として対象になる", async () => {
    const received = captureSubmission();
    const { user } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);

    const marked = document.createElement("button");
    marked.setAttribute("data-feedback-id", "contract-expiration-date");
    marked.textContent = "契約満了日";
    document.querySelector(".business-app")?.append(marked);
    await user.click(marked);

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByText("contract-expiration-date")).toBeInTheDocument();
    await user.type(within(composer).getByRole("textbox"), "この項目は必要ですか");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    await screen.findByText("フィードバックを投稿しました");
    expect(received[0].metadata).toMatchObject({
      targetType: "UI_ELEMENT",
      target: { type: "UI_ELEMENT", feedbackTargetId: "contract-expiration-date" }
    });
  });

  it("選べる観点は今回 ACTIVE のものだけ", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);
    await user.click(screen.getByRole("button", { name: "土地" }));

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByRole("radio", { name: "業務フロー" })).toBeInTheDocument();
    expect(within(composer).getByRole("radio", { name: "地図操作" })).toBeInTheDocument();
    expect(within(composer).queryByRole("radio", { name: "デザイン・配色" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("radio", { name: "性能" })).not.toBeInTheDocument();
  });

  it("証跡の生成に失敗してもコメントだけは投稿できる", async () => {
    toBlob.mockRejectedValue(new Error("canvas is tainted"));
    const received = captureSubmission();
    const { user } = renderWithProviders({ path: "/zones" });

    await enterFeedbackMode(user);
    await user.click(screen.getByRole("button", { name: "土地" }));

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByRole("alert")).toHaveTextContent("証跡の取得に失敗しました");

    await user.type(within(composer).getByRole("textbox"), "証跡なしの指摘");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    await screen.findByText("フィードバックを投稿しました");
    expect(received[0].screenshotBytes).toBeNull();
  });

  it("コメントが空のうちは投稿できない", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);
    await user.click(screen.getByRole("button", { name: "土地" }));

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByRole("button", { name: "投稿する" })).toBeDisabled();
  });

  it("投稿に失敗したらエラーを見せ、入力を保持する", async () => {
    createFeedbackThread.mockRejectedValueOnce(new Error("このレビューセッションは受付中ではありません"));
    const { user } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);
    await user.click(screen.getByRole("button", { name: "土地" }));

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    await user.type(within(composer).getByRole("textbox"), "受付終了後の投稿");
    await user.click(within(composer).getByRole("button", { name: "投稿する" }));

    expect(await screen.findByText("このレビューセッションは受付中ではありません")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "フィードバックの投稿" })).toBeInTheDocument();
    expect(within(composer).getByRole("textbox")).toHaveValue("受付終了後の投稿");
  });

  it("Escape でレビューモードを抜けられる", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await enterFeedbackMode(user);
    expect(screen.getByText("コメントしたい箇所をクリックしてください")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("コメントしたい箇所をクリックしてください")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /フィードバック/ })).toBeInTheDocument();
  });
});
