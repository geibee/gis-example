import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackAdminConsole, FeedbackAdminErrorBoundary } from "@feedback/admin-react";
import { createFeedbackTransport } from "@feedback/core";
import { getAccessToken, getUserManager, refreshAccessToken } from "./auth";
import "@feedback/admin-react/styles.css";

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
  if (authenticated === null) return <p>認証状態を確認しています</p>;
  if (!authenticated) return <main><h1>Feedback Admin Console</h1>{error ? <p role="alert">{error}</p> : null}
    <button type="button" onClick={() => {
      rememberPendingScope();
      void getUserManager().signinRedirect();
    }}>OIDCでログイン</button></main>;
  return <main>
    <div><button type="button" onClick={() => void getUserManager().signoutRedirect()}>ログアウト</button></div>
    <FeedbackAdminConsole
      transport={transport}
      applicationKey={scope.applicationKey}
      environmentKey={scope.environmentKey}
      externalWorkspaceKey={scope.workspaceKey}
    />
  </main>;
}

const pendingScopeStorageKey = "feedback-admin.pending-scope";

function rememberPendingScope() {
  const source = new URLSearchParams(window.location.search);
  const safe = new URLSearchParams();
  ["applicationKey", "environmentKey", "workspaceKey"].forEach((key) => {
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
      required("VITE_FEEDBACK_ADMIN_WORKSPACE_KEY", import.meta.env.VITE_FEEDBACK_ADMIN_WORKSPACE_KEY)
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
      <main><h1>Feedback Admin Console</h1><p role="alert">管理画面を起動できませんでした。</p></main>
    }>
      <AdminApplication />
    </FeedbackAdminErrorBoundary>
  </StrictMode>
);
