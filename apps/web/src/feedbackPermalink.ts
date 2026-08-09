import type { FeedbackThread } from "./contracts";

/** 投稿時の画面を開き、SDKが対象スレッドを自動表示する同一オリジンのパーマリンク。 */
export function buildFeedbackPermalink(
  thread: FeedbackThread,
  projectId: string,
  baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin
): string {
  const source = thread.pageRoute ?? thread.evidence?.route ?? "/review";
  const sourceUrl = new URL(source, baseUrl);
  // APIへ直接投入された外部originには遷移せず、pathname/search/hashだけを同一originへ移す。
  const result = new URL(`${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`, baseUrl);
  result.searchParams.set("projectId", projectId);
  result.searchParams.set("feedbackThread", thread.id);
  return result.toString();
}

export function feedbackPermalinkPath(permalink: string): string {
  const url = new URL(permalink, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  return `${url.pathname}${url.search}${url.hash}`;
}
