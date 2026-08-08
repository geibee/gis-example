/**
 * ホストアプリがSDKへ公開する画面ルート。
 *
 * path は実データのURLではなく `/orders/{id}` のようなルートテンプレートを使う。
 * パラメータは必ず1セグメント全体を `{name}` で表す。
 */
export type FeedbackRouteDefinition = {
  pageId: string;
  path: string;
  label: string;
  group?: string;
};

const parameterSegment = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** ルート定義を型付けし、重複やSDKで解釈できないパスを起動時に検出する。 */
export function defineFeedbackRoutes<const T extends readonly FeedbackRouteDefinition[]>(routes: T): T {
  const pageIds = new Set<string>();
  const paths = new Set<string>();
  for (const route of routes) {
    if (!route.pageId.trim() || !route.label.trim()) {
      throw new Error("フィードバックのルートにはpageIdとlabelが必要です");
    }
    if (!route.path.startsWith("/") || route.path.includes("?") || route.path.includes("#")) {
      throw new Error(`フィードバックのルートはquery/hashを含まない絶対パスで指定してください: ${route.path}`);
    }
    const invalidParameter = pathSegments(route.path).find(
      (segment) => (segment.includes("{") || segment.includes("}")) && !parameterSegment.test(segment)
    );
    if (invalidParameter) {
      throw new Error(`ルートパラメータはセグメント全体を{name}形式で指定してください: ${route.path}`);
    }
    if (pageIds.has(route.pageId)) throw new Error(`pageIdが重複しています: ${route.pageId}`);
    if (paths.has(route.path)) throw new Error(`pathが重複しています: ${route.path}`);
    pageIds.add(route.pageId);
    paths.add(route.path);
  }
  return routes;
}

/** pathnameに対応する定義を返す。静的ルートをパラメータ付きルートより優先する。 */
export function matchFeedbackRoute(
  routes: readonly FeedbackRouteDefinition[],
  pathname: string
): FeedbackRouteDefinition | null {
  const normalizedPathname = normalizePathname(pathname);
  const ordered = [...routes].sort((left, right) => parameterCount(left.path) - parameterCount(right.path));
  return ordered.find((route) => feedbackRouteMatches(route.path, normalizedPathname)) ?? null;
}

export function feedbackRouteMatches(template: string, pathname: string): boolean {
  const templateSegments = pathSegments(normalizePathname(template));
  const pathnameSegments = pathSegments(normalizePathname(pathname));
  if (templateSegments.length !== pathnameSegments.length) return false;
  return templateSegments.every((segment, index) =>
    parameterSegment.test(segment) ? pathnameSegments[index].length > 0 : segment === pathnameSegments[index]
  );
}

function normalizePathname(value: string): string {
  const pathname = value.split(/[?#]/, 1)[0] || "/";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function pathSegments(path: string): string[] {
  return path === "/" ? [] : path.replace(/^\//, "").split("/");
}

function parameterCount(path: string): number {
  return pathSegments(path).filter((segment) => parameterSegment.test(segment)).length;
}
