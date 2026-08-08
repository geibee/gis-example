import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { components } from "@feedback/contracts";
import type { FeedbackEvidencePayload } from "@feedback/core";
import { createDomEvidenceProvider } from "./capture.js";
import { useFeedback } from "./index.js";

type Schemas = components["schemas"];
type Thread = Schemas["FeedbackThreadV1"];
type Message = Schemas["FeedbackMessageV1"];
type MessageVersion = Schemas["FeedbackMessageVersionV1"];
type Target = Schemas["FeedbackTargetV1"];

export const feedbackElementKeyAttribute = "data-feedback-key";
export const feedbackExcludeAttribute = "data-feedback-exclude";
export const feedbackMaskAttribute = "data-feedback-mask";

export type FeedbackOverlayProps = {
  deepLinkThreadId?: string | null;
  className?: string;
};

/** v1 transport だけを使う汎用 Overlay。ホストの router/API/TanStack Query へ依存しない。 */
export function FeedbackOverlay({ deepLinkThreadId, className }: FeedbackOverlayProps) {
  const feedback = useFeedback();
  const session = feedback.reviewContext?.session ?? null;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<{ thread: Thread; etag: string | null } | null>(null);
  const [composeTarget, setComposeTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canRead = permissions.includes("feedback.read");
  const canComment = permissions.includes("feedback.comment");
  const posting = feedback.reviewContext?.posting ?? "deny";

  const refreshThreads = useCallback(async () => {
    if (!session || !canRead) {
      setThreads([]);
      return;
    }
    try {
      const page = await feedback.transport.request<Schemas["FeedbackThreadPage"]>(
        `/sessions/${encodeURIComponent(session.id)}/threads`
      );
      setThreads(page.value.items);
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  }, [canRead, feedback.transport, session]);

  useEffect(() => { void refreshThreads(); }, [refreshThreads]);
  useEffect(() => {
    setThreads([]);
    setActive(null);
    setComposeTarget(null);
  }, [session?.id]);

  const openThread = useCallback(async (threadId: string, navigate: boolean) => {
    if (!canRead) return;
    try {
      const resource = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(threadId)}`);
      if (navigate) await feedback.adapter.navigate(resource.value.location, resource.value.id);
      setActive({ thread: resource.value, etag: resource.etag });
      setError(null);
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  }, [canRead, feedback.adapter, feedback.transport]);

  useEffect(() => {
    if (deepLinkThreadId) void openThread(deepLinkThreadId, true);
  }, [deepLinkThreadId, openThread]);

  useEffect(() => {
    if (
      feedback.features.contextMenu !== true ||
      !feedback.location ||
      !session ||
      !canComment ||
      posting === "deny"
    ) return;
    const handleContextMenu = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-feedback-overlay]")) return;
      const element = event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${feedbackElementKeyAttribute}]`)
        : null;
      event.preventDefault();
      setComposeTarget(element ? elementTarget(element, event) : screenTarget(event));
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, [canComment, feedback.features.contextMenu, feedback.location, posting, session]);

  if (feedback.state !== "ready" || !feedback.location || !session) return null;
  const visibleThreads = threads.filter((thread) => feedbackThreadMatchesLocation(thread, feedback.location!));
  const content = (
    <div className={`feedback-overlay-root${className ? ` ${className}` : ""}`} data-feedback-overlay="">
      {canComment && posting !== "deny" ? (
        <button
          type="button"
          className="feedback-launcher"
          onClick={() => setComposeTarget({
            schemaVersion: "1",
            kind: "screen-position",
            relativeX: 0.5,
            relativeY: 0.5
          })}
        >
          {feedback.messages.launcher}
        </button>
      ) : null}
      {canComment && posting === "deny" ? (
        <p className="feedback-posting-notice" role="status">{feedback.messages.postingDenied}</p>
      ) : null}
      <DomPins threads={visibleThreads} onOpen={(id) => void openThread(id, false)} />
      <ScreenPins threads={visibleThreads} onOpen={(id) => void openThread(id, false)} />
      {composeTarget ? (
        <Composer
          target={composeTarget}
          onClose={() => setComposeTarget(null)}
          onCreated={(thread) => {
            setThreads((current) => [...current.filter((item) => item.id !== thread.id), thread]);
            setComposeTarget(null);
          }}
        />
      ) : null}
      {active ? (
        <ThreadDrawer
          resource={active}
          onChange={(next) => {
            setActive(next);
            setThreads((current) => current.map((item) => item.id === next.thread.id ? next.thread : item));
          }}
          onClose={() => setActive(null)}
        />
      ) : null}
      {error ? <p className="feedback-panel feedback-error" role="alert">{error}</p> : null}
    </div>
  );
  const target = feedback.portalTarget ?? (typeof document === "undefined" ? null : document.body);
  return target ? createPortal(content, target) : content;
}

export function feedbackThreadMatchesLocation(
  thread: Pick<Thread, "location">,
  location: Schemas["FeedbackLocationV1"]
): boolean {
  return thread.location.pageKey === location.pageKey &&
    thread.location.routeTemplate === location.routeTemplate &&
    equalParameters(thread.location.pathParameters, location.pathParameters) &&
    equalParameters(thread.location.queryParameters ?? {}, location.queryParameters ?? {});
}

function equalParameters(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function Composer({
  target,
  onClose,
  onCreated
}: {
  target: Target;
  onClose(): void;
  onCreated(thread: Thread): void;
}) {
  const feedback = useFeedback();
  const session = feedback.reviewContext?.session;
  const [body, setBody] = useState("");
  const [perspective, setPerspective] = useState(session?.perspectives.find((item) => item.status === "active")?.code ?? "");
  const [participantName, setParticipantName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{ idempotencyKey: string; body: Record<string, unknown> } | null>(null);

  useEffect(() => {
    void Promise.resolve(feedback.adapter.getParticipantName?.() ?? null).then((value) => setParticipantName(value ?? ""));
  }, [feedback.adapter]);
  useEffect(() => { pendingRequest.current = null; }, [body, participantName, perspective, target]);

  if (!session || !feedback.location || !feedback.hostContext) return null;
  const hostContext = feedback.hostContext;
  const location = feedback.location;
  const prompt = feedback.reviewContext?.participantPolicy.mode !== "authenticated-identity";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || !perspective || (prompt && !participantName.trim())) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!pendingRequest.current) {
        let evidence: FeedbackEvidencePayload | null = null;
        if (feedback.features.evidenceCapture !== false) {
          try {
            evidence = await (feedback.adapter.captureEvidence ?? createDomEvidenceProvider({
              maxBytes: feedback.reviewContext?.evidencePolicy.maxBytes
            }))({
              context: hostContext,
              location,
              target,
              excludeSelector: `[${feedbackExcludeAttribute}], [data-feedback-overlay]`,
              maskSelector: `[${feedbackMaskAttribute}]`
            });
          } catch (captureError) {
            feedback.telemetry?.increment("capture_failure", hostContext);
            setError(`証跡を取得できなかったためコメントのみ投稿します: ${messageOf(captureError)}`);
          }
        }
        pendingRequest.current = {
          idempotencyKey: idempotencyKey(),
          body: {
            location,
            target,
            perspectiveCode: perspective,
            body: body.trim(),
            participantName: participantName.trim() || null,
            ...(evidence ? { evidence: evidenceBody(evidence) } : {})
          }
        };
      }
      const pending = pendingRequest.current!;
      const resource = await feedback.transport.request<Thread>(
        `/sessions/${encodeURIComponent(session.id)}/threads`,
        {
          method: "POST",
          idempotencyKey: pending.idempotencyKey,
          body: pending.body
        }
      );
      pendingRequest.current = null;
      feedback.telemetry?.increment("post_success", hostContext);
      await feedback.adapter.setParticipantName?.(participantName.trim() || null);
      onCreated(resource.value);
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="feedback-panel" aria-label={feedback.messages.launcher} onSubmit={(event) => void submit(event)}>
      <button type="button" onClick={onClose}>{feedback.messages.close}</button>
      {feedback.reviewContext?.posting === "warn" ? (
        <p className="feedback-warning" role="status">{feedback.messages.postingWarning}</p>
      ) : null}
      <label>{feedback.messages.comment}<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <label>
        観点
        <select value={perspective} onChange={(event) => setPerspective(event.target.value)}>
          {session.perspectives.filter((item) => item.status === "active").map((item) => (
            <option value={item.code} key={item.code}>{item.label}</option>
          ))}
        </select>
      </label>
      {prompt ? (
        <label>{feedback.messages.participantName}<input value={participantName} onChange={(event) => setParticipantName(event.target.value)} /></label>
      ) : null}
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <button type="submit" disabled={submitting}>{feedback.messages.submit}</button>
    </form>
  );
}

function ThreadDrawer({
  resource,
  onChange,
  onClose
}: {
  resource: { thread: Thread; etag: string | null };
  onChange(value: { thread: Thread; etag: string | null }): void;
  onClose(): void;
}) {
  const feedback = useFeedback();
  const [reply, setReply] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const thread = resource.thread;
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canComment = permissions.includes("feedback.comment");
  const canManage = permissions.includes("feedback.manage") || permissions.includes("feedback.admin");
  useEffect(() => {
    void Promise.resolve(feedback.adapter.getParticipantName?.() ?? null).then((value) => setParticipantName(value ?? ""));
  }, [feedback.adapter]);
  useEffect(() => () => { if (evidenceUrl) URL.revokeObjectURL(evidenceUrl); }, [evidenceUrl]);

  const refresh = async () => {
    const next = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(thread.id)}`);
    onChange({ thread: next.value, etag: next.etag });
  };
  const postReply = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await feedback.transport.request<Message>(`/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: "POST",
        idempotencyKey: idempotencyKey(),
        body: { body: reply.trim(), participantName: participantName.trim() || null }
      });
      await feedback.adapter.setParticipantName?.(participantName.trim() || null);
      setReply("");
      await refresh();
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  };
  const toggleStatus = async () => {
    try {
      const next = await feedback.transport.request<Thread>(`/threads/${encodeURIComponent(thread.id)}/status`, {
        method: "PATCH",
        ifMatch: resource.etag ?? versionEtag(thread.version),
        body: { status: thread.status === "open" ? "resolved" : "open" }
      });
      onChange({ thread: next.value, etag: next.etag });
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  };
  const showEvidence = async () => {
    try {
      const evidence = await feedback.transport.requestBinary(`/threads/${encodeURIComponent(thread.id)}/evidence`);
      if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
      setEvidenceUrl(URL.createObjectURL(new Blob([evidence.bytes.slice().buffer as ArrayBuffer], { type: evidence.contentType })));
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  };
  return (
    <section className="feedback-panel" aria-label={feedback.messages.threads}>
      <button type="button" onClick={onClose}>{feedback.messages.close}</button>
      <h2>#{thread.displayNumber} {thread.perspectiveCode}</h2>
      {thread.messages.map((message) => (
        <MessageItem message={message} key={message.id} onUpdated={() => void refresh()} />
      ))}
      {thread.status === "open" && canComment ? (
        <form onSubmit={(event) => void postReply(event)}>
          <label>{feedback.messages.participantName}<input value={participantName} onChange={(event) => setParticipantName(event.target.value)} /></label>
          <label>{feedback.messages.comment}<textarea value={reply} onChange={(event) => setReply(event.target.value)} /></label>
          <button type="submit" disabled={!reply.trim()}>{feedback.messages.reply}</button>
        </form>
      ) : null}
      <div className="feedback-actions">
        {canManage ? (
          <button type="button" onClick={() => void toggleStatus()}>
            {thread.status === "open" ? feedback.messages.resolve : feedback.messages.reopen}
          </button>
        ) : null}
        {thread.evidenceAvailable ? <button type="button" onClick={() => void showEvidence()}>{feedback.messages.evidence}</button> : null}
      </div>
      {evidenceUrl ? <img src={evidenceUrl} alt={feedback.messages.evidence} /> : null}
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
    </section>
  );
}

function MessageItem({ message, onUpdated }: { message: Message; onUpdated(): void }) {
  const feedback = useFeedback();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);
  const [versions, setVersions] = useState<MessageVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const permissions = feedback.reviewContext?.permissions ?? [];
  const canManage = permissions.includes("feedback.manage") || permissions.includes("feedback.admin");
  const canEdit = canManage || principalId === message.author.principalId;
  useEffect(() => {
    let active = true;
    void feedback.adapter.getIdentity?.().then((identity) => {
      if (active) setPrincipalId(identity?.principalId ?? null);
    });
    return () => { active = false; };
  }, [feedback.adapter]);
  const save = async () => {
    try {
      await feedback.transport.request<Message>(`/messages/${encodeURIComponent(message.id)}`, {
        method: "PATCH",
        ifMatch: versionEtag(message.version),
        body: { body: body.trim(), participantName: message.author.participantName ?? null }
      });
      setEditing(false);
      onUpdated();
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  };
  const history = async () => {
    try {
      setVersions((await feedback.transport.request<MessageVersion[]>(
        `/messages/${encodeURIComponent(message.id)}/versions`
      )).value);
    } catch (nextError) {
      setError(messageOf(nextError));
    }
  };
  return (
    <article className="feedback-message">
      <strong>{message.author.participantName ?? message.author.displayName ?? message.author.principalId}</strong>
      {editing ? <textarea value={body} onChange={(event) => setBody(event.target.value)} /> : <p>{message.body}</p>}
      <div className="feedback-actions">
        {canEdit ? (editing
          ? <button type="button" onClick={() => void save()}>{feedback.messages.save}</button>
          : <button type="button" onClick={() => setEditing(true)}>{feedback.messages.edit}</button>) : null}
        <button type="button" onClick={() => void history()}>{feedback.messages.history}</button>
      </div>
      {versions?.map((version) => <p key={version.version}>v{version.version}: {version.body}</p>)}
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
    </article>
  );
}

function DomPins({ threads, onOpen }: { threads: Thread[]; onOpen(id: string): void }) {
  const portals = useMemo(() => threads.flatMap((thread) => {
    const target = thread.target;
    if (target.kind !== "ui-element") return [];
    const element = Array.from(document.querySelectorAll<HTMLElement>(`[${feedbackElementKeyAttribute}]`))
      .find((candidate) => candidate.getAttribute(feedbackElementKeyAttribute) === target.elementKey);
    return element ? [{ thread, element }] : [];
  }), [threads]);
  return <Fragment>{portals.map(({ thread, element }) => createPortal(
    <button type="button" className="feedback-dom-pin" onClick={() => onOpen(thread.id)}>#{thread.displayNumber}</button>,
    element,
    thread.id
  ))}</Fragment>;
}

function ScreenPins({ threads, onOpen }: { threads: Thread[]; onOpen(id: string): void }) {
  const screenThreads = threads.filter((thread) => thread.target.kind === "screen-position");
  if (screenThreads.length === 0) return null;
  return <div className="feedback-screen-pins">{screenThreads.map((thread) => (
    <button type="button" className="feedback-thread-pin" key={thread.id} onClick={() => onOpen(thread.id)}>
      #{thread.displayNumber}
    </button>
  ))}</div>;
}

function elementTarget(element: HTMLElement, event: MouseEvent): Target {
  const rect = element.getBoundingClientRect();
  return {
    schemaVersion: "1",
    kind: "ui-element",
    elementKey: element.getAttribute(feedbackElementKeyAttribute) ?? "",
    relativeX: clamp((event.clientX - rect.left) / Math.max(rect.width, 1)),
    relativeY: clamp((event.clientY - rect.top) / Math.max(rect.height, 1))
  };
}

function screenTarget(event: MouseEvent): Target {
  return {
    schemaVersion: "1",
    kind: "screen-position",
    relativeX: clamp(event.clientX / Math.max(document.documentElement.clientWidth, 1)),
    relativeY: clamp(event.clientY / Math.max(document.documentElement.clientHeight, 1))
  };
}

function evidenceBody(value: FeedbackEvidencePayload) {
  return {
    contentType: value.contentType,
    dataBase64: bytesToBase64(value.bytes),
    viewportWidth: value.viewportWidth,
    viewportHeight: value.viewportHeight,
    pixelRatio: value.pixelRatio,
    capturedAt: value.capturedAt
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function idempotencyKey(): string {
  return `feedback-${globalThis.crypto.randomUUID()}`;
}

function versionEtag(version: number): string {
  return `"v${version}"`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LocalStorageParticipantAdapter = {
  getParticipantName(): string | null;
  setParticipantName(value: string | null): void;
};

/** localStorage は明示 opt-in の identity adapter としてだけ提供する。 */
export function createLocalStorageParticipantAdapter(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "feedback.participant-name"
): LocalStorageParticipantAdapter {
  return {
    getParticipantName: () => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setParticipantName: (value) => {
      try {
        if (value) storage.setItem(key, value.slice(0, 100));
        else storage.removeItem(key);
      } catch {
        // storage 無効時もメモリ内の入力で投稿を継続する。
      }
    }
  };
}
