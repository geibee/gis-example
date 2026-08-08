import { defineFeedbackRoutes } from "@web-gis/feedback-plugin";
import type { ComponentType } from "react";
import { screenPageIds, tabBasePath, type ScreenMeta } from "./routeMeta";

type ScreenBasePath = (typeof tabBasePath)[keyof typeof tabBasePath];

export type ScreenDefinition = {
  basePath: ScreenBasePath;
  listLabel: string;
  meta: ScreenMeta;
  detailMeta?: ScreenMeta;
  loadComponent: () => Promise<{ default: ComponentType }>;
};

/**
 * ホストアプリの画面ルートのSSoT。
 * ルーター、フィードバックSDK、レビュー管理画面はすべてこの配列から構成する。
 */
export const screenDefinitions: readonly ScreenDefinition[] = [
  {
    basePath: tabBasePath.zone,
    listLabel: "区域一覧",
    meta: { pageId: screenPageIds.zones.list, tab: "zone", title: "区域" },
    detailMeta: { pageId: screenPageIds.zones.detail, tab: "zone", title: "区域詳細" },
    loadComponent: () => import("./screens/ZonesScreen")
  },
  {
    basePath: tabBasePath.lands,
    listLabel: "土地一覧",
    meta: { pageId: screenPageIds.lands.list, tab: "lands", title: "土地" },
    detailMeta: { pageId: screenPageIds.lands.detail, tab: "lands", title: "土地詳細" },
    loadComponent: () => import("./screens/LandsScreen")
  },
  {
    basePath: tabBasePath.buildings,
    listLabel: "建物一覧",
    meta: { pageId: screenPageIds.buildings.list, tab: "buildings", title: "建物" },
    detailMeta: { pageId: screenPageIds.buildings.detail, tab: "buildings", title: "建物詳細" },
    loadComponent: () => import("./screens/BuildingsScreen")
  },
  {
    basePath: tabBasePath.parties,
    listLabel: "関係者一覧",
    meta: { pageId: screenPageIds.parties.list, tab: "parties", title: "関係者" },
    detailMeta: { pageId: screenPageIds.parties.detail, tab: "parties", title: "関係者詳細" },
    loadComponent: () => import("./screens/PartiesScreen")
  },
  {
    basePath: tabBasePath.review,
    listLabel: "レビュー管理",
    meta: { pageId: screenPageIds.review.list, tab: "review", title: "レビュー" },
    loadComponent: () => import("./screens/ReviewScreen")
  },
  {
    basePath: tabBasePath.admin,
    listLabel: "システム管理",
    meta: { pageId: screenPageIds.admin.list, tab: "admin", title: "管理", requiredSystemRole: "admin" },
    loadComponent: () => import("./screens/AdminScreen")
  }
];

/** SDKへ渡し、レビュー管理画面にもそのまま表示するルート契約。 */
export const feedbackRoutes = defineFeedbackRoutes(
  screenDefinitions.flatMap((screen) => [
    {
      pageId: screen.meta.pageId,
      path: screen.basePath,
      label: screen.listLabel,
      group: "一覧・管理画面"
    },
    ...(screen.detailMeta
      ? [{
          pageId: screen.detailMeta.pageId,
          path: `${screen.basePath}/{id}`,
          label: screen.detailMeta.title,
          group: "詳細画面"
        }]
      : [])
  ])
);
