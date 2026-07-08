// クエリフックのテストの見本。renderHook + createQueryWrapper (QueryClientProvider) で
// フックを実行し、API 応答は MSW で差し替える。
// - 一覧クエリ: 検索条件 → クエリパラメータへの写像と、レスポンスの反映
// - エラー: API の { error } メッセージが Error として伝播すること
// - ミューテーション: キャッシュ反映 (setQueryData) と一覧の invalidate
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Zone, ZoneWriteRequest } from "../contracts";
import { makeZone } from "../testing/fixtures";
import { defaultZones } from "../testing/handlers";
import { createQueryWrapper } from "../testing/renderWithProviders";
import { server } from "../testing/server";
import { keys } from "./keys";
import { useCreateZoneMutation, useZonesQuery } from "./zones";

describe("useZonesQuery", () => {
  it("検索条件を契約どおりのクエリパラメータへ写像し、一覧を返す", async () => {
    let requestUrl: URL | null = null;
    server.use(
      http.get("*/api/zones", ({ request }) => {
        requestUrl = new URL(request.url);
        return HttpResponse.json<Zone[]>([makeZone({ name: "検索ヒット区域" })]);
      })
    );

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(
      () => useZonesQuery("p1", { query: "大手町", filters: { status: "有効", linkedOnly: true } }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((zone) => zone.name)).toEqual(["検索ヒット区域"]);
    const params = requestUrl!.searchParams;
    expect(params.get("projectId")).toBe("p1");
    expect(params.get("q")).toBe("大手町");
    expect(params.get("status")).toBe("有効");
    expect(params.get("linkedOnly")).toBe("true");
    // 未指定のフィルタは送らない (空文字をクエリに残さない)
    expect(params.has("zoneType")).toBe(false);
  });

  it("projectId が未確定の間は取得しない (enabled ガード)", () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useZonesQuery("", { query: "", filters: {} }), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  it("API エラー ({ error }) を Error メッセージとして伝播する", async () => {
    server.use(http.get("*/api/zones", () => HttpResponse.json({ error: "権限がありません" }, { status: 403 })));

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useZonesQuery("p1", { query: "", filters: {} }), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("権限がありません");
  });
});

describe("useCreateZoneMutation", () => {
  it("作成結果を詳細キャッシュへ反映し、区域一覧のみ無効化する", async () => {
    server.use(
      http.post("*/api/zones", async ({ request }) => {
        const body = (await request.json()) as ZoneWriteRequest;
        return HttpResponse.json<Zone>(makeZone({ id: "Z-NEW", name: body.name ?? "" }), { status: 201 });
      })
    );

    const { wrapper, queryClient } = createQueryWrapper();
    // 既存の一覧キャッシュ (invalidate されることを検証する対象)
    const listKey = keys.zones.list("p1", { query: "", filters: {} });
    queryClient.setQueryData(listKey, defaultZones);
    const partiesKey = keys.parties.list("p1", { query: "", filters: {} });
    queryClient.setQueryData(partiesKey, []);

    const { result } = renderHook(() => useCreateZoneMutation(), { wrapper });
    const created = await result.current.mutateAsync({ name: "新しい区域", projectId: "p1" });

    expect(created.id).toBe("Z-NEW");
    expect(created.name).toBe("新しい区域");
    // 詳細はサーバ返却値で即時キャッシュされる
    expect(queryClient.getQueryData(keys.zones.detail("Z-NEW"))).toEqual(created);
    // 区域一覧は stale 化される。無関係な関係者一覧は触らない
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(partiesKey)?.isInvalidated).toBe(false);
  });
});
