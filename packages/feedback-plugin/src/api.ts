import type {
  FeedbackMessage,
  FeedbackMessageCreateRequest,
  FeedbackMessageUpdateRequest,
  FeedbackMessageVersion,
  FeedbackThread,
  FeedbackThreadCreateMetadata,
  FeedbackThreadStatusPatchRequest,
  Me,
  ReviewSession
} from "./contracts";
import type { FeedbackPluginNotificationHandler } from "./types";

export type TokenGetter = () => string | null | undefined | Promise<string | null | undefined>;
export type TokenRefresher = () => Promise<string | null | undefined>;

export type FeedbackApiClientOptions = {
  apiBaseUrl: string;
  getAccessToken: TokenGetter;
  refreshAccessToken?: TokenRefresher;
  onNotification?: FeedbackPluginNotificationHandler;
  fetch?: typeof globalThis.fetch;
};

export class FeedbackApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FeedbackApiError";
    this.status = status;
  }
}
export type FeedbackApiClient = {
  getMe(): Promise<Me>;
  getReviewSessions(projectId: string, status?: ReviewSession["status"]): Promise<ReviewSession[]>;
  getFeedbackThreads(reviewSessionId: string): Promise<FeedbackThread[]>;
  getFeedbackThread(threadId: string): Promise<FeedbackThread>;
  createFeedbackThread(
    reviewSessionId: string,
    metadata: FeedbackThreadCreateMetadata,
    screenshot: Blob | null
  ): Promise<FeedbackThread>;
  createFeedbackMessage(threadId: string, body: FeedbackMessageCreateRequest): Promise<FeedbackMessage>;
  updateFeedbackMessage(messageId: string, body: FeedbackMessageUpdateRequest): Promise<FeedbackMessage>;
  getFeedbackMessageHistory(messageId: string): Promise<FeedbackMessageVersion[]>;
  updateFeedbackThreadStatus(
    threadId: string,
    body: FeedbackThreadStatusPatchRequest
  ): Promise<FeedbackThread>;
};

export function createFeedbackApiClient(options: FeedbackApiClientOptions): FeedbackApiClient {
  const baseUrl = options.apiBaseUrl.replace(/\/$/, "");
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let refreshInFlight: Promise<string | null | undefined> | null = null;

  const refreshOnce = () => {
    if (!options.refreshAccessToken) return Promise.resolve(undefined);
    if (!refreshInFlight) {
      refreshInFlight = options.refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  };

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const perform = async (token: string | null | undefined) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return requestFetch(`${baseUrl}${path}`, { ...init, headers });
    };

    let response = await perform(await options.getAccessToken());
    if (response.status === 401 && options.refreshAccessToken) {
      const renewed = await refreshOnce();
      if (renewed) response = await perform(renewed);
    }
    if (!response.ok) {
      const message = await readErrorMessage(response);
      if (response.status === 401) {
        options.onNotification?.({
          type: "unauthorized",
          message: "認証の有効期限が切れました。再ログインしてください"
        });
      }
      throw new FeedbackApiError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  const jsonRequest = <T>(path: string, method: string, body: unknown) =>
    request<T>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  return {
    getMe: () => request<Me>("/api/me"),
    getReviewSessions: (projectId: string, status?: ReviewSession["status"]) => {
      const query = new URLSearchParams({ projectId });
      if (status) query.set("status", status);
      return request<ReviewSession[]>(`/api/review-sessions?${query}`);
    },
    getFeedbackThreads: (reviewSessionId: string) =>
      request<FeedbackThread[]>(`/api/review-sessions/${encodeURIComponent(reviewSessionId)}/threads`),
    getFeedbackThread: (threadId: string) =>
      request<FeedbackThread>(`/api/threads/${encodeURIComponent(threadId)}`),
    createFeedbackThread: (
      reviewSessionId: string,
      metadata: FeedbackThreadCreateMetadata,
      screenshot: Blob | null
    ) => {
      const body = new FormData();
      body.append("metadata", JSON.stringify(metadata));
      if (screenshot) body.append("screenshot", screenshot, "evidence.png");
      return request<FeedbackThread>(`/api/review-sessions/${encodeURIComponent(reviewSessionId)}/threads`, {
        method: "POST",
        body
      });
    },
    createFeedbackMessage: (threadId: string, body: FeedbackMessageCreateRequest) =>
      jsonRequest<FeedbackMessage>(`/api/threads/${encodeURIComponent(threadId)}/messages`, "POST", body),
    updateFeedbackMessage: (messageId: string, body: FeedbackMessageUpdateRequest) =>
      jsonRequest<FeedbackMessage>(`/api/messages/${encodeURIComponent(messageId)}`, "PATCH", body),
    getFeedbackMessageHistory: (messageId: string) =>
      request<FeedbackMessageVersion[]>(`/api/messages/${encodeURIComponent(messageId)}/history`),
    updateFeedbackThreadStatus: (threadId: string, body: FeedbackThreadStatusPatchRequest) =>
      jsonRequest<FeedbackThread>(`/api/threads/${encodeURIComponent(threadId)}/status`, "PATCH", body)
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "認証の有効期限が切れました。再ログインしてください";
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === "string" && value.error.trim()) return value.error;
  } catch {
    // JSONではないエラー応答はstatusTextへフォールバックする。
  }
  return response.statusText || `フィードバックAPIでエラーが発生しました (${response.status})`;
}
