import type { ComponentType } from "react";
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
import { tabBasePath, type ScreenMeta } from "./routeMeta";

// ルートレイアウト: 認証済みユーザー向けの全 state を保持する App が
// ヘッダー・地図ペインを描画し、<Outlet /> に画面を差し込む
const rootRoute = createRootRoute({
  component: App
});

// 画面の追加は「この配列に1エントリ + src/screens/ に画面コンポーネント1ファイル」で完結する。
// - detail: true の画面は「/path」(一覧) と「/path/$id」(詳細ディープリンク) の両方にマッチする
// - meta は staticData として保持され、権限ガード・タイトル・タブ強調に使われる
// - loadComponent は lazyRouteComponent 経由で初回マッチ時に動的 import される (ルート単位のコード分割)
// パスをリテラル型で保つ (string に落とすと navigate の型付けが壊れる)
type ScreenBasePath = (typeof tabBasePath)[keyof typeof tabBasePath];

type ScreenDefinition = {
  basePath: ScreenBasePath;
  detail?: boolean;
  meta: ScreenMeta;
  loadComponent: () => Promise<{ default: ComponentType }>;
};

const screenDefinitions: ScreenDefinition[] = [
  { basePath: "/zones", detail: true, meta: { tab: "zone", title: "区域" }, loadComponent: () => import("./screens/ZonesScreen") },
  { basePath: "/lands", detail: true, meta: { tab: "lands", title: "土地" }, loadComponent: () => import("./screens/LandsScreen") },
  { basePath: "/buildings", detail: true, meta: { tab: "buildings", title: "建物" }, loadComponent: () => import("./screens/BuildingsScreen") },
  { basePath: "/parties", detail: true, meta: { tab: "parties", title: "関係者" }, loadComponent: () => import("./screens/PartiesScreen") },
  {
    basePath: "/admin",
    meta: { tab: "admin", title: "管理", requiredSystemRole: "admin" },
    loadComponent: () => import("./screens/AdminScreen")
  }
];

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
  if (!definition.detail) return listRoute;
  // 詳細 ($id) は一覧ルートの子とする。画面コンポーネントは一覧ルート側にだけ
  // 付き、一覧 ↔ 詳細の遷移で再マウントされない (検索条件など画面ローカル state を
  // 維持するため)。$id は従来どおり activeScreenObjectId が matches から読む。
  const detailRoute = createRoute({
    getParentRoute: () => listRoute,
    path: "$id",
    staticData
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
