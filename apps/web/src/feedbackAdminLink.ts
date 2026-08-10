export type FeedbackAdminScope = {
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
};

export type FeedbackAdminAction = "create-review";

/** Admin Console URLへ公開識別子だけを渡す。tokenや現在画面のqueryは転送しない。 */
export function buildFeedbackAdminUrl(
  baseUrl: string,
  scope: FeedbackAdminScope,
  action?: FeedbackAdminAction
): string {
  const url = new URL(baseUrl, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  url.searchParams.set("applicationKey", scope.applicationKey);
  url.searchParams.set("environmentKey", scope.environmentKey);
  url.searchParams.set("workspaceKey", scope.externalWorkspaceKey);
  if (action) url.searchParams.set("action", action);
  return url.toString();
}
