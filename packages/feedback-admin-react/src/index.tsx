import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode
} from "react";
import type { components } from "@feedback/contracts";
import type { FeedbackTransport } from "@feedback/core";

type Schemas = components["schemas"];
type Session = Schemas["FeedbackSessionV1"];
type Thread = Schemas["FeedbackThreadV1"];
type ExportJob = Schemas["FeedbackExportJob"];
type Member = Schemas["FeedbackWorkspaceMember"];
type Delivery = Schemas["FeedbackNotificationDelivery"];
type ManifestRoute = Schemas["FeedbackApplicationManifestV1"]["routes"][number];

export type FeedbackAdminConsoleProps = {
  transport: FeedbackTransport;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  locale?: string;
  timezone?: string;
  className?: string;
  openExternal?: (url: string) => void;
};

type Tab = "sessions" | "manifest" | "retention" | "memberships" | "notifications";

/** Web GISへ依存せずFeedback Service v1だけで全レビュー管理を行うconsole。 */
export function FeedbackAdminConsole({
  transport,
  applicationKey,
  environmentKey,
  externalWorkspaceKey,
  locale = "ja-JP",
  timezone = "Asia/Tokyo",
  className,
  openExternal = (url) => window.open(url, "_blank", "noopener,noreferrer")
}: FeedbackAdminConsoleProps) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [error, setError] = useState<string | null>(null);
  const scopeQuery = useMemo(() => query({ applicationKey, environmentKey, externalWorkspaceKey }), [
    applicationKey,
    environmentKey,
    externalWorkspaceKey
  ]);
  return (
    <section className={`feedback-admin${className ? ` ${className}` : ""}`}>
      <header><h1>Feedback Admin Console</h1><p>{applicationKey} / {environmentKey} / {externalWorkspaceKey}</p></header>
      <nav aria-label="管理対象">
        {([
          ["sessions", "レビュー"],
          ["manifest", "Manifest"],
          ["retention", "保存・Export"],
          ["memberships", "メンバー"],
          ["notifications", "通知"]
        ] as const).map(([value, label]) => (
          <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </nav>
      {error ? <p className="feedback-admin-error" role="alert">{error}</p> : null}
      {tab === "sessions" ? (
        <SessionAdministration
          transport={transport}
          scopeQuery={scopeQuery}
          applicationKey={applicationKey}
          environmentKey={environmentKey}
          externalWorkspaceKey={externalWorkspaceKey}
          openExternal={openExternal}
          onError={setError}
        />
      ) : null}
      {tab === "manifest" ? (
        <ManifestAdministration transport={transport} applicationKey={applicationKey} onError={setError} />
      ) : null}
      {tab === "retention" ? (
        <RetentionAndExport
          transport={transport}
          scopeQuery={scopeQuery}
          applicationKey={applicationKey}
          environmentKey={environmentKey}
          externalWorkspaceKey={externalWorkspaceKey}
          locale={locale}
          timezone={timezone}
          onError={setError}
        />
      ) : null}
      {tab === "memberships" ? (
        <MembershipAdministration transport={transport} scopeQuery={scopeQuery} onError={setError} />
      ) : null}
      {tab === "notifications" ? (
        <NotificationAdministration transport={transport} scopeQuery={scopeQuery} onError={setError} />
      ) : null}
    </section>
  );
}

function SessionAdministration({
  transport,
  scopeQuery,
  applicationKey,
  environmentKey,
  externalWorkspaceKey,
  openExternal,
  onError
}: {
  transport: FeedbackTransport;
  scopeQuery: string;
  applicationKey: string;
  environmentKey: string;
  externalWorkspaceKey: string;
  openExternal(url: string): void;
  onError(error: string | null): void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [title, setTitle] = useState("");
  const [manifestVersion, setManifestVersion] = useState("1");
  const [scopes, setScopes] = useState('[{"pageKey":"home","routeTemplate":"/","reviewable":true}]');
  const [perspectives, setPerspectives] = useState('[{"code":"quality","label":"品質","status":"active","guidance":null}]');
  const [manifestRoutes, setManifestRoutes] = useState<ManifestRoute[]>([]);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const page = await transport.request<Schemas["FeedbackSessionPage"]>(`/sessions?${scopeQuery}`);
      setSessions(page.value.items);
      setSelectedId((current) => current || page.value.items[0]?.id || "");
      onError(null);
    } catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void transport.request<Schemas["FeedbackApplicationManifestV1"]>(
      `/applications/${encodeURIComponent(applicationKey)}/manifest`
    ).then(
      (resource) => {
        setManifestVersion(resource.value.manifestVersion);
        setManifestRoutes(resource.value.routes);
      },
      (caught) => onError(messageOf(caught))
    );
  }, [applicationKey, onError, transport]);
  useEffect(() => {
    if (!selectedId) { setThreads([]); return; }
    void transport.request<Schemas["FeedbackThreadPage"]>(`/sessions/${selectedId}/threads`).then(
      (page) => setThreads(page.value.items),
      (caught) => onError(messageOf(caught))
    );
  }, [onError, selectedId, transport]);
  useEffect(() => () => { if (evidenceUrl) URL.revokeObjectURL(evidenceUrl); }, [evidenceUrl]);
  const selected = sessions.find((session) => session.id === selectedId);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await transport.request<Session>("/sessions", {
        method: "POST",
        idempotencyKey: idempotencyKey(),
        body: {
          applicationKey,
          environmentKey,
          externalWorkspaceKey,
          manifestVersion,
          title,
          scopes: parseArray(scopes, "scope"),
          perspectives: parseArray(perspectives, "perspective")
        }
      });
      setTitle("");
      await refresh();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const saveSelected = async () => {
    if (!selected) return;
    try {
      await transport.request<Session>(`/sessions/${selected.id}`, {
        method: "PATCH",
        ifMatch: versionEtag(selected.version),
        body: {
          title: selected.title,
          description: selected.description,
          status: selected.status,
          outOfScopePosting: selected.outOfScopePosting,
          startAt: selected.startAt,
          endAt: selected.endAt,
          scopes: selected.scopes,
          perspectives: selected.perspectives
        }
      });
      await refresh();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const patchSessionState = (patch: Partial<Session>) => {
    setSessions((current) => current.map((session) => session.id === selectedId ? { ...session, ...patch } : session));
  };
  const selectedScopes = parseScopeDraft(scopes);
  const toggleManifestRoute = (route: ManifestRoute, checked: boolean) => {
    const retained = selectedScopes.filter((scope) => scope.pageKey !== route.pageKey);
    const next = checked
      ? [...retained, { pageKey: route.pageKey, routeTemplate: route.template, reviewable: true }]
      : retained;
    setScopes(JSON.stringify(next, null, 2));
  };
  const toggleThread = async (thread: Thread) => {
    try {
      await transport.request(`/threads/${thread.id}/status`, {
        method: "PATCH",
        ifMatch: versionEtag(thread.version),
        body: { status: thread.status === "open" ? "resolved" : "open" }
      });
      setSelectedId("");
      queueMicrotask(() => setSelectedId(thread.sessionId));
    } catch (caught) { onError(messageOf(caught)); }
  };
  const showEvidence = async (threadId: string) => {
    try {
      const binary = await transport.requestBinary(`/threads/${threadId}/evidence`);
      if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
      setEvidenceUrl(URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType })));
    } catch (caught) { onError(messageOf(caught)); }
  };
  const openThread = async (threadId: string) => {
    try {
      const resource = await transport.request<Schemas["FeedbackDeepLink"]>(`/threads/${threadId}/deep-link`);
      openExternal(resource.value.url);
    } catch (caught) { onError(messageOf(caught)); }
  };

  return (
    <div className="feedback-admin-grid">
      <form className="feedback-admin-card" onSubmit={(event) => void create(event)}>
        <h2>レビューを作成</h2>
        <label>タイトル<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Manifest version<input required value={manifestVersion} onChange={(event) => setManifestVersion(event.target.value)} /></label>
        <fieldset><legend>Manifest の対象画面</legend>
          {manifestRoutes.map((route) => <label key={route.pageKey}>
            <input
              type="checkbox"
              checked={selectedScopes.some((scope) => scope.pageKey === route.pageKey)}
              onChange={(event) => toggleManifestRoute(route, event.target.checked)}
            />
            {route.label} ({route.template})
          </label>)}
        </fieldset>
        <label>Scope JSON<textarea value={scopes} onChange={(event) => setScopes(event.target.value)} /></label>
        <label>Perspective JSON<textarea value={perspectives} onChange={(event) => setPerspectives(event.target.value)} /></label>
        <button type="submit">作成</button>
      </form>
      <div className="feedback-admin-card">
        <h2>Session / Scope / Perspective</h2>
        <label>Session<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">選択</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
        </select></label>
        {selected ? <>
          <label>タイトル<input value={selected.title} onChange={(event) => patchSessionState({ title: event.target.value })} /></label>
          <label>状態<select value={selected.status} onChange={(event) => patchSessionState({ status: event.target.value as Session["status"] })}>
            <option value="draft">draft</option><option value="open">open</option><option value="closed">closed</option>
          </select></label>
          <label>Scope JSON<textarea value={JSON.stringify(selected.scopes, null, 2)} onChange={(event) => {
            try { patchSessionState({ scopes: JSON.parse(event.target.value) }); } catch { /* 入力途中 */ }
          }} /></label>
          <label>Perspective JSON<textarea value={JSON.stringify(selected.perspectives, null, 2)} onChange={(event) => {
            try { patchSessionState({ perspectives: JSON.parse(event.target.value) }); } catch { /* 入力途中 */ }
          }} /></label>
          <button type="button" onClick={() => void saveSelected()}>Sessionを保存</button>
        </> : null}
      </div>
      <div className="feedback-admin-card">
        <h2>Threads / Evidence</h2>
        {threads.map((thread) => <article key={thread.id}>
          <h3>#{thread.displayNumber} {thread.perspectiveCode}</h3>
          <p>{thread.messages[thread.messages.length - 1]?.body}</p>
          <div className="feedback-admin-actions">
            <button type="button" onClick={() => void openThread(thread.id)}>対象アプリを開く</button>
            <button type="button" onClick={() => void toggleThread(thread)}>{thread.status === "open" ? "resolve" : "reopen"}</button>
            {thread.evidenceAvailable ? <button type="button" onClick={() => void showEvidence(thread.id)}>証跡</button> : null}
          </div>
        </article>)}
        {evidenceUrl ? <img src={evidenceUrl} alt="証跡" /> : null}
      </div>
    </div>
  );
}

