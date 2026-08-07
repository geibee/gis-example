import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ReviewSession } from "../contracts";
import { makeReviewSession } from "../testing/fixtures";
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
});
