import type { FeedbackThread } from "./contracts";

/** 管理画面では全件を集約する一方、画面上のピンは投稿時の具体URLだけへ表示する。 */
export function feedbackThreadMatchesPath(thread: FeedbackThread, currentPath: string): boolean {
  const storedRoute = thread.pageRoute ?? thread.evidence?.route;
  if (!storedRoute) return true;
  return routePathname(storedRoute) === routePathname(currentPath);
}

/** 投稿時の画面へ移動し、ホスト側で対象スレッドを開くための相対URLを組み立てる。 */
export function feedbackThreadDeepLink(thread: FeedbackThread, projectId: string): string | null {
  const storedRoute = thread.pageRoute ?? thread.evidence?.route;
  if (!storedRoute) return null;
  try {
    const base = new URL("https://feedback-route.invalid");
    const url = new URL(storedRoute, base);
    // 永続化されたrouteから外部サイトへのリンクを生成しない。
    if (url.origin !== base.origin) return null;
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("feedbackThread", thread.id);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
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
