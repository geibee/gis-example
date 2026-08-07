import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { FeedbackMessage, FeedbackThread, Me } from "../contracts";
import { makeFeedbackThread, makeMe } from "../testing/fixtures";
import { renderWithProviders } from "../testing/renderWithProviders";
import { server } from "../testing/server";

async function openThreadDrawer(user: ReturnType<typeof renderWithProviders>["user"]) {
  const pin = await screen.findByRole("button", { name: /土地タブの名称を確認してください/ });
  await user.click(pin);
  await user.click(screen.getByRole("button", { name: "スレッドを開く" }));
  return screen.findByRole("dialog", { name: "フィードバックスレッド" });
}

describe("FeedbackThreadDrawer", () => {
  it("メッセージ一覧を表示し、OPEN のスレッドへ返信できる", async () => {
    let thread = makeFeedbackThread();
    let receivedBody: unknown = null;
    server.use(
      http.get("*/api/review-sessions/:id/threads", () => HttpResponse.json<FeedbackThread[]>([thread])),
      http.get("*/api/threads/:threadId", () => HttpResponse.json<FeedbackThread>(thread)),
      http.post("*/api/threads/:threadId/messages", async ({ request }) => {
        receivedBody = await request.json();
        const message: FeedbackMessage = {
          id: "fm-2",
          threadId: thread.id,
          authorId: "u1",
          authorName: "一般ユーザー",
          body: "名称は案件一覧に合わせましょう",
          createdAt: "2026-08-12T11:00:00+09:00",
          editedAt: null
        };
        thread = { ...thread, messages: [...thread.messages, message], updatedAt: message.createdAt };
        return HttpResponse.json<FeedbackMessage>(message, { status: 201 });
      })
    );
    const { user } = renderWithProviders({ path: "/zones" });
    const drawer = await openThreadDrawer(user);

    expect(within(drawer).getByText("土地タブの名称を確認してください")).toBeInTheDocument();
    await user.type(within(drawer).getByRole("textbox", { name: "返信" }), "名称は案件一覧に合わせましょう");
    await user.click(within(drawer).getByRole("button", { name: "返信する" }));

    await waitFor(() => expect(receivedBody).toEqual({ body: "名称は案件一覧に合わせましょう" }));
    expect(await within(drawer).findByText("名称は案件一覧に合わせましょう")).toBeInTheDocument();
  });

  it("editor はスレッドを解決し、解決済みスレッドを再開できる", async () => {
    let thread = makeFeedbackThread();
    server.use(
      http.get("*/api/review-sessions/:id/threads", () => HttpResponse.json<FeedbackThread[]>([thread])),
      http.get("*/api/threads/:threadId", () => HttpResponse.json<FeedbackThread>(thread)),
      http.patch("*/api/threads/:threadId/status", async ({ request }) => {
        const requestBody = (await request.json()) as { status: FeedbackThread["status"] };
        thread = { ...thread, status: requestBody.status, updatedAt: "2026-08-12T12:00:00+09:00" };
        return HttpResponse.json<FeedbackThread>(thread);
      })
    );
    const { user } = renderWithProviders({ path: "/zones" });
    const drawer = await openThreadDrawer(user);

    await user.click(within(drawer).getByRole("button", { name: "解決済みにする" }));
    expect(await within(drawer).findByText("解決済み")).toBeInTheDocument();
    expect(within(drawer).queryByRole("textbox", { name: "返信" })).not.toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "スレッドを再開する" }));
    expect(await within(drawer).findByText("未解決")).toBeInTheDocument();
    expect(within(drawer).getByRole("textbox", { name: "返信" })).toBeInTheDocument();
  });

  it("viewer は返信できるが状態変更操作は表示されない", async () => {
    const thread = makeFeedbackThread();
    server.use(
      http.get("*/api/me", () =>
        HttpResponse.json<Me>(makeMe({ memberships: [{ projectId: "p1", role: "viewer" }] }))
      ),
      http.get("*/api/review-sessions/:id/threads", () => HttpResponse.json<FeedbackThread[]>([thread])),
      http.get("*/api/threads/:threadId", () => HttpResponse.json<FeedbackThread>(thread))
    );
    const { user } = renderWithProviders({ path: "/zones" });
    const drawer = await openThreadDrawer(user);

    expect(within(drawer).getByRole("textbox", { name: "返信" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "解決済みにする" })).not.toBeInTheDocument();
  });
});
