import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { FeedbackSummary, FeedbackThread, ReviewSession } from "../contracts";
import { makeFeedbackThread, makeReviewSession } from "../testing/fixtures";
import { renderWithProviders } from "../testing/renderWithProviders";
import { server } from "../testing/server";

// レビュー画面 (docs/prototype-review.md Phase 1) の完成条件を固定する:
// - レビュー開始時点で「何を見てほしいか」が明確
// - 選択不可の観点 (FUTURE / OUT_OF_SCOPE) をグレーアウトして表示できる
describe("ReviewScreen", () => {
  // セッション一覧にも同じ文字列が出るため、判定は常にガイド領域の内側で行う
  const guide = () => screen.getByRole("region", { name: "レビューガイド" });
  const perspectiveButton = (label: string) => within(guide()).getByRole("button", { name: new RegExp(label) });

  it("今回の観点・対象画面・期間をガイドとして表示する", async () => {
    renderWithProviders({ path: "/review" });

    expect(await screen.findByRole("heading", { name: "第1回 業務フローレビュー" })).toBeInTheDocument();
    expect(screen.getByText("案件検索から詳細確認までの流れを確認してください")).toBeInTheDocument();
    expect(within(guide()).getByText("レビュー受付中")).toBeInTheDocument();
    expect(within(guide()).getByText("今回確認してほしいこと")).toBeInTheDocument();
    expect(within(guide()).getByText("今後確認予定")).toBeInTheDocument();
    expect(within(guide()).getByText("今回対象外")).toBeInTheDocument();
    expect(within(guide()).getByText("/lands")).toBeInTheDocument();
    expect(within(guide()).getByText("/admin")).toBeInTheDocument();
  });

  it("FUTURE / OUT_OF_SCOPE の観点は表示するが選択できない", async () => {
    renderWithProviders({ path: "/review" });
    await screen.findByRole("heading", { name: "第1回 業務フローレビュー" });

    expect(perspectiveButton("業務フロー")).toBeEnabled();
    // 「今は見なくてよい」と「存在を忘れている」を区別させるため、消さずに残して無効化する
    expect(perspectiveButton("デザイン・配色")).toBeDisabled();
    expect(perspectiveButton("性能")).toBeDisabled();
    expect(within(guide()).getByText("次回のデザインレビューで確認します")).toBeInTheDocument();
  });

  it("ACTIVE の観点は選択できる (コメント投稿へ引き継ぐ)", async () => {
    const { user } = renderWithProviders({ path: "/review" });
    await screen.findByRole("heading", { name: "第1回 業務フローレビュー" });

    const target = perspectiveButton("地図操作");
    expect(target).toHaveAttribute("aria-pressed", "false");
    await user.click(target);
    expect(perspectiveButton("地図操作")).toHaveAttribute("aria-pressed", "true");
  });

  it("受付終了のセッションでは観点を選択できない", async () => {
    server.use(
      http.get("*/api/review-sessions", () =>
        HttpResponse.json<ReviewSession[]>([makeReviewSession({ status: "closed" })])
      )
    );
    renderWithProviders({ path: "/review" });
    await screen.findByRole("heading", { name: "第1回 業務フローレビュー" });

    expect(within(guide()).getByText("受付終了")).toBeInTheDocument();
    expect(perspectiveButton("業務フロー")).toBeDisabled();
  });

  it("受付中のセッションを既定で開き、一覧から切り替えられる", async () => {
    const draft = makeReviewSession({ id: "rs-draft", title: "第2回 レビュー (準備中)", status: "draft" });
    const open = makeReviewSession();
    server.use(http.get("*/api/review-sessions", () => HttpResponse.json<ReviewSession[]>([draft, open])));

    const { user } = renderWithProviders({ path: "/review" });

    expect(await screen.findByRole("heading", { name: "第1回 業務フローレビュー" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /第2回 レビュー \(準備中\)/ }));
    expect(screen.getByRole("heading", { name: "第2回 レビュー (準備中)" })).toBeInTheDocument();
    expect(perspectiveButton("業務フロー")).toBeDisabled();
  });

  it("セッションが 1 件も無い場合は空状態を伝える", async () => {
    server.use(http.get("*/api/review-sessions", () => HttpResponse.json<ReviewSession[]>([])));
    renderWithProviders({ path: "/review" });

    expect(
      await screen.findByText("このプロジェクトにはまだレビューセッションがありません。")
    ).toBeInTheDocument();
  });

  it("プロジェクト集計と選択セッションのフィードバック一覧を表示・絞り込みできる", async () => {
    const summary: FeedbackSummary = {
      totalCount: 5,
      openCount: 3,
      resolvedCount: 2,
      withEvidenceCount: 4,
      sessions: [
        {
          reviewSessionId: "rs-1",
          title: "第1回 業務フローレビュー",
          sessionStatus: "open",
          totalCount: 4,
          openCount: 3,
          resolvedCount: 1
        },
        {
          reviewSessionId: "rs-2",
          title: "第2回 デザインレビュー",
          sessionStatus: "draft",
          totalCount: 1,
          openCount: 0,
          resolvedCount: 1
        }
      ],
      perspectives: [
        {
          perspectiveCode: "BUSINESS_FLOW",
          perspectiveLabel: "業務フロー",
          totalCount: 3,
          openCount: 2,
          resolvedCount: 1
        }
      ]
    };
    const thread = makeFeedbackThread({
      evidence: {
        id: "ev-1",
        contentType: "image/png",
        byteSize: 128,
        viewportWidth: 1440,
        viewportHeight: 900,
        scrollX: 0,
        scrollY: 0,
        pixelRatio: 1,
        frontendVersion: "test",
        route: "/lands?status=open",
        capturedAt: "2026-08-12T10:15:00+09:00"
      }
    });
    const requestedQueries: string[] = [];
    let evidenceRequests = 0;
    server.use(
      http.get("*/api/threads/summary", () => HttpResponse.json<FeedbackSummary>(summary)),
      http.get("*/api/threads", ({ request }) => {
        requestedQueries.push(new URL(request.url).search);
        return HttpResponse.json<FeedbackThread[]>([thread], { headers: { "X-Total-Count": "1" } });
      }),
      http.get("*/api/threads/:threadId/evidence", () => {
        evidenceRequests += 1;
        return new HttpResponse(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" }
        });
      })
    );
    const { user } = renderWithProviders({ path: "/review" });

    const management = await screen.findByRole("region", { name: "フィードバック管理" });
    const aggregate = await within(management).findByRole("group", { name: "フィードバック集計" });
    expect(within(aggregate).getByText("5")).toBeInTheDocument();
    expect(within(management).getByRole("region", { name: "セッション別集計" })).toHaveTextContent(
      "第2回 デザインレビュー"
    );
    expect(within(management).getByRole("region", { name: "観点別集計" })).toHaveTextContent("業務フロー");
    expect(within(management).getByText("土地タブの名称を確認してください")).toBeInTheDocument();

    await user.selectOptions(within(management).getByLabelText("状態"), "RESOLVED");
    await waitFor(() => expect(requestedQueries[requestedQueries.length - 1]).toContain("status=RESOLVED"));
    await user.selectOptions(within(management).getByLabelText("証跡"), "with");
    await waitFor(() => expect(requestedQueries[requestedQueries.length - 1]).toContain("hasEvidence=true"));

    await user.click(within(management).getByRole("button", { name: /証跡を確認/ }));
    const evidenceDialog = await screen.findByRole("dialog", { name: "証跡の確認" });
    expect(within(evidenceDialog).getByText("/lands?status=open")).toBeInTheDocument();
    await waitFor(() => expect(evidenceRequests).toBe(1));
  });

  it("管理一覧から会話 Drawer を開ける", async () => {
    const thread = makeFeedbackThread();
    server.use(
      http.get("*/api/threads", () =>
        HttpResponse.json<FeedbackThread[]>([thread], { headers: { "X-Total-Count": "1" } })
      )
    );
    const { user } = renderWithProviders({ path: "/review" });
    const management = await screen.findByRole("region", { name: "フィードバック管理" });

    await user.click(await within(management).findByRole("button", { name: /スレッドを開く/ }));
    expect(await screen.findByRole("dialog", { name: "フィードバックスレッド" })).toBeInTheDocument();
  });
});
