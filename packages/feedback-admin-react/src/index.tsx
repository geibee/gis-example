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
type BackupPolicy = Schemas["FeedbackBackupPolicy"];
type BackupPolicyView = Schemas["FeedbackBackupPolicyView"];
type BackupRun = Schemas["FeedbackBackupRun"];
type Member = Schemas["FeedbackWorkspaceMember"];
type Delivery = Schemas["FeedbackNotificationDelivery"];
type ConnectorType = Schemas["FeedbackConnectorType"];
type NotificationConnector = Schemas["FeedbackNotificationConnector"];
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
      <header><h1>フィードバック管理</h1><p className="feedback-admin-scope">対象: {applicationKey} / {environmentKey} / {externalWorkspaceKey}</p><p className="feedback-admin-help">レビュー、メンバー、通知、保存設定を管理します。</p></header>
      <nav aria-label="管理対象">
        {([
          ["sessions", "レビュー"],
          ["manifest", "アプリ設定"],
          ["retention", "保存・エクスポート"],
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
  const [threadStatus, setThreadStatus] = useState<"" | "open" | "resolved">("");
  const [threadPerspective, setThreadPerspective] = useState("");
  const [threadEvidence, setThreadEvidence] = useState<"" | "with" | "without">("");
  const [threadSearch, setThreadSearch] = useState("");
  const [title, setTitle] = useState("");
  const [manifestVersion, setManifestVersion] = useState("1");
  const [scopes, setScopes] = useState('[{"pageKey":"home","routeTemplate":"/","reviewable":true}]');
  const [perspectives, setPerspectives] = useState('[{"code":"quality","label":"品質","status":"active","guidance":null}]');
  const [perspectiveCode, setPerspectiveCode] = useState("quality");
  const [perspectiveLabel, setPerspectiveLabel] = useState("品質");
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
  const visibleSessions = sessions;
  const visibleThreads = threads.filter((thread) => {
    if (threadStatus && thread.status !== threadStatus) return false;
    if (threadPerspective && thread.perspectiveCode !== threadPerspective) return false;
    if (threadEvidence === "with" && !thread.evidenceAvailable) return false;
    if (threadEvidence === "without" && thread.evidenceAvailable) return false;
    if (threadSearch && !thread.messages.some((message) => message.body.toLowerCase().includes(threadSearch.toLowerCase()))) return false;
    return true;
  });

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
  const toggleSelectedRoute = (route: ManifestRoute, checked: boolean) => {
    if (!selected) return;
    const retained = selected.scopes.filter((scope) => scope.pageKey !== route.pageKey);
    const next = checked
      ? [...retained, { pageKey: route.pageKey, routeTemplate: route.template, reviewable: true }]
      : retained;
    patchSessionState({ scopes: next });
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
    <div className="feedback-admin-review-layout">
      <aside className="feedback-admin-card feedback-admin-session-sidebar">
        <div className="feedback-admin-sidebar-heading"><h2>レビューセッション</h2><button type="button" onClick={() => document.getElementById("feedback-admin-create")?.scrollIntoView({ behavior: "smooth" })}>新規作成</button></div>
        <label>セッションを検索<input type="search" placeholder="タイトルを検索" onChange={(event) => { const value = event.target.value.toLowerCase(); document.querySelectorAll<HTMLElement>("[data-session-title]").forEach((item) => { item.hidden = value !== "" && !item.dataset.sessionTitle!.includes(value); }); }} /></label>
        <ul className="feedback-admin-session-list">{visibleSessions.map((session) => <li key={session.id} data-session-title={session.title.toLowerCase()}><button type="button" className={session.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(session.id)}><strong>{session.title}</strong><span>{sessionStatusLabel(session.status)}</span></button></li>)}</ul>
        {visibleSessions.length === 0 ? <p className="feedback-admin-help">レビューセッションはまだありません。</p> : null}
      </aside>
      <div className="feedback-admin-review-main">
      <form id="feedback-admin-create" className="feedback-admin-card feedback-admin-create-form" onSubmit={(event) => void create(event)}>
        <h2>レビューを作成</h2>
        <label>タイトル<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>アプリ設定のバージョン<input required value={manifestVersion} onChange={(event) => setManifestVersion(event.target.value)} /></label>
        <fieldset><legend>レビュー対象の画面</legend>
          {manifestRoutes.map((route) => <label key={route.pageKey}>
            <input
              type="checkbox"
              checked={selectedScopes.some((scope) => scope.pageKey === route.pageKey)}
              onChange={(event) => toggleManifestRoute(route, event.target.checked)}
            />
            {route.label} ({route.template})
          </label>)}
        </fieldset>
        <p className="feedback-admin-help">レビュー対象の画面を選択してください。選択した画面だけがレビュー対象になります。</p>
        <div className="feedback-admin-inline-form"><label>観点コード<input value={perspectiveCode} onChange={(event) => setPerspectiveCode(event.target.value)} /></label><label>表示名<input value={perspectiveLabel} onChange={(event) => setPerspectiveLabel(event.target.value)} /></label><button type="button" onClick={() => setPerspectives(JSON.stringify([{ code: perspectiveCode.trim(), label: perspectiveLabel.trim(), status: "active", guidance: null }], null, 2))}>観点を反映</button></div>
        <details className="feedback-admin-advanced"><summary>詳細設定（JSON）</summary><p className="feedback-admin-help">通常は変更不要です。外部連携や高度な設定を行う場合のみ編集してください。</p><label>対象画面の設定<textarea value={scopes} onChange={(event) => setScopes(event.target.value)} /></label><label>レビュー観点の設定<textarea value={perspectives} onChange={(event) => setPerspectives(event.target.value)} /></label></details>
        <button type="submit">作成</button>
      </form>
      <div className="feedback-admin-card feedback-admin-card-wide">
        <h2>レビューを編集</h2>
        <label>レビュー<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">選択</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
        </select></label>
        {selected ? <>
          <label>タイトル<input value={selected.title} onChange={(event) => patchSessionState({ title: event.target.value })} /></label>
          <label>状態<select value={selected.status} onChange={(event) => patchSessionState({ status: event.target.value as Session["status"] })}>
            <option value="draft">下書き</option><option value="open">公開中</option><option value="closed">終了</option>
          </select></label>
          <fieldset><legend>レビュー対象の画面</legend><p className="feedback-admin-help">アプリに登録されている画面から選択してください。</p>{manifestRoutes.map((route) => <label key={route.pageKey}><input type="checkbox" checked={selected.scopes.some((scope) => scope.pageKey === route.pageKey)} onChange={(event) => toggleSelectedRoute(route, event.target.checked)} />{route.label} <code>{route.template}</code></label>)}</fieldset>
          <details className="feedback-admin-advanced"><summary>観点・対象画面の詳細設定（JSON）</summary><label>対象画面<textarea value={JSON.stringify(selected.scopes, null, 2)} onChange={(event) => {
            try { patchSessionState({ scopes: JSON.parse(event.target.value) }); } catch { /* 入力途中 */ }
          }} /></label><label>レビュー観点<textarea value={JSON.stringify(selected.perspectives, null, 2)} onChange={(event) => {
            try { patchSessionState({ perspectives: JSON.parse(event.target.value) }); } catch { /* 入力途中 */ }
          }} /></label></details>
          <button type="button" onClick={() => void saveSelected()}>変更を保存</button>
        </> : null}
      </div>
      <div className="feedback-admin-card feedback-admin-card-wide">
        <h2>スレッドと証跡</h2>
        <form className="feedback-admin-thread-filters" onSubmit={(event) => event.preventDefault()}><label>状態<select value={threadStatus} onChange={(event) => setThreadStatus(event.target.value as typeof threadStatus)}><option value="">すべて</option><option value="open">未解決</option><option value="resolved">解決済み</option></select></label><label>観点<select value={threadPerspective} onChange={(event) => setThreadPerspective(event.target.value)}><option value="">すべて</option>{selected?.perspectives.map((perspective) => <option key={perspective.code} value={perspective.code}>{perspective.label ?? perspective.code}</option>)}</select></label><label>証跡<select value={threadEvidence} onChange={(event) => setThreadEvidence(event.target.value as typeof threadEvidence)}><option value="">すべて</option><option value="with">証跡あり</option><option value="without">証跡なし</option></select></label><label>コメント本文<input type="search" placeholder="コメントを検索" value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} /></label></form>
        {visibleThreads.map((thread) => <article className="feedback-admin-thread" key={thread.id}>
          <h3>#{thread.displayNumber} {thread.perspectiveCode}</h3>
          <p>{thread.messages[thread.messages.length - 1]?.body}</p>
          <div className="feedback-admin-actions">
            <button type="button" onClick={() => void openThread(thread.id)}>対象アプリを開く</button>
            <button type="button" onClick={() => void toggleThread(thread)}>{thread.status === "open" ? "対応済みにする" : "再オープン"}</button>
            {thread.evidenceAvailable ? <button type="button" onClick={() => void showEvidence(thread.id)}>証跡</button> : null}
          </div>
        </article>)}
        {visibleThreads.length === 0 ? <p className="feedback-admin-help">条件に一致するフィードバックはありません。</p> : null}{evidenceUrl ? <img src={evidenceUrl} alt="証跡" /> : null}
      </div>
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
  return <div className="feedback-admin-card"><h2>アプリ設定</h2><p className="feedback-admin-help">レビュー対象として表示する画面の定義です。通常は変更不要です。</p>
    <details className="feedback-admin-advanced" open><summary>詳細設定（JSON）</summary><textarea aria-label="Manifest JSON" value={manifest} onChange={(event) => setManifest(event.target.value)} />
    <button type="button" onClick={() => void save()}>アプリ設定を保存</button></details>
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
  const [backupPolicy, setBackupPolicy] = useState<BackupPolicy | null>(null);
  const [backupPolicyView, setBackupPolicyView] = useState<BackupPolicyView | null>(null);
  const [backupEtag, setBackupEtag] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRun[]>([]);
  const load = useCallback(async () => {
    try {
      const [retention, backup, runs] = await Promise.all([
        transport.request<Schemas["FeedbackRetentionPolicy"]>(`/retention-policy?${scopeQuery}`),
        transport.request<BackupPolicyView>(`/backup-policy?${scopeQuery}`),
        transport.request<Schemas["FeedbackBackupRunPage"]>(`/backups?${scopeQuery}`)
      ]);
      setPolicy(retention.value); setEtag(retention.etag);
      setBackupPolicy(backup.value.policy); setBackupPolicyView(backup.value); setBackupEtag(backup.etag);
      setBackups(runs.value.items);
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
  const saveBackupPolicy = async () => {
    if (!backupPolicy || !backupEtag) return;
    try {
      await transport.request(`/backup-policy?${scopeQuery}`, {
        method: "PATCH", ifMatch: backupEtag, body: backupPolicy
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const downloadBackup = async (backup: BackupRun) => {
    if (!backup.downloadUrl) return;
    try {
      const binary = await transport.requestBinary(`/backups/${backup.id}/download`);
      const url = URL.createObjectURL(new Blob([binary.bytes.slice().buffer as ArrayBuffer], { type: binary.contentType }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `feedback-backup-${backup.id}.zip`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) { onError(messageOf(caught)); }
  };
  const retryBackup = async (backup: BackupRun) => {
    try {
      await transport.request(`/backups/${backup.id}/retry?${scopeQuery}`, { method: "POST" });
      await load();
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
    <div className="feedback-admin-card"><h2>保存期間</h2>{policy ? <>
      <label>証跡の保存日数（空欄は無期限）<input type="number" min={1} value={policy.evidenceRetentionDays ?? ""} onChange={(event) => setPolicy({ ...policy, evidenceRetentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
      <label>エクスポートの保存日数<input type="number" min={1} value={policy.exportRetentionDays} onChange={(event) => setPolicy({ ...policy, exportRetentionDays: Number(event.target.value) })} /></label>
      <button type="button" onClick={() => void save()}>保存</button>
    </> : null}</div>
    <div className="feedback-admin-card"><h2>データをエクスポート</h2><p className="feedback-admin-help">レビュー記録をファイルとして出力します。</p>
      <label>ファイル形式<select value={format} onChange={(event) => setFormat(event.target.value as "csv" | "xlsx")}><option value="csv">CSV（表計算ソフト向け）</option><option value="xlsx">Excel（XLSX）</option></select></label>
      <div className="feedback-admin-actions"><button type="button" onClick={() => void createExport()}>エクスポートを作成</button>
        {job ? <button type="button" onClick={() => void refreshJob()}>状態を更新</button> : null}
        {job?.downloadUrl ? <button type="button" onClick={() => void download()}>ファイルをダウンロード</button> : null}</div>
      {job ? <p>{job.status} {job.error}</p> : null}
    </div>
    <div className="feedback-admin-card"><h2>自動証跡バックアップ</h2>{backupPolicy ? <>
      <label><input type="checkbox" checked={backupPolicy.enabled} onChange={(event) => setBackupPolicy({ ...backupPolicy, enabled: event.target.checked })} />有効</label>
      <label>タイムゾーン<input value={backupPolicy.timezone} onChange={(event) => setBackupPolicy({ ...backupPolicy, timezone: event.target.value })} /></label>
      <label>日次フル実行時刻<input type="time" value={backupPolicy.fullBackupAt} onChange={(event) => setBackupPolicy({ ...backupPolicy, fullBackupAt: event.target.value })} /></label>
      <label>差分間隔（分）<input type="number" min={15} max={1440} value={backupPolicy.incrementalIntervalMinutes} onChange={(event) => setBackupPolicy({ ...backupPolicy, incrementalIntervalMinutes: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={backupPolicy.includeEvidence} onChange={(event) => setBackupPolicy({ ...backupPolicy, includeEvidence: event.target.checked })} />証跡画像を含める</label>
      <label>保存日数（空欄は無期限）<input type="number" value={backupPolicy.retentionDays ?? ""} onChange={(event) => setBackupPolicy({ ...backupPolicy, retentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
      <dl>
        <dt>次回実行</dt><dd>{backupPolicyView?.nextExecutionAt ? new Date(backupPolicyView.nextExecutionAt).toLocaleString(locale) : "停止中"}</dd>
        <dt>次回フル</dt><dd>{backupPolicyView?.nextFullAt ? new Date(backupPolicyView.nextFullAt).toLocaleString(locale) : "-"}</dd>
        <dt>次回差分</dt><dd>{backupPolicyView?.nextIncrementalAt ? new Date(backupPolicyView.nextIncrementalAt).toLocaleString(locale) : "-"}</dd>
        <dt>最終成功</dt><dd>{backupPolicyView?.lastSuccessfulAt ? new Date(backupPolicyView.lastSuccessfulAt).toLocaleString(locale) : "未実行"}</dd>
        <dt>変更 / 監査カーソル</dt><dd>{backupPolicyView?.changeCursor ?? 0} / {backupPolicyView?.auditCursor ?? 0}</dd>
      </dl>
      <button type="button" onClick={() => void saveBackupPolicy()}>バックアップ方針を保存</button>
    </> : null}</div>
    <div className="feedback-admin-card"><h2>バックアップ履歴</h2>{backups.map((backup) => <article key={backup.id}>
      <strong>{backup.kind}</strong> {backup.status} {new Date(backup.scheduledFor).toLocaleString(locale)}
      {backup.archiveSha256 ? <code>{backup.archiveSha256.slice(0, 16)}…</code> : null}
      <p>変更 {backup.fromChangeSequence} → {backup.toChangeSequence ?? "-"} / 監査 {backup.fromAuditSequence} → {backup.toAuditSequence ?? "-"}</p>
      {backup.error ? <p>{backup.error}</p> : null}
      <div className="feedback-admin-actions">
        {backup.downloadUrl ? <button type="button" onClick={() => void downloadBackup(backup)}>ZIPを取得</button> : null}
        {backup.status === "failed" ? <button type="button" onClick={() => void retryBackup(backup)}>再試行</button> : null}
      </div>
    </article>)}</div>
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
    <h2>メンバーを追加</h2><p className="feedback-admin-help">ログインに使う発行者とユーザーIDを入力してください。</p><label>発行者（Issuer）<input required value={issuer} onChange={(event) => setIssuer(event.target.value)} /></label>
    <label>ユーザーID（Subject）<input required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label>権限（カンマ区切り）<input value={permissions} onChange={(event) => setPermissions(event.target.value)} /><small>例: feedback.read, feedback.comment</small></label><button>追加</button>
  </form><div className="feedback-admin-card"><h2>メンバー一覧</h2>{members.map((member) => <MemberRow key={member.userId} member={member} onSave={update} onDelete={remove} />)}</div></div>;
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
  const [connectorTypes, setConnectorTypes] = useState<ConnectorType[]>([]);
  const [connectors, setConnectors] = useState<NotificationConnector[]>([]);
  const [connectorType, setConnectorType] = useState("");
  const [connectorName, setConnectorName] = useState("");
  const [destinationRef, setDestinationRef] = useState("");
  const load = useCallback(async () => {
    try {
      const [settingResource, deliveryResource, typeResource, connectorResource] = await Promise.all([
        transport.request<Schemas["FeedbackNotificationSettings"]>(`/notification-settings?${scopeQuery}`),
        transport.request<Delivery[]>(`/notification-deliveries?${scopeQuery}`),
        transport.request<ConnectorType[]>(`/connector-types?${scopeQuery}`),
        transport.request<NotificationConnector[]>(`/notification-connectors?${scopeQuery}`)
      ]);
      setSettings(settingResource.value); setEtag(settingResource.etag); setDeliveries(deliveryResource.value);
      setConnectorTypes(typeResource.value); setConnectors(connectorResource.value);
      setConnectorType((current) => current || typeResource.value.find((type) => type.enabled)?.key || "");
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
  const createConnector = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await transport.request(`/notification-connectors?${scopeQuery}`, {
        method: "POST",
        body: { connectorType, name: connectorName, destinationRef, enabled: true, includeBody: false }
      });
      setConnectorName(""); setDestinationRef(""); await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const toggleConnector = async (connector: NotificationConnector) => {
    try {
      await transport.request(`/notification-connectors/${connector.id}?${scopeQuery}`, {
        method: "PATCH", ifMatch: versionEtag(connector.version),
        body: { name: connector.name, destinationRef: connector.destinationRef, enabled: !connector.enabled, includeBody: connector.includeBody }
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  const removeConnector = async (connector: NotificationConnector) => {
    try {
      await transport.request(`/notification-connectors/${connector.id}?${scopeQuery}`, {
        method: "DELETE", ifMatch: versionEtag(connector.version)
      });
      await load();
    } catch (caught) { onError(messageOf(caught)); }
  };
  return <div className="feedback-admin-grid"><div className="feedback-admin-card"><h2>通知設定</h2>{settings ? <>
    <p>互換用の旧Webhook設定です。新規連携は通知コネクタを使用してください。</p>
    <label><input type="checkbox" checked={settings.webhookEnabled} onChange={(event) => setSettings({ ...settings, webhookEnabled: event.target.checked })} />有効</label>
    <label>Webhook URL<input type="url" placeholder="https://example.invalid/webhook" value={settings.webhookEndpoint ?? ""} onChange={(event) => setSettings({ ...settings, webhookEndpoint: event.target.value || null })} /></label>
    <label><input type="checkbox" checked={settings.includeBody} onChange={(event) => setSettings({ ...settings, includeBody: event.target.checked })} />本文を含める</label>
    <label><input type="checkbox" checked={settings.includeEvidence} onChange={(event) => setSettings({ ...settings, includeEvidence: event.target.checked })} />旧互換フラグ（コネクタ配送では証跡を送信しません）</label>
    <button type="button" onClick={() => void save()}>保存</button></> : null}</div>
    <form className="feedback-admin-card" onSubmit={(event) => void createConnector(event)}><h2>通知コネクタを追加</h2>
      <label>種別<select required value={connectorType} onChange={(event) => setConnectorType(event.target.value)}>
        <option value="">選択</option>{connectorTypes.filter((type) => type.enabled).map((type) => <option key={type.key} value={type.key}>{type.displayName}</option>)}
      </select></label>
      <label>表示名<input required value={connectorName} onChange={(event) => setConnectorName(event.target.value)} /></label>
      <label>接続先の参照名<input required value={destinationRef} onChange={(event) => setDestinationRef(event.target.value)} /><small>サーバー側で登録した接続先の名前です。</small></label>
      <button type="submit">追加</button>
    </form>
    <div className="feedback-admin-card"><h2>登録済みの通知先</h2>{connectors.map((connector) => <article key={connector.id}>
      <strong>{connector.name}</strong> {connector.displayName} / {connector.destinationRef} / {connector.enabled ? "有効" : "無効"}
      <p>接続状態: {connector.healthStatus}{connector.healthCheckedAt ? ` (${new Date(connector.healthCheckedAt).toLocaleString()})` : ""}</p>
      {connector.healthError ? <p>{connector.healthError}</p> : null}
      <div className="feedback-admin-actions"><button type="button" onClick={() => void toggleConnector(connector)}>{connector.enabled ? "無効化" : "有効化"}</button><button type="button" onClick={() => void removeConnector(connector)}>削除</button></div>
    </article>)}</div>
    <div className="feedback-admin-card"><h2>通知の配送履歴</h2>{deliveries.map((delivery) => <article key={delivery.id}><strong>{delivery.eventType}</strong> {delivery.status === "failed" ? "失敗" : delivery.status === "delivered" ? "成功" : delivery.status === "processing" ? "処理中" : "待機中"} ({delivery.attemptCount}回)
      {delivery.connectorName ? <span> / {delivery.connectorName}</span> : null}
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
function sessionStatusLabel(value: Session["status"]): string {
  return value === "open" ? "受付中" : value === "closed" ? "終了" : "下書き";
}
function idempotencyKey(): string { return `feedback-admin-${crypto.randomUUID()}`; }
function versionEtag(version: number): string { return `"v${version}"`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type { FeedbackTransport } from "@feedback/core";
