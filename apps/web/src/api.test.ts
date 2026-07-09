// api.ts の 401 リカバリ (silent renew → 再送 → 再ログイン誘導) の挙動を検証する。
// MSW ハンドラは Authorization ヘッダで新旧トークンを区別し、renew の成否は
// setSilentRenewHandler へ渡すハンドラで制御する。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { createParty, getProjects } from "./api";
import { getAccessToken, setAccessToken, setSilentRenewHandler, setUnauthorizedHandler } from "./auth";
import { makeParty, makeProject } from "./testing/fixtures";
import { server } from "./testing/server";

const FRESH = "Bearer fresh-token";

// Authorization が新トークンなら 200、それ以外は 401 を返す GET /api/projects
function projectsRequiringFreshToken() {
  return http.get("*/api/projects", ({ request }) =>
    request.headers.get("authorization") === FRESH
      ? HttpResponse.json([makeProject()])
      : HttpResponse.json({ error: "unauthorized" }, { status: 401 })
  );
}

describe("api 401 リカバリ", () => {
  const unauthorized = vi.fn();

  beforeEach(() => {
    // restoreMocks は vi.spyOn のみ対象で vi.fn の呼び出し履歴は残るため明示的にクリアする
    unauthorized.mockClear();
    setAccessToken("expired-token");
    setUnauthorizedHandler(unauthorized);
  });

  afterEach(() => {
    setAccessToken(undefined);
    setSilentRenewHandler(undefined);
    setUnauthorizedHandler(undefined);
  });

  test("401 → silent renew 成功 → 新トークンで再送して成功する (再ログイン誘導なし)", async () => {
    server.use(projectsRequiringFreshToken());
    const renew = vi.fn(async () => "fresh-token");
    setSilentRenewHandler(renew);

    const projects = await getProjects();

    expect(projects).toHaveLength(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
    // 共有トークンも更新され、以降のリクエストは新トークンで送られる
    expect(getAccessToken()).toBe("fresh-token");
  });

  test("非 GET (POST) も 401 なら renew 後に同一ボディで再送される", async () => {
    let receivedName: string | undefined;
    server.use(
      http.post("*/api/parties", async ({ request }) => {
        if (request.headers.get("authorization") !== FRESH) {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        const body = (await request.json()) as { name: string };
        receivedName = body.name;
        return HttpResponse.json(makeParty({ name: body.name }), { status: 201 });
      })
    );
    setSilentRenewHandler(async () => "fresh-token");

    const party = await createParty({ projectId: "p1", name: "再送テスト", partyType: "個人" });

    expect(party.name).toBe("再送テスト");
    expect(receivedName).toBe("再送テスト");
    expect(unauthorized).not.toHaveBeenCalled();
  });

  test("401 → silent renew 失敗 → 再ログイン誘導してエラーを投げる", async () => {
    server.use(projectsRequiringFreshToken());
    setSilentRenewHandler(async () => undefined);

    await expect(getProjects()).rejects.toThrow("認証の有効期限が切れました");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  test("renew 成功でも再送が 401 (ユーザー無効化など) なら再ログイン誘導へ落ちる (無限ループしない)", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/projects", () => {
        requests += 1;
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      })
    );
    const renew = vi.fn(async () => "fresh-token");
    setSilentRenewHandler(renew);

    await expect(getProjects()).rejects.toThrow("認証の有効期限が切れました");
    // 初回 + renew 後の再送の 2 回のみ (再送後の 401 で renew を繰り返さない)
    expect(requests).toBe(2);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  test("並行リクエストが同時に 401 を受けても renew は single-flight で 1 回だけ走る", async () => {
    server.use(projectsRequiringFreshToken());
    const renew = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("fresh-token"), 20))
    );
    setSilentRenewHandler(renew);

    const [first, second] = await Promise.all([getProjects(), getProjects()]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
