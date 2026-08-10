import type { components as FeedbackComponents } from "@feedback/contracts";
import { createFeedbackTransport, FeedbackTransportError } from "@feedback/core";
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
import type { FeedbackApiClient, FeedbackApiClientOptions } from "./api";
import { FeedbackApiError } from "./api";
import type { FeedbackRouteDefinition } from "./routes";

type Schemas = FeedbackComponents["schemas"];
type SessionV1 = Schemas["FeedbackSessionV1"];
type ThreadV1 = Schemas["FeedbackThreadV1"];
type MessageV1 = Schemas["FeedbackMessageV1"];
type MessageVersionV1 = Schemas["FeedbackMessageVersionV1"];
type MeV1 = Schemas["FeedbackMe"];
type ThreadCreateRequestV1 = Schemas["FeedbackThreadCreateRequest"];

export type FeedbackV1ApiClientOptions = FeedbackApiClientOptions & {
  applicationKey: string;
  environmentKey: string;
  routes: readonly FeedbackRouteDefinition[];
  createIdempotencyKey?: () => string;
};

/** Phase 4 の互換 adapter。旧 UI の型を Feedback API v1 との境界だけで変換する。 */
export function createFeedbackV1ApiClient(options: FeedbackV1ApiClientOptions): FeedbackApiClient {
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const transport = createFeedbackTransport({
    baseUrl: options.apiBaseUrl,
    getAccessToken: async () => (await options.getAccessToken()) ?? null,
    refreshAccessToken: options.refreshAccessToken
      ? async () => (await options.refreshAccessToken?.()) ?? null
      : undefined,
    fetch: requestFetch
  });
  const threadEtags = new Map<string, string>();
  const messageEtags = new Map<string, string>();
  const perspectiveLabels = new Map<string, string>();
  const routeLabels = new Map(options.routes.map((route) => [route.pageId, route.label]));
  const sessionWorkspaces = new Map<string, string>();
  const sessionLoads = new Map<string, Promise<void>>();
  let activeWorkspace = "";
  let compatibilityCheck: Promise<void> | null = null;

  const ensureCompatible = () => {
    compatibilityCheck ??= transport.getCapabilities().then(() => undefined);
    return compatibilityCheck;
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      await ensureCompatible();
      return await operation();
    } catch (error) {
      if (error instanceof FeedbackTransportError) {
        if (error.status === 401) {
          options.onNotification?.({
            type: "unauthorized",
            message: "認証の有効期限が切れました。再ログインしてください"
          });
        }
        throw new FeedbackApiError(error.status, error.message);
      }
      throw error;
    }
  };
  const newIdempotencyKey = () => {
    const value = options.createIdempotencyKey?.() ?? `feedback-${globalThis.crypto.randomUUID()}`;
    if (value.length < 16) throw new Error("Idempotency-Key は16文字以上で生成してください");
    return value;
  };
  const rememberMessage = (message: MessageV1, etag?: string | null) => {
    messageEtags.set(message.id, etag ?? versionEtag(message.version));
    return toLegacyMessage(message);
  };
  const rememberSession = (session: SessionV1) => {
    session.perspectives.forEach((item) => {
      perspectiveLabels.set(`${session.id}:${item.code}`, item.label);
    });
    sessionWorkspaces.set(session.id, session.externalWorkspaceKey);
  };
  const ensurePerspectiveLabel = async (thread: ThreadV1) => {
    if (perspectiveLabels.has(`${thread.sessionId}:${thread.perspectiveCode}`)) return;
    let load = sessionLoads.get(thread.sessionId);
    if (!load) {
      load = transport.request<SessionV1>(`/sessions/${encodeURIComponent(thread.sessionId)}`)
        .then(({ value }) => { rememberSession(value); });
      sessionLoads.set(thread.sessionId, load);
    }
    await load;
  };
  const rememberThread = async (thread: ThreadV1, etag?: string | null) => {
    await ensurePerspectiveLabel(thread);
    threadEtags.set(thread.id, etag ?? versionEtag(thread.version));
    thread.messages.forEach((message) => messageEtags.set(message.id, versionEtag(message.version)));
    return toLegacyThread(thread, perspectiveLabels, sessionWorkspaces.get(thread.sessionId) ?? activeWorkspace);
  };

  return {
    getMe: () => run(async () => toLegacyMe((await transport.request<MeV1>("/me")).value)),
    getReviewSessions: (projectId, status) => run(async () => {
      activeWorkspace = projectId;
      const query = queryString({
        applicationKey: options.applicationKey,
        environmentKey: options.environmentKey,
        externalWorkspaceKey: projectId,
        status
      });
      const page = (await transport.request<Schemas["FeedbackSessionPage"]>(`/sessions?${query}`)).value;
      page.items.forEach(rememberSession);
      return page.items.map((session) => toLegacySession(session, routeLabels));
    }),
    getFeedbackThreads: (reviewSessionId) => run(async () => {
      const page = (await transport.request<Schemas["FeedbackThreadPage"]>(
        `/sessions/${encodeURIComponent(reviewSessionId)}/threads`
      )).value;
      return await Promise.all(page.items.map((thread) => rememberThread(thread)));
    }),
    getFeedbackThread: (threadId) => run(async () => {
      const resource = await transport.request<ThreadV1>(`/threads/${encodeURIComponent(threadId)}`);
      return await rememberThread(resource.value, resource.etag);
    }),
    createFeedbackThread: (reviewSessionId, metadata, screenshot) => run(async () => {
      const request = await toThreadCreateRequest(metadata, screenshot, options.routes);
      const resource = await transport.request<ThreadV1>(
        `/sessions/${encodeURIComponent(reviewSessionId)}/threads`,
        { method: "POST", body: request, idempotencyKey: newIdempotencyKey() }
      );
      return await rememberThread(resource.value, resource.etag);
    }),
    createFeedbackMessage: (threadId, body) => run(async () => {
      const resource = await transport.request<MessageV1>(
        `/threads/${encodeURIComponent(threadId)}/messages`,
        { method: "POST", body, idempotencyKey: newIdempotencyKey() }
      );
      return rememberMessage(resource.value, resource.etag);
    }),
    updateFeedbackMessage: (messageId, body) => run(async () => {
      const ifMatch = messageEtags.get(messageId);
      if (!ifMatch) throw new FeedbackApiError(428, "編集前に最新のスレッドを取得してください");
      const resource = await transport.request<MessageV1>(`/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        body,
        ifMatch
      });
      return rememberMessage(resource.value, resource.etag);
    }),
    getFeedbackMessageHistory: (messageId) => run(async () => {
      const versions = (await transport.request<MessageVersionV1[]>(
        `/messages/${encodeURIComponent(messageId)}/versions`
      )).value;
      return versions.map(toLegacyMessageVersion);
    }),
    updateFeedbackThreadStatus: (threadId, body) => run(async () => {
      const ifMatch = threadEtags.get(threadId);
      if (!ifMatch) throw new FeedbackApiError(428, "更新前に最新のスレッドを取得してください");
      const resource = await transport.request<ThreadV1>(`/threads/${encodeURIComponent(threadId)}/status`, {
        method: "PATCH",
        body: { status: body.status === "OPEN" ? "open" : "resolved" },
        ifMatch
      });
      return await rememberThread(resource.value, resource.etag);
    })
  };
}

function toLegacyMe(value: MeV1): Me {
  const admin = value.memberships.some((membership) => membership.permissions.includes("feedback.admin"));
  return {
    userId: value.participant.principalId,
    subject: value.participant.principalId,
    email: null,
    displayName: value.participant.displayName ?? null,
    systemRole: admin ? "admin" : "user",
    memberships: value.memberships.map((membership) => ({
      projectId: membership.externalWorkspaceKey,
      role: membership.permissions.some((permission) =>
        permission === "feedback.comment" || permission === "feedback.manage" || permission === "feedback.admin"
      ) ? "editor" : "viewer",
      permissions: membership.permissions
    }))
  };
}

function toLegacySession(value: SessionV1, routeLabels: ReadonlyMap<string, string>): ReviewSession {
  return {
    id: value.id,
    projectId: value.externalWorkspaceKey,
    title: value.title,
    description: value.description ?? null,
    status: value.status,
    startAt: value.startAt ?? null,
    endAt: value.endAt ?? null,
    evidenceRetentionDays: null,
    effectiveEvidenceRetentionDays: null,
    createdBy: null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    perspectives: value.perspectives.map((perspective, index) => ({
      code: perspective.code,
      label: perspective.label,
      description: null,
      displayOrder: index,
      status: perspective.status === "active"
        ? "ACTIVE"
        : perspective.status === "future" ? "FUTURE" : "OUT_OF_SCOPE",
      guidance: perspective.guidance ?? null
    })),
    scopes: value.scopes.map((scope, index) => ({
      id: `${value.id}:${scope.pageKey}`,
      pageId: scope.pageKey,
      route: scope.routeTemplate ?? null,
      description: routeLabels.get(scope.pageKey) ?? null,
      reviewable: scope.reviewable,
      displayOrder: index,
      perspectiveCodes: scope.perspectiveCodes ?? []
    }))
  };
}

function toLegacyThread(value: ThreadV1, labels: Map<string, string>, projectId: string): FeedbackThread {
  const target = toLegacyTarget(value.target);
  return {
    id: value.id,
    displayNumber: value.displayNumber,
    projectId,
    reviewSessionId: value.sessionId,
    reviewScopeId: null,
    pageRoute: concreteRoute(value.location),
    perspectiveCode: value.perspectiveCode,
    perspectiveLabel: labels.get(`${value.sessionId}:${value.perspectiveCode}`) ?? "その他の観点",
    targetType: target.type,
    targetMetadata: target,
    evidence: null,
    status: value.status === "open" ? "OPEN" : "RESOLVED",
    createdBy: value.reporter.principalId,
    createdByName: value.reporter.displayName ?? null,
    reporterName: value.reporter.participantName ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages: value.messages.map(toLegacyMessage)
  };
}

function toLegacyMessage(value: MessageV1): FeedbackMessage {
  return {
    id: value.id,
    threadId: value.threadId,
    authorId: value.author.principalId,
    authorName: value.author.displayName ?? null,
    participantName: value.author.participantName ?? null,
    body: value.body,
    createdAt: value.createdAt,
    editedAt: value.editedAt ?? null
  };
}

function toLegacyMessageVersion(value: MessageVersionV1): FeedbackMessageVersion {
  return {
    messageId: value.id,
    version: value.version,
    body: value.body,
    editedBy: value.author.principalId,
    editedByName: value.author.displayName ?? null,
    editedByParticipantName: value.author.participantName ?? null,
    createdAt: value.editedAt ?? value.createdAt,
    current: value.current
  };
}

async function toThreadCreateRequest(
  metadata: FeedbackThreadCreateMetadata,
  screenshot: Blob | null,
  routes: readonly FeedbackRouteDefinition[]
): Promise<ThreadCreateRequestV1> {
  const pageKey = metadata.pageId?.trim();
  const route = routes.find((candidate) => candidate.pageId === pageKey);
  if (!pageKey || !route) throw new Error("現在画面が application manifest に登録されていません");
  const concrete = new URL(metadata.route ?? route.path, "https://feedback-location.invalid");
  const pathParameters = extractPathParameters(route.path, concrete.pathname);
  const queryParameters = Object.fromEntries(
    [...concrete.searchParams.entries()].filter(([name]) => route.queryParameters?.[name]?.persistence === "store")
  );
  return {
    location: {
      schemaVersion: "1",
      pageKey,
      routeTemplate: route.path,
      pathParameters,
      queryParameters
    },
    target: toV1Target(metadata.targetType, metadata.target),
    perspectiveCode: metadata.perspectiveCode,
    body: metadata.body,
    participantName: metadata.participantName ?? null,
    ...(screenshot ? { evidence: await toEvidence(metadata, screenshot) } : {})
  };
}

async function toEvidence(metadata: FeedbackThreadCreateMetadata, screenshot: Blob) {
  if (!metadata.viewportWidth || !metadata.viewportHeight || !metadata.pixelRatio || !metadata.capturedAt) {
    throw new Error("証跡の viewport/capturedAt が不足しています");
  }
  const contentType = evidenceContentType(screenshot.type);
  return {
    contentType,
    dataBase64: bytesToBase64(new Uint8Array(await screenshot.arrayBuffer())),
    viewportWidth: metadata.viewportWidth,
    viewportHeight: metadata.viewportHeight,
    pixelRatio: metadata.pixelRatio,
    capturedAt: metadata.capturedAt
  };
}

function evidenceContentType(value: string): "image/png" | "image/webp" {
  if (value === "image/png" || value === "image/webp") return value;
  throw new Error(`未対応の証跡 content-type です: ${value}`);
}

function toV1Target(
  targetType: FeedbackThreadCreateMetadata["targetType"],
  raw: Record<string, unknown>
): Schemas["FeedbackTargetV1"] {
  const number = (key: string) => {
    const value = raw[key];
    if (typeof value !== "number") throw new Error(`target.${key} が数値ではありません`);
    return value;
  };
  const string = (key: string) => {
    const value = raw[key];
    if (typeof value !== "string" || !value) throw new Error(`target.${key} が文字列ではありません`);
    return value;
  };
  switch (targetType) {
    case "UI_ELEMENT":
      return {
        schemaVersion: "1", kind: "ui-element", elementKey: string("feedbackTargetId"),
        relativeX: number("relativeX"), relativeY: number("relativeY")
      };
    case "SCREEN_POSITION":
      return {
        schemaVersion: "1", kind: "screen-position",
        relativeX: number("relativeX"), relativeY: number("relativeY")
      };
    case "MAP_FEATURE":
      return {
        schemaVersion: "1", kind: "map-feature", provider: "maplibre",
        sourceKey: string("source"),
        ...(typeof raw.sourceLayer === "string" ? { sourceLayer: raw.sourceLayer } : {}),
        featureKey: string("featureId"), longitude: number("longitude"), latitude: number("latitude")
      };
    case "MAP_POSITION":
      return {
        schemaVersion: "1", kind: "map-position",
        longitude: number("longitude"), latitude: number("latitude")
      };
  }
}

function toLegacyTarget(value: Schemas["FeedbackTargetV1"]): FeedbackThread["targetMetadata"] & {
  type: FeedbackThread["targetType"];
} {
  switch (value.kind) {
    case "ui-element":
      return {
        type: "UI_ELEMENT", feedbackTargetId: value.elementKey,
        relativeX: value.relativeX, relativeY: value.relativeY
      };
    case "screen-position":
      return { type: "SCREEN_POSITION", relativeX: value.relativeX, relativeY: value.relativeY };
    case "map-feature":
      return {
        type: "MAP_FEATURE", source: value.sourceKey, sourceLayer: value.sourceLayer,
        featureId: value.featureKey, longitude: value.longitude, latitude: value.latitude
      };
    case "map-position":
      return { type: "MAP_POSITION", longitude: value.longitude, latitude: value.latitude };
  }
}

function extractPathParameters(template: string, pathname: string): Record<string, string> {
  const templateSegments = segments(template);
  const pathSegments = segments(pathname);
  if (templateSegments.length !== pathSegments.length) throw new Error("現在URLが manifest の route template と一致しません");
  const values: Record<string, string> = {};
  templateSegments.forEach((segment, index) => {
    const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
    if (match) values[match[1]] = decodeURIComponent(pathSegments[index]);
    else if (segment !== pathSegments[index]) throw new Error("現在URLが manifest の route template と一致しません");
  });
  return values;
}

function concreteRoute(location: Schemas["FeedbackLocationV1"]): string {
  let route = location.routeTemplate;
  Object.entries(location.pathParameters).forEach(([key, value]) => {
    route = route.replace(`{${key}}`, encodeURIComponent(String(value)));
  });
  const query = queryString(Object.fromEntries(
    Object.entries(location.queryParameters ?? {}).map(([key, value]) => [key, String(value)])
  ));
  return query ? `${route}?${query}` : route;
}

function queryString(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined) query.set(key, value); });
  return query.toString();
}

function segments(path: string): string[] {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return normalized === "/" ? [] : normalized.replace(/^\//, "").split("/");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function versionEtag(version: number): string {
  return `"v${version}"`;
}
