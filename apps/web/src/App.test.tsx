// 画面コンポーネントのテストの見本。renderWithProviders が本物のルートツリー
// (App = ルートレイアウト + 権限ガード) をメモリ履歴で描画し、API は MSW が返す。
// - 一覧描画: MSW のデータが画面に反映される
// - 遷移: 行クリックで詳細 URL (/zones/$id) へ移り、詳細フォームが表示される
// - 権限ガード: ルート staticData (requiredSystemRole) による /admin の保護
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Me } from "./contracts";
import { makeMe } from "./testing/fixtures";
import { renderWithProviders } from "./testing/renderWithProviders";
import { server } from "./testing/server";

function useAdminMe() {
  server.use(http.get("*/api/me", () => HttpResponse.json<Me>(makeMe({ systemRole: "admin", displayName: "管理者" }))));
}

describe("区域一覧 (/zones)", () => {
  it("MSW が返す一覧データが描画される", async () => {
    renderWithProviders({ path: "/zones" });

    expect(await screen.findByText("大手町一丁目区域")).toBeInTheDocument();
    expect(screen.getByText("丸の内二丁目区域")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "区域" })).toBeInTheDocument();
  });

  it("行クリックで詳細 URL へ遷移し、詳細フォームが表示される", async () => {
    const { router, user } = renderWithProviders({ path: "/zones" });

    await user.click(await screen.findByText("大手町一丁目区域"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/zones/Z-1"));
    // 詳細フォームに選択した区域の値が入る (useZoneQuery → draft 同期)
    expect(await screen.findByDisplayValue("大手町一丁目区域")).toBeInTheDocument();
  });
});

describe("権限ガード (/admin)", () => {
  it("admin でないユーザーが /admin に入ると /zones へリダイレクトされる", async () => {
    const { router } = renderWithProviders({ path: "/admin" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/zones"));
    expect(await screen.findByRole("heading", { name: "区域" })).toBeInTheDocument();
    // 非 admin にはヘッダーの管理タブも出ない
    expect(screen.queryByRole("button", { name: "管理" })).not.toBeInTheDocument();
  });

  it("admin ユーザーには /admin で管理画面が表示される", async () => {
    useAdminMe();
    const { router } = renderWithProviders({ path: "/admin" });

    // ユーザー一覧・プロジェクトメンバー (MSW) が描画され、リダイレクトされない
    expect(await screen.findByRole("heading", { name: "ユーザー" })).toBeInTheDocument();
    expect(await screen.findByText("member@example.com")).toBeInTheDocument();
    // 自分自身 (userId 一致) の行には (自分) マークが付く
    expect(await screen.findByText("(自分)")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/admin");
  });
});

describe("未知の URL", () => {
  it("存在しないパスは既定画面 (/zones) へ寄せる", async () => {
    const { router } = renderWithProviders({ path: "/no-such-screen" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/zones"));
    expect(await screen.findByText("大手町一丁目区域")).toBeInTheDocument();
  });
});
