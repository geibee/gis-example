import { parseFeedbackTarget } from "@web-gis/feedback-plugin";
import type { FeedbackThread, FeedbackThreadSearchQuery, ReviewSession } from "./contracts";
import { searchFeedbackThreads, type FeedbackThreadSearchResult } from "./api";
import { buildFeedbackPermalink } from "./feedbackPermalink";

const EXPORT_BATCH_SIZE = 1000;

type FeedbackSearchLoader = (query: FeedbackThreadSearchQuery) => Promise<FeedbackThreadSearchResult>;

/** 画面上のページングに影響されず、現在の絞り込み条件に合う全スレッドを取得する。 */
export async function loadFeedbackThreadsForExport(
  query: Omit<FeedbackThreadSearchQuery, "limit" | "offset">,
  loader: FeedbackSearchLoader = searchFeedbackThreads
): Promise<FeedbackThread[]> {
  const threads: FeedbackThread[] = [];
  let offset = 0;
  while (true) {
    const result = await loader({ ...query, limit: EXPORT_BATCH_SIZE, offset });
    threads.push(...result.items);
    offset += result.items.length;
    if (result.items.length === 0 || offset >= result.totalCount) return threads;
  }
}

/** Excelで文字化けしないBOM付きUTF-8 CSV。1メッセージを1行にして返信も集計できる。 */
export function buildFeedbackExportCsv(
  session: ReviewSession,
  threads: FeedbackThread[],
  baseUrl?: string
): string {
  const headers = [
    "FB番号",
    "レビューセッション",
    "画面",
    "ルート",
    "対象箇所",
    "観点",
    "状態",
    "投稿者",
    "コメント",
    "投稿日時",
    "編集日時",
    "パーマリンク",
    "スレッドID"
  ];
  const rows = threads.flatMap((thread) => {
    const scope = session.scopes.find((candidate) => candidate.id === thread.reviewScopeId);
    const route = thread.pageRoute ?? thread.evidence?.route ?? scope?.route ?? scope?.pageId ?? "";
    const screen = scope?.description ?? scope?.pageId ?? route;
    const messages = thread.messages.length > 0 ? thread.messages : [null];
    return messages.map((message) => [
      thread.displayNumber,
      session.title,
      screen,
      route,
      describeFeedbackTarget(thread.targetMetadata),
      thread.perspectiveLabel,
      thread.status === "RESOLVED" ? "解決済み" : "未解決",
      message?.participantName ?? message?.authorName ?? thread.reporterName ?? thread.createdByName ?? "投稿者不明",
      message?.body ?? "",
      message?.createdAt ?? thread.createdAt,
      message?.editedAt ?? "",
      buildFeedbackPermalink(thread, thread.projectId, baseUrl),
      thread.id
    ]);
  });
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadFeedbackExportCsv(session: ReviewSession, threads: FeedbackThread[]): void {
  const blob = new Blob([buildFeedbackExportCsv(session, threads)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(session.title)}-フィードバック.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function describeFeedbackTarget(metadata: FeedbackThread["targetMetadata"]): string {
  const target = parseFeedbackTarget(metadata);
  if (!target) return "不明";
  switch (target.type) {
    case "UI_ELEMENT":
      return `画面要素: ${target.feedbackTargetId}`;
    case "SCREEN_POSITION":
      return `画面位置: ${percent(target.relativeX)}, ${percent(target.relativeY)}`;
    case "MAP_FEATURE":
      return `地物: ${target.source}${target.sourceLayer ? ` / ${target.sourceLayer}` : ""} / ${target.featureId}`;
    case "MAP_POSITION":
      return `地図位置: ${target.longitude}, ${target.latitude}`;
  }
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function csvCell(rawValue: unknown): string {
  const value = String(rawValue ?? "");
  // Excelの数式として評価されるコメントを無効化する (CSV injection対策)。
  const safeValue = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "レビュー";
}
