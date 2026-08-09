import type { ReviewSession } from "./contracts";
import { feedbackRouteMatches } from "./routes";

export type ReviewPageScopeState = "reviewable" | "excluded" | "unscoped";

/** 現在の画面が今回のレビュー対象かを、具体的なroute指定を優先して判定する。 */
export function resolveReviewPageScope(
  session: ReviewSession,
  currentPageId: string | undefined,
  currentPath: string
): ReviewPageScopeState {
  if (!currentPageId) return "unscoped";
  const samePageScopes = session.scopes.filter((scope) => scope.pageId === currentPageId);
  const scope = samePageScopes
    .filter(
      (candidate) => typeof candidate.route === "string" && feedbackRouteMatches(candidate.route, currentPath)
    )
    .sort((left, right) => parameterCount(left.route!) - parameterCount(right.route!))[0]
    ?? samePageScopes.find((candidate) => candidate.route == null);
  if (!scope) return "unscoped";
  return scope.reviewable ? "reviewable" : "excluded";
}

function parameterCount(route: string): number {
  return route.split("/").filter((segment) => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)).length;
}
