import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackThread } from "../contracts";
import { makeFeedbackThread } from "../testing/fixtures";
import { renderWithProviders } from "../testing/renderWithProviders";
import { server } from "../testing/server";

const toBlob = vi.hoisted(() => vi.fn());
vi.mock("html-to-image", () => ({ toBlob }));

// コメントピン (docs/prototype-review.md Phase 3)。
// 「どこへの指摘か」を文章ではなく画面上の位置で見せられること。
describe("FeedbackPins", () => {
  beforeEach(() => {
    toBlob.mockResolvedValue(new Blob(["fake-png-bytes"], { type: "image/png" }));
  });

  async function showPins(user: ReturnType<typeof renderWithProviders>["user"]) {
    const toggle = await screen.findByRole("button", { name: "コメントを見る" }, { timeout: 5000 });
    await user.click(toggle);
  }

  it("既定ではピンを出さず、切り替えで表示できる", async () => {
    const { user } = renderWithProviders({ path: "/zones" });

    await screen.findByRole("button", { name: "コメントを見る" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: /コメント: 検索後の流れ/ })).not.toBeInTheDocument();

    await showPins(user);
    expect(screen.getByRole("button", { name: /コメント: 検索後の流れ/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "コメントを隠す" })).toBeInTheDocument();
  });

  it("ピンはビューポート相対座標に置かれる", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);

    const pin = screen.getByRole("button", { name: /コメント: 検索後の流れ/ });
    // fixture の relativeX=0.4 / relativeY=0.6
    expect(pin).toHaveStyle({ left: "40%", top: "60%" });
  });

  it("投稿元が別の画面のコメントは出さない", async () => {
    server.use(
      http.get("*/api/review-sessions/:id/threads", () =>
        HttpResponse.json<FeedbackThread[]>([makeFeedbackThread({ pageId: "/parties" })])
      )
    );
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);

    expect(screen.queryByRole("button", { name: /コメント: 検索後の流れ/ })).not.toBeInTheDocument();
  });

  it("地図地物へのコメントは画面ピンにしない (地図側のマーカーが担当する)", async () => {
    server.use(
      http.get("*/api/review-sessions/:id/threads", () =>
        HttpResponse.json<FeedbackThread[]>([
          makeFeedbackThread({
            targetType: "MAP_FEATURE",
            targetMetadata: {
              type: "MAP_FEATURE",
              longitude: 139.7,
              latitude: 35.69,
              source: "parcel",
              featureId: "123456"
            }
          })
        ])
      )
    );
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);

    expect(screen.queryByRole("button", { name: /コメント: 検索後の流れ/ })).not.toBeInTheDocument();
  });

  it("ピンを押すとコメントの内容が読める", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);

    await user.click(screen.getByRole("button", { name: /コメント: 検索後の流れ/ }));

    const card = screen.getByRole("dialog", { name: "コメントの内容" });
    expect(within(card).getByRole("heading", { name: "業務フロー" })).toBeInTheDocument();
    expect(within(card).getByText("検索後の流れが分かりにくい")).toBeInTheDocument();
    expect(within(card).getByText(/顧客レビュアー/)).toBeInTheDocument();
    expect(within(card).getByText(/未解決/)).toBeInTheDocument();
  });

  it("解決済みのコメントはピンと内容の両方で区別できる", async () => {
    server.use(
      http.get("*/api/review-sessions/:id/threads", () =>
        HttpResponse.json<FeedbackThread[]>([makeFeedbackThread({ status: "RESOLVED" })])
      )
    );
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);

    const pin = screen.getByRole("button", { name: /コメント: 検索後の流れ/ });
    expect(pin.className).toContain("resolved");
    await user.click(pin);
    expect(within(screen.getByRole("dialog", { name: "コメントの内容" })).getByText(/解決済み/)).toBeInTheDocument();
  });

  it("ピンを隠すと開いていたコメントも閉じる", async () => {
    const { user } = renderWithProviders({ path: "/zones" });
    await showPins(user);
    await user.click(screen.getByRole("button", { name: /コメント: 検索後の流れ/ }));
    expect(screen.getByRole("dialog", { name: "コメントの内容" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "コメントを隠す" }));
    expect(screen.queryByRole("dialog", { name: "コメントの内容" })).not.toBeInTheDocument();
  });
});