function ManifestAdministration({ transport, applicationKey, onError }: {
  transport: FeedbackTransport; applicationKey: string; onError(error: string | null): void;
}) {
  const [manifest, setManifest] = useState("{}");
  const [etag, setEtag] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const resource = await transport.request<Schemas["FeedbackApplicationManifestV1"]>(
        `/applications/${encodeURIComponent(applicationKey)}/manifest`
      );
      setManifest(JSON.stringify(resource.value, null, 2));
      setEtag(resource.etag);
    } catch (caught) { onError(messageOf(caught)); }
  }, [applicationKey, onError, transport]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    try {
      await transport.request(`/applications/${encodeURIComponent(applicationKey)}/manifest`, {
        method: "PUT", ifMatch: etag ?? undefined, body: JSON.parse(manifest)
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-card"><h2>Application Manifest</h2>
    <textarea aria-label="Manifest JSON" value={manifest} onChange={(event) => setManifest(event.target.value)} />
    <button type="button" onClick={() => void save()}>Manifestを保存</button>
  </div>;
}

function RetentionAndExport({
  transport, scopeQuery, applicationKey, environmentKey, externalWorkspaceKey, locale, timezone, onError
}: {
  transport: FeedbackTransport; scopeQuery: string; applicationKey: string; environmentKey: string;
  externalWorkspaceKey: string; locale: string; timezone: string; onError(error: string | null): void;
}) {
  const [policy, setPolicy] = useState<Schemas["FeedbackRetentionPolicy"] | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [job, setJob] = useState<ExportJob | null>(null);
  const load = useCallback(async () => {
    try {
      const resource = await transport.request<Schemas["FeedbackRetentionPolicy"]>(`/retention-policy?${scopeQuery}`);
      setPolicy(resource.value); setEtag(resource.etag);
    } catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!policy || !etag) return;
    try {
      await transport.request(`/retention-policy?${scopeQuery}`, { method: "PATCH", ifMatch: etag, body: policy });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const createExport = async () => {
    try {
      const resource = await transport.request<ExportJob>("/exports", {
        method: "POST", idempotencyKey: idempotencyKey(),
        body: { applicationKey, environmentKey, externalWorkspaceKey, format, locale, timezone }
      });
      setJob(resource.value);
    } catch (caught) { onError(messageOf(caught)); }
  };
  const refreshJob = async () => {
    if (!job) return;
    try { setJob((await transport.request<ExportJob>(`/exports/${job.id}`)).value); }
    catch (caught) { onError(messageOf(caught)); }
  };
  const download = async () => {
    if (!job?.downloadUrl) return;
    try {
      const binary = await transport.requestBinary(`/exports/${job.id}/download`);
      const url = URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `feedback-${job.id}.${format}`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid">
    <div className="feedback-admin-card"><h2>Retention</h2>{policy ? <>
      <label>Evidence days<input type="number" value={policy.evidenceRetentionDays ?? ""} onChange={(event) => setPolicy({ ...policy, evidenceRetentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
      <label>Export days<input type="number" value={policy.exportRetentionDays} onChange={(event) => setPolicy({ ...policy, exportRetentionDays: Number(event.target.value) })} /></label>
      <button type="button" onClick={() => void save()}>保存</button>
    </> : null}</div>
    <div className="feedback-admin-card"><h2>Server-side Export</h2>
      <label>形式<select value={format} onChange={(event) => setFormat(event.target.value as "csv" | "xlsx")}><option value="csv">CSV</option><option value="xlsx">XLSX</option></select></label>
      <div className="feedback-admin-actions"><button type="button" onClick={() => void createExport()}>作成</button>
        {job ? <button type="button" onClick={() => void refreshJob()}>状態更新</button> : null}
        {job?.downloadUrl ? <button type="button" onClick={() => void download()}>Download</button> : null}</div>
      {job ? <p>{job.status} {job.error}</p> : null}
    </div>
  </div>;
}

function MembershipAdministration({ transport, scopeQuery, onError }: {
  transport: FeedbackTransport; scopeQuery: string; onError(error: string | null): void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [issuer, setIssuer] = useState(""); const [subject, setSubject] = useState("");
  const [permissions, setPermissions] = useState("feedback.read");
  const load = useCallback(async () => {
    try { setMembers((await transport.request<Member[]>(`/memberships?${scopeQuery}`)).value); }
    catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await transport.request(`/memberships?${scopeQuery}`, {
        method: "POST", idempotencyKey: idempotencyKey(),
        body: { issuer, subject, permissions: permissionList(permissions) }
      });
      setSubject(""); await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const update = async (member: Member, next: string) => {
    try {
      await transport.request(`/memberships/${member.userId}?${scopeQuery}`, {
        method: "PATCH", ifMatch: versionEtag(member.version), body: { permissions: permissionList(next) }
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const remove = async (member: Member) => {
    try {
      await transport.request(`/memberships/${member.userId}?${scopeQuery}`, {
        method: "DELETE", ifMatch: versionEtag(member.version)
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid"><form className="feedback-admin-card" onSubmit={(event) => void create(event)}>
    <h2>Member追加</h2><label>Issuer<input required value={issuer} onChange={(event) => setIssuer(event.target.value)} /></label>
    <label>Subject<input required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label>Permissions<input value={permissions} onChange={(event) => setPermissions(event.target.value)} /></label><button>追加</button>
  </form><div className="feedback-admin-card"><h2>Memberships</h2>{members.map((member) => <MemberRow key={member.userId} member={member} onSave={update} onDelete={remove} />)}</div></div>;
}

function MemberRow({ member, onSave, onDelete }: { member: Member; onSave(member: Member, value: string): void; onDelete(member: Member): void }) {
  const [value, setValue] = useState(member.permissions.join(","));
  return <article><strong>{member.displayName ?? member.subject}</strong><input aria-label={`${member.subject} permissions`} value={value} onChange={(event) => setValue(event.target.value)} />
    <div className="feedback-admin-actions"><button type="button" onClick={() => onSave(member, value)}>保存</button><button type="button" onClick={() => onDelete(member)}>削除</button></div></article>;
}

function NotificationAdministration({ transport, scopeQuery, onError }: {
  transport: FeedbackTransport; scopeQuery: string; onError(error: string | null): void;
}) {
  const [settings, setSettings] = useState<Schemas["FeedbackNotificationSettings"] | null>(null);
  const [etag, setEtag] = useState<string | null>(null); const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const load = useCallback(async () => {
    try {
      const [settingResource, deliveryResource] = await Promise.all([
        transport.request<Schemas["FeedbackNotificationSettings"]>(`/notification-settings?${scopeQuery}`),
        transport.request<Delivery[]>(`/notification-deliveries?${scopeQuery}`)
      ]);
      setSettings(settingResource.value); setEtag(settingResource.etag); setDeliveries(deliveryResource.value);
    } catch (caught) { onError(messageOf(caught)); }
  }, [onError, scopeQuery, transport]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!settings || !etag) return;
    try { await transport.request(`/notification-settings?${scopeQuery}`, { method: "PATCH", ifMatch: etag, body: settings }); await load(); }
    catch (caught) { onError(messageOf(caught)); }
  };
  const retry = async (id: string) => {
    try { await transport.request(`/notification-deliveries/${id}/retry?${scopeQuery}`, { method: "POST" }); await load(); }
    catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid"><div className="feedback-admin-card"><h2>Webhook設定</h2>{settings ? <>
    <label><input type="checkbox" checked={settings.webhookEnabled} onChange={(event) => setSettings({ ...settings, webhookEnabled: event.target.checked })} />有効</label>
    <label>Endpoint<input value={settings.webhookEndpoint ?? ""} onChange={(event) => setSettings({ ...settings, webhookEndpoint: event.target.value || null })} /></label>
    <label><input type="checkbox" checked={settings.includeBody} onChange={(event) => setSettings({ ...settings, includeBody: event.target.checked })} />本文を含める</label>
    <label><input type="checkbox" checked={settings.includeEvidence} onChange={(event) => setSettings({ ...settings, includeEvidence: event.target.checked })} />証跡URLを含める</label>
    <button type="button" onClick={() => void save()}>保存</button></> : null}</div>
    <div className="feedback-admin-card"><h2>配送 / Dead letter</h2>{deliveries.map((delivery) => <article key={delivery.id}><strong>{delivery.eventType}</strong> {delivery.status} ({delivery.attemptCount})
      {delivery.lastError ? <p>{delivery.lastError}</p> : null}{delivery.status === "failed" ? <button type="button" onClick={() => void retry(delivery.id)}>再送</button> : null}</article>)}</div></div>;
}

export class FeedbackAdminErrorBoundary extends Component<{
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.props.onError?.(error, info); }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}

function query(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
function parseArray(value: string, name: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} JSONは配列で指定してください`);
  return parsed;
}

function parseScopeDraft(value: string): Array<{ pageKey: string; routeTemplate?: string; reviewable: boolean }> {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { pageKey: string; routeTemplate?: string; reviewable: boolean } =>
      item != null && typeof item === "object" && typeof item.pageKey === "string"
    );
  } catch {
    return [];
  }
}
function permissionList(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function idempotencyKey(): string { return `feedback-admin-${crypto.randomUUID()}`; }
function versionEtag(version: number): string { return `"v${version}"`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type { FeedbackTransport } from "@feedback/core";
