import type { ComponentType } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  redirect
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

const screenRoutes = screenDefinitions.flatMap((definition) => {
  const component = lazyRouteComponent(definition.loadComponent);
  const staticData = { screen: definition.meta };
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: definition.basePath,
    staticData,
    component
  });
  if (!definition.detail) return [listRoute];
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: `${definition.basePath}/$id` as const,
    staticData,
    component
  });
  return [listRoute, detailRoute];
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, ...screenRoutes]),
  // 未知パスは既定画面 (/zones) へ寄せる
  defaultNotFoundComponent: () => <Navigate to="/zones" replace />
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
