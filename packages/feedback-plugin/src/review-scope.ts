import type { ReviewSession } from "./contracts";
import { feedbackRouteMatches } from "./routes";

export type ReviewPageScopeState = "reviewable" | "excluded" | "unscoped";

/** 現在の画面が今回のレビュー対象かを、具体的なroute指定を優先して判定する。 */
export function resolveReviewPageScope(
  session: ReviewSession,
  currentPageId: string | undefined,
  currentPath: string
): ReviewPageScopeState {
  const scope = resolveCurrentReviewScope(session, currentPageId, currentPath);
  if (!scope) return "unscoped";
  return scope.reviewable ? "reviewable" : "excluded";
}

/** 具体的なroute指定を優先して、現在の画面に対応するscopeを返す。 */
export function resolveCurrentReviewScope(
  session: ReviewSession,
  currentPageId: string | undefined,
  currentPath: string
): ReviewSession["scopes"][number] | undefined {
  if (!currentPageId) return undefined;
  const samePageScopes = session.scopes.filter((scope) => scope.pageId === currentPageId);
  return samePageScopes
    .filter(
      (candidate) => typeof candidate.route === "string" && feedbackRouteMatches(candidate.route, currentPath)
    )
    .sort((left, right) => parameterCount(left.route!) - parameterCount(right.route!))[0]
    ?? samePageScopes.find((candidate) => candidate.route == null);
}

function parameterCount(route: string): number {
  return route.split("/").filter((segment) => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)).length;
}
