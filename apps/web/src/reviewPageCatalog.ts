import { feedbackRoutes } from "./appRoutes";

export type ReviewPageCatalogOption = {
  pageId: string;
  route: string;
  label: string;
  group: string;
};

/**
 * APIの業務データではなく、ホストアプリがSDKへ渡すルート契約から作る画面カタログ。
 * `/zones/{id}` はデータ件数に関係なく1つのレビュー対象として扱う。
 */
export const reviewPageCatalog: readonly ReviewPageCatalogOption[] = feedbackRoutes.map((route) => ({
  pageId: route.pageId,
  route: route.path,
  label: route.label,
  group: route.group ?? "画面"
}));

/** pageId とルートテンプレートの組をフォーム内で扱うための可逆なキー。 */
export function reviewPageOptionKey(option: Pick<ReviewPageCatalogOption, "pageId" | "route">): string {
  return JSON.stringify([option.pageId, option.route]);
}
