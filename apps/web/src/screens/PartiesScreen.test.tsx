// 関係者画面 (react-hook-form + zod へ移行した見本フォーム) の画面テスト。
// - 必須フィールドのバリデーションエラーがフィールド単位で表示され、API を呼ばないこと
// - 作成・編集がバリデーション済みの値で API へ送られ、成功トーストが出ること
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Party, PartyWriteRequest } from "../contracts";
import { makeParty } from "../testing/fixtures";
import { renderWithProviders } from "../testing/renderWithProviders";
import { server } from "../testing/server";

const defaultParties = [makeParty(), makeParty({ id: "PT-2", name: "鈴木花子", partyType: "法人" })];

function usePartyHandlers() {
  server.use(
    http.get("*/api/parties", () => HttpResponse.json<Party[]>(defaultParties)),
    http.get("*/api/parties/:id", ({ params }) => {
      const party = defaultParties.find((item) => item.id === params.id);
      return party ? HttpResponse.json<Party>(party) : HttpResponse.json({ error: "not found" }, { status: 404 });
    })
  );
}

describe("PartiesScreen (RHF + zod フォーム)", () => {
  it("一覧が共通テーブルで描画され、件数が表示される", async () => {
    usePartyHandlers();
    renderWithProviders({ path: "/parties" });

    expect(await screen.findByText("山田太郎")).toBeInTheDocument();
    expect(screen.getByText("鈴木花子")).toBeInTheDocument();
    expect(screen.getByText("全 2 件")).toBeInTheDocument();
  });

  it("新規作成で必須フィールドを空のまま保存するとフィールド単位のエラーが出て、API を呼ばない", async () => {
    usePartyHandlers();
    let posted = false;
    server.use(
      http.post("*/api/parties", () => {
        posted = true;
        return HttpResponse.json<Party>(makeParty(), { status: 201 });
      })
    );
    const { user } = renderWithProviders({ path: "/parties" });
    await screen.findByText("山田太郎");

    await user.click(screen.getByRole("button", { name: "新規作成" }));
    // 名称を空に、種別も未選択にして保存
    await user.selectOptions(screen.getByLabelText(/種別/), "");
    await user.click(screen.getByRole("button", { name: "作成" }));

    expect(await screen.findByText("IDを入力してください")).toBeInTheDocument();
    expect(screen.getByText("名称を入力してください")).toBeInTheDocument();
    expect(screen.getByText("種別を選択してください")).toBeInTheDocument();
    expect(screen.getByLabelText(/名称/)).toHaveAttribute("aria-invalid", "true");
    expect(posted).toBe(false);
  });

  it("新規作成フォームを埋めて保存すると POST され、成功トーストと詳細 URL へ遷移する", async () => {
    usePartyHandlers();
    let requestBody: PartyWriteRequest | null = null;
    server.use(
      http.post("*/api/parties", async ({ request }) => {
        requestBody = (await request.json()) as PartyWriteRequest;
        return HttpResponse.json<Party>(
          makeParty({ id: requestBody.id ?? "PT-9", name: requestBody.name ?? "", partyType: requestBody.partyType ?? "" }),
          { status: 201 }
        );
      })
    );
    const { router, user } = renderWithProviders({ path: "/parties" });
    await screen.findByText("山田太郎");

    await user.click(screen.getByRole("button", { name: "新規作成" }));
    await user.type(screen.getByLabelText(/^ID/), "PT-9");
    await user.type(screen.getByLabelText(/名称/), "佐藤商事");
    await user.selectOptions(screen.getByLabelText(/種別/), "法人");
    await user.type(screen.getByLabelText(/タグ/), "競合、外国人、競合");
    await user.click(screen.getByRole("button", { name: "作成" }));

    expect(await screen.findByText("関係者を作成しました")).toBeInTheDocument();
    expect(requestBody).toMatchObject({
      id: "PT-9",
      projectId: "p1",
      name: "佐藤商事",
      partyType: "法人",
      // タグは読点区切り → 配列 + 重複除去でペイロード化される
      tags: ["競合", "外国人"]
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/parties/PT-9"));
  });

  it("既存関係者の編集はサーバ値が初期表示され、保存で PATCH される", async () => {
    usePartyHandlers();
    let requestBody: PartyWriteRequest | null = null;
    server.use(
      http.patch("*/api/parties/:id", async ({ request }) => {
        requestBody = (await request.json()) as PartyWriteRequest;
        return HttpResponse.json<Party>(makeParty({ name: requestBody.name ?? "" }));
      })
    );
    const { user } = renderWithProviders({ path: "/parties/PT-1" });

    const nameInput = await screen.findByLabelText(/名称/);
    await waitFor(() => expect(nameInput).toHaveValue("山田太郎"));

    await user.clear(nameInput);
    await user.type(nameInput, "山田太郎 (改名)");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("関係者を保存しました")).toBeInTheDocument();
    expect(requestBody).toMatchObject({ name: "山田太郎 (改名)", partyType: "個人" });
  });
});
