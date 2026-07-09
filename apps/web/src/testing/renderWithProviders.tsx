// 画面テスト用のレンダリングヘルパー。実アプリと同じプロバイダ構成で描画する:
//
//   QueryClientProvider (リトライ無効のテスト専用 client)
//     └ RouterProvider (本物のルートツリー + メモリ履歴)
//         └ App (ルートレイアウト: AppShellProvider / MapStateProvider / 権限ガード)
//
// 認証 (react-oidc-context) と地図ペイン (MapPane) は setup.ts の vi.mock で
// スタブ済み。API 応答は MSW (testing/handlers.ts) が返す。
//
// 使い方 (新画面のテストはこの形をコピーして書き始める):
//   const { router, user } = renderWithProviders({ path: "/zones" });
//   expect(await screen.findByText("大手町一丁目区域")).toBeInTheDocument();
//   await user.click(...);
//   expect(router.state.location.pathname).toBe("/zones/Z-1");
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "../router";

// 本番 (queries/queryClient.ts) との違い: リトライと staleTime を切り、
// 失敗がそのままテストの失敗として観測できるようにする
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false }
    }
  });
}

type RenderWithProvidersOptions = {
  /** 初期 URL (default: "/zones") */
  path?: string;
  /** キャッシュを事前に仕込みたい場合などに外から渡す */
  queryClient?: QueryClient;
};

export function renderWithProviders(options: RenderWithProvidersOptions = {}) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [options.path ?? "/zones"] }));
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...result, router, queryClient, user: userEvent.setup() };
}

// クエリフック単体テスト (renderHook) 用の wrapper。ルーターは含まない。
export function createQueryWrapper(queryClient: QueryClient = createTestQueryClient()) {
  function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper: QueryWrapper, queryClient };
}
