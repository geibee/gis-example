import type { ComponentType } from "react";
import { tabBasePath, type ScreenMeta } from "./routeMeta";

type ScreenBasePath = (typeof tabBasePath)[keyof typeof tabBasePath];

export type ScreenDefinition = {
  basePath: ScreenBasePath;
  meta: ScreenMeta;
  detailMeta?: ScreenMeta;
  loadComponent: () => Promise<{ default: ComponentType }>;
};

/**
 * ホストアプリの画面ルートのSSoT。
 * ルーターはこの配列から構成する。
 */
export const screenDefinitions: readonly ScreenDefinition[] = [
  {
    basePath: tabBasePath.zone,
    meta: { tab: "zone", title: "区域" },
    detailMeta: { tab: "zone", title: "区域詳細" },
    loadComponent: () => import("./screens/ZonesScreen")
  },
  {
    basePath: tabBasePath.lands,
    meta: { tab: "lands", title: "土地" },
    detailMeta: { tab: "lands", title: "土地詳細" },
    loadComponent: () => import("./screens/LandsScreen")
  },
  {
    basePath: tabBasePath.buildings,
    meta: { tab: "buildings", title: "建物" },
    detailMeta: { tab: "buildings", title: "建物詳細" },
    loadComponent: () => import("./screens/BuildingsScreen")
  },
  {
    basePath: tabBasePath.parties,
    meta: { tab: "parties", title: "関係者" },
    detailMeta: { tab: "parties", title: "関係者詳細" },
    loadComponent: () => import("./screens/PartiesScreen")
  },
  {
    basePath: tabBasePath.admin,
    meta: { tab: "admin", title: "管理", requiredSystemRole: "admin" },
    loadComponent: () => import("./screens/AdminScreen")
  }
];
