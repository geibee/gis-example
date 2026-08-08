import type { FeedbackApiClient } from "./api";
import { FeedbackApiError } from "./api";

/**
 * Phase 4 の互換期間用 adapter。
 *
 * write は常に Feedback API v1 だけへ送り、旧 API は read fallback に限定する。
 * 401/403/429 は認証・認可・流量制御を迂回しないよう fallback しない。
 */
export function createDualReadFeedbackApiClient(
  primary: FeedbackApiClient,
  legacy: FeedbackApiClient
): FeedbackApiClient {
  return {
    getMe: () => primary.getMe(),
    getReviewSessions: (projectId, status) => mergeRead(
      () => primary.getReviewSessions(projectId, status),
      () => legacy.getReviewSessions(projectId, status),
      (session) => session.id
    ),
    getFeedbackThreads: (reviewSessionId) => mergeRead(
      () => primary.getFeedbackThreads(reviewSessionId),
      () => legacy.getFeedbackThreads(reviewSessionId),
      (thread) => thread.id
    ),
    getFeedbackThread: (threadId) => fallbackRead(
      () => primary.getFeedbackThread(threadId),
      () => legacy.getFeedbackThread(threadId)
    ),
    getFeedbackMessageHistory: (messageId) => mergeRead(
      () => primary.getFeedbackMessageHistory(messageId),
      () => legacy.getFeedbackMessageHistory(messageId),
      (version) => `${version.messageId}:${version.version}`
    ),
    createFeedbackThread: (...arguments_) => primary.createFeedbackThread(...arguments_),
    createFeedbackMessage: (...arguments_) => primary.createFeedbackMessage(...arguments_),
    updateFeedbackMessage: (...arguments_) => primary.updateFeedbackMessage(...arguments_),
    updateFeedbackThreadStatus: (...arguments_) => primary.updateFeedbackThreadStatus(...arguments_)
  };
}

async function mergeRead<T>(
  primaryRead: () => Promise<T[]>,
  legacyRead: () => Promise<T[]>,
  key: (value: T) => string
): Promise<T[]> {
  let primary: T[];
  try {
    primary = await primaryRead();
  } catch (error) {
    if (!isFallbackAllowed(error)) throw error;
    return legacyRead();
  }

  try {
    const legacy = await legacyRead();
    const merged = new Map(legacy.map((value) => [key(value), value]));
    // コピー済みの resource は新サービス側を正とする。
    primary.forEach((value) => merged.set(key(value), value));
    return [...merged.values()];
  } catch (error) {
    // primary が読めている場合、旧 API の停止で新経路まで失敗させない。
    if (isFallbackAllowed(error) || error instanceof FeedbackApiError) return primary;
    throw error;
  }
}

async function fallbackRead<T>(primaryRead: () => Promise<T>, legacyRead: () => Promise<T>): Promise<T> {
  try {
    return await primaryRead();
  } catch (error) {
    if (!isFallbackAllowed(error)) throw error;
    return legacyRead();
  }
}

function isFallbackAllowed(error: unknown): boolean {
  if (!(error instanceof FeedbackApiError)) return true;
  return error.status === 404 || error.status >= 500;
}
