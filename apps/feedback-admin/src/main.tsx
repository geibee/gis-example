import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackAdminConsole, FeedbackAdminErrorBoundary } from "@feedback/admin-react";
import { createFeedbackTransport } from "@feedback/core";
import { getAccessToken, getUserManager, refreshAccessToken } from "./auth";
import "@feedback/admin-react/styles.css";
import "./styles.css";

function AdminApplication() {
  const scope = adminScope(new URLSearchParams(window.location.search));
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const manager = getUserManager();
        if (window.location.search.includes("code=") && window.location.search.includes("state=")) {
          await manager.signinRedirectCallback();
          const pendingScope = readPendingScope();
          window.history.replaceState({}, "", `${window.location.pathname}${pendingScope ? `?${pendingScope}` : ""}`);
        }
        setAuthenticated(Boolean(await getAccessToken()));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setAuthenticated(false);
      }
    })();
  }, []);
  const transport = useMemo(() => createFeedbackTransport({
    baseUrl: import.meta.env.VITE_FEEDBACK_API_BASE || "/feedback/v1",
    getAccessToken,
    refreshAccessToken,
    fetch: (url, init) => fetch(url, init)
  }), []);
  if (authenticated === null) return <main className="feedback-admin-loading"><span className="feedback-admin-loading-mark">F</span><p>認証状態を確認しています</p></main>;
  if (!authenticated) return <main className="feedback-admin-login"><section><span className="feedback-admin-brand-mark">F</span><p className="feedback-admin-kicker">Feedback workspace</p><h1>フィードバック管理</h1><p>レビューの準備、確認状況、メンバー、通知を一か所で管理します。</p>{error ? <p className="feedback-admin-login-error" role="alert">{error}</p> : null}
    <button className="feedback-admin-login-button" type="button" onClick={() => {
      rememberPendingScope();
      void getUserManager().signinRedirect();
    }}>ログインして管理を始める</button><small>組織のアカウントで安全にログインします</small></section></main>;
  return <main className="feedback-admin-page">
    <div className="feedback-admin-toolbar"><span><span className="feedback-admin-brand-mark is-small">F</span>Feedback Console</span><button type="button" onClick={() => void getUserManager().signoutRedirect()}>ログアウト</button></div>
    <FeedbackAdminConsole
      transport={transport}
      applicationKey={scope.applicationKey}
      environmentKey={scope.environmentKey}
      externalWorkspaceKey={scope.workspaceKey}
      initialAction={scope.action}
    />
  </main>;
}

const pendingScopeStorageKey = "feedback-admin.pending-scope";

function rememberPendingScope() {
  const source = new URLSearchParams(window.location.search);
  const safe = new URLSearchParams();
  ["applicationKey", "environmentKey", "workspaceKey", "action"].forEach((key) => {
    const value = normalized(source.get(key));
    if (value) safe.set(key, value);
  });
  try {
    window.sessionStorage.setItem(pendingScopeStorageKey, safe.toString());
  } catch {
    // storage無効時はbuild時既定scopeへ戻す。
  }
}

function readPendingScope(): string {
  try {
    const value = window.sessionStorage.getItem(pendingScopeStorageKey) ?? "";
    window.sessionStorage.removeItem(pendingScopeStorageKey);
    return value;
  } catch {
    return "";
  }
}

function adminScope(search: URLSearchParams) {
  return {
    applicationKey: normalized(search.get("applicationKey")) ??
      required("VITE_FEEDBACK_ADMIN_APPLICATION_KEY", import.meta.env.VITE_FEEDBACK_ADMIN_APPLICATION_KEY),
    environmentKey: normalized(search.get("environmentKey")) ??
      required("VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY", import.meta.env.VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY),
    workspaceKey: normalized(search.get("workspaceKey")) ??
      required("VITE_FEEDBACK_ADMIN_WORKSPACE_KEY", import.meta.env.VITE_FEEDBACK_ADMIN_WORKSPACE_KEY),
    action: search.get("action") === "create-review" ? "create-review" as const : undefined
  };
}

function normalized(value: string | null): string | null {
  const result = value?.trim();
  return result && result.length <= 200 ? result : null;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackAdminErrorBoundary fallback={
      <main className="feedback-admin-login"><section><h1>フィードバック管理</h1><p role="alert">管理画面を起動できませんでした。</p></section></main>
    }>
      <AdminApplication />
    </FeedbackAdminErrorBoundary>
  </StrictMode>
);
