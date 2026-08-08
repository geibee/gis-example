import type { FeedbackThread } from "./contracts";

/** 管理画面では全件を集約する一方、画面上のピンは投稿時の具体URLだけへ表示する。 */
export function feedbackThreadMatchesPath(thread: FeedbackThread, currentPath: string): boolean {
  const storedRoute = thread.pageRoute ?? thread.evidence?.route;
  if (!storedRoute) return true;
  return routePathname(storedRoute) === routePathname(currentPath);
}

function routePathname(value: string): string {
  try {
    const pathname = new URL(value, "https://feedback-route.invalid").pathname;
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  } catch {
    const pathname = value.split(/[?#]/, 1)[0] ?? "/";
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  }
}
