import {
  feedbackApiMajorVersion,
  type FeedbackCapabilities,
  type FeedbackHostContextV1,
  type FeedbackLocationV1,
  type FeedbackProblem,
  type FeedbackReviewContextV1
} from "@feedback/contracts";

export type FeedbackTokenGetter = () => string | null | Promise<string | null>;
export type FeedbackTokenRefresher = () => Promise<string | null>;

export type FeedbackFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
};

export type FeedbackFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FeedbackFetchResponse>;

export type FeedbackRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
};

export type FeedbackResource<T> = { value: T; etag: string | null };

export interface FeedbackTransport {
  request<T>(path: string, options?: FeedbackRequestOptions): Promise<FeedbackResource<T>>;
  requestBinary(path: string, options?: FeedbackBinaryRequestOptions): Promise<FeedbackBinaryResource>;
  getCapabilities(): Promise<FeedbackCapabilities>;
  getReviewContext(context: FeedbackHostContextV1, location: FeedbackLocationV1): Promise<FeedbackReviewContextV1>;
}

export type FeedbackBinaryResource = {
  bytes: Uint8Array;
  contentType: string;
  etag: string | null;
  contentRange: string | null;
};

export type FeedbackBinaryRequestOptions = { range?: string };

export type FeedbackTransportOptions = {
  baseUrl: string;
  getAccessToken: FeedbackTokenGetter;
  refreshAccessToken?: FeedbackTokenRefresher;
  fetch: FeedbackFetch;
};

export class FeedbackTransportError extends Error {
  readonly status: number;
  readonly problem: FeedbackProblem | null;

  constructor(status: number, problem: FeedbackProblem | null, fallbackMessage: string) {
    super(problem?.detail ?? problem?.title ?? fallbackMessage);
    this.name = "FeedbackTransportError";
    this.status = status;
    this.problem = problem;
  }
}

export class FeedbackCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackCompatibilityError";
  }
}

export function createFeedbackTransport(options: FeedbackTransportOptions): FeedbackTransport {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  let refreshInFlight: Promise<string | null> | null = null;

  const refreshOnce = (): Promise<string | null> => {
    if (!options.refreshAccessToken) return Promise.resolve(null);
    if (!refreshInFlight) {
      refreshInFlight = options.refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  };

  const request = async <T>(path: string, requestOptions: FeedbackRequestOptions = {}): Promise<FeedbackResource<T>> => {
    const perform = async (token: string | null) => {
      const method = requestOptions.method ?? "GET";
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (requestOptions.body !== undefined) {
        headers["Content-Type"] = method === "PATCH" ? "application/merge-patch+json" : "application/json";
      }
      if (requestOptions.idempotencyKey) headers["Idempotency-Key"] = requestOptions.idempotencyKey;
      if (requestOptions.ifMatch) headers["If-Match"] = requestOptions.ifMatch;
      return options.fetch(`${baseUrl}${normalizePath(path)}`, {
        method,
        headers,
        ...(requestOptions.body !== undefined ? { body: JSON.stringify(requestOptions.body) } : {})
      });
    };

    let response = await perform(await options.getAccessToken());
    if (response.status === 401 && options.refreshAccessToken) {
      const refreshed = await refreshOnce();
      if (refreshed) response = await perform(refreshed);
    }
    if (!response.ok) {
      throw new FeedbackTransportError(response.status, await readProblem(response), response.statusText);
    }
    return {
      value: await response.json() as T,
      etag: response.headers.get("ETag")
    };
  };

  const getCapabilities = async () => {
    const { value } = await request<FeedbackCapabilities>("/capabilities");
    assertCompatibleCapabilities(value);
    return value;
  };

  const requestBinary = async (
    path: string,
    requestOptions: FeedbackBinaryRequestOptions = {}
  ): Promise<FeedbackBinaryResource> => {
    const perform = async (token: string | null) => {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (requestOptions.range) headers.Range = requestOptions.range;
      return options.fetch(`${baseUrl}${normalizePath(path)}`, { method: "GET", headers });
    };
    let response = await perform(await options.getAccessToken());
    if (response.status === 401 && options.refreshAccessToken) {
      const refreshed = await refreshOnce();
      if (refreshed) response = await perform(refreshed);
    }
    if (!response.ok) {
      throw new FeedbackTransportError(response.status, await readProblem(response), response.statusText);
    }
    if (!response.arrayBuffer) throw new Error("Feedback fetch adapter が binary response に対応していません");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
      etag: response.headers.get("ETag"),
      contentRange: response.headers.get("Content-Range")
    };
  };

  const getReviewContext = async (context: FeedbackHostContextV1, location: FeedbackLocationV1) => {
    const query = encodeQuery({
      applicationKey: context.applicationKey,
      environmentKey: context.environmentKey,
      externalWorkspaceKey: context.externalWorkspaceKey,
      release: context.release,
      locale: context.locale,
      pageKey: location.pageKey,
      routeTemplate: location.routeTemplate,
      pathParameters: JSON.stringify(location.pathParameters),
      queryParameters: location.queryParameters ? JSON.stringify(location.queryParameters) : undefined
    });
    return (await request<FeedbackReviewContextV1>(`/review-context?${query}`)).value;
  };

  return { request, requestBinary, getCapabilities, getReviewContext };
}

export function assertCompatibleCapabilities(capabilities: FeedbackCapabilities): void {
  if (capabilities.apiMajorVersion !== feedbackApiMajorVersion) {
    throw new FeedbackCompatibilityError(
      `Feedback API major version ${capabilities.apiMajorVersion} は SDK major version ${feedbackApiMajorVersion} と互換性がありません`
    );
  }
  if (!capabilities.manifestSchemaVersions.includes("1") || !capabilities.targetSchemaVersions.includes("1")) {
    throw new FeedbackCompatibilityError("Feedback Service が必要な manifest/target schema v1 を提供していません");
  }
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function encodeQuery(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function readProblem(response: FeedbackFetchResponse): Promise<FeedbackProblem | null> {
  try {
    const value = await response.json();
    if (isProblem(value)) return value;
  } catch {
    // Problem Details でない応答は statusText へフォールバックする。
  }
  return null;
}

function isProblem(value: unknown): value is FeedbackProblem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const problem = value as Record<string, unknown>;
  return typeof problem.type === "string" && typeof problem.title === "string" &&
    typeof problem.status === "number" && typeof problem.code === "string" && typeof problem.requestId === "string";
}
