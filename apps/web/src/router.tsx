import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  redirect,
  type RouterHistory
} from "@tanstack/react-router";
import App from "./App";
import { screenDefinitions } from "./appRoutes";

// ルートレイアウト: 認証済みユーザー向けの全 state を保持する App が
// ヘッダー・地図ペインを描画し、<Outlet /> に画面を差し込む
const rootRoute = createRootRoute({
  component: App
});

// 画面の追加は「この配列に1エントリ + src/screens/ に画面コンポーネント1ファイル」で完結する。
// - detailMeta を持つ画面は「/path」(一覧) と「/path/$id」(詳細ディープリンク) の両方にマッチする
// - meta は staticData として保持され、権限ガード・タイトル・タブ強調に使われる
// - loadComponent は lazyRouteComponent 経由で初回マッチ時に動的 import される (ルート単位のコード分割)
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/zones", replace: true });
  }
});

const screenRoutes = screenDefinitions.map((definition) => {
  const component = lazyRouteComponent(definition.loadComponent);
  const staticData = { screen: definition.meta };
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: definition.basePath,
    staticData,
    component
  });
  if (!definition.detailMeta) return listRoute;
  // 詳細 ($id) は一覧ルートの子とする。画面コンポーネントは一覧ルート側にだけ
  // 付き、一覧 ↔ 詳細の遷移で再マウントされない (検索条件など画面ローカル state を
  // 維持するため)。$id は従来どおり activeScreenObjectId が matches から読む。
  const detailRoute = createRoute({
    getParentRoute: () => listRoute,
    path: "$id",
    staticData: { screen: definition.detailMeta }
  });
  return listRoute.addChildren([detailRoute]);
});

// テストではメモリ履歴を注入した独立インスタンスを作れるようファクトリとして公開する
// (本番はモジュール単位のシングルトン router をそのまま使う)
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, ...screenRoutes]),
    // 未知パスは既定画面 (/zones) へ寄せる
    defaultNotFoundComponent: () => <Navigate to="/zones" replace />,
    history
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
