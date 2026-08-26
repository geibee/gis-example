import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Building2,
  FileText,
  LogOut,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Users
} from "lucide-react";
import { useAuth } from "react-oidc-context";
import { createFeedbackTransport, FeedbackTransportError } from "@feedback/core";
import {
  FeedbackOverlay,
  FeedbackPluginProvider,
  useFeedbackPlugin,
  type FeedbackPluginNotification
} from "@web-gis/feedback-plugin";
import { AppShellProvider, useAppShell } from "./appShell";
import { getAccessToken, notifyUnauthorized, tryRenewAccessToken } from "./auth";
import { MapStateProvider } from "./mapState";
import { MapPaneHost } from "./components/MapPaneHost";
import { notifyError, notifySuccess } from "./notifications";
import { ConfirmDialogHost } from "./ui/ConfirmDialog";
import { Toaster } from "./ui/Toaster";
import { activeScreenMeta, tabBasePath } from "./routeMeta";
import { hasProjectPermission, reviewManagePermission } from "./permissions";
import type { BusinessTab } from "./appTypes";
import type { Me } from "./contracts";
import { feedbackApplicationManifest, feedbackRoutes } from "./appRoutes";
import { buildFeedbackAdminUrl } from "./feedbackAdminLink";
import { resolveWebGisFeedbackThread } from "./feedbackHostAdapter";
import { syncFeedbackApplicationManifest } from "./feedbackManifestSync";

// ルートレイアウト。認証・レイアウト・ルーター配置のみを担い、
// サーバ状態は TanStack Query (src/queries/)、画面固有の状態は各 src/screens/、
// 横断状態は AppShellProvider / MapStateProvider が持つ。
export default function App() {
  return (
    <AppShellProvider>
      <FeedbackSdkHost>
        <MapStateProvider>
          <AppLayout />
        </MapStateProvider>
      </FeedbackSdkHost>
    </AppShellProvider>
  );
}

function FeedbackSdkHost({ children }: { children: ReactNode }) {
  const { selectedProject } = useAppShell();
  const queryClient = useQueryClient();
  const currentPath = useRouterState({ select: (state) => state.location.pathname });
  const feedbackApiBaseUrl = (import.meta.env.VITE_FEEDBACK_API_BASE ?? "/feedback/v1").replace(/\/$/, "");
  const [manifestRevision, setManifestRevision] = useState(0);
  useEffect(() => {
    const configuredApplicationKey = import.meta.env.VITE_FEEDBACK_APPLICATION_KEY ?? "web-gis";
    if (configuredApplicationKey !== feedbackApplicationManifest.applicationKey) {
      console.warn("Feedback画面定義を同期できません: applicationKeyがホストのmanifestと一致しません");
      return;
    }
    let active = true;
    const transport = createFeedbackTransport({
      baseUrl: feedbackApiBaseUrl,
      getAccessToken: () => getAccessToken() ?? null,
      refreshAccessToken: async () => await tryRenewAccessToken() ?? null,
      fetch: window.fetch.bind(window)
    });
    let retryTimer: number | undefined;
    const synchronize = async (attempt: number): Promise<void> => {
      try {
        const result = await syncFeedbackApplicationManifest(transport, feedbackApplicationManifest);
        if (active && result !== "unchanged") setManifestRevision((value) => value + 1);
      } catch (caught) {
        if (active && attempt < 4 && isTemporaryManifestSyncError(caught)) {
          retryTimer = window.setTimeout(() => void synchronize(attempt + 1), 1_000 * 2 ** attempt);
          return;
        }
        // 画面定義の同期失敗で業務画面を停止しない。Feedback SDK側は従来どおりfail-closedになる。
        console.warn("Feedback画面定義を同期できません", caught);
      }
    };
    void synchronize(0);
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [feedbackApiBaseUrl]);
  return (
    <FeedbackPluginProvider
      key={manifestRevision}
      apiMode="feedback-v1"
      apiBaseUrl={feedbackApiBaseUrl}
      applicationKey={import.meta.env.VITE_FEEDBACK_APPLICATION_KEY ?? "web-gis"}
      environmentKey={import.meta.env.VITE_FEEDBACK_ENVIRONMENT_KEY ?? "local"}
      projectId={selectedProject}
      appVersion={import.meta.env.VITE_APP_VERSION ?? "dev"}
      routes={feedbackRoutes}
      currentPath={currentPath}
      getAccessToken={getAccessToken}
      refreshAccessToken={tryRenewAccessToken}
      onNotification={handleFeedbackNotification}
      queryClient={queryClient}
    >
      {children}
    </FeedbackPluginProvider>
  );
}

function isTemporaryManifestSyncError(caught: unknown): boolean {
  return caught instanceof TypeError ||
    (caught instanceof FeedbackTransportError && [404, 429, 502, 503, 504].includes(caught.status));
}

function handleFeedbackNotification(notification: FeedbackPluginNotification) {
  if (notification.type === "success") notifySuccess(notification.message);
  else if (notification.type === "error") notifyError(notification.message);
  else notifyUnauthorized();
}

function AppLayout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const {
    me,
    projects,
    selectedProject,
    setSelectedProject,
    paneMode,
    businessPaneOpen,
    mapSupportOpen,
    toggleBusinessPane,
    toggleMapPane,
    mapPaneWidth,
    mapFullscreen
  } = useAppShell();
  const { openThread } = useFeedbackPlugin();
  const canManageReview = hasProjectPermission(me, selectedProject, reviewManagePermission);
  const reviewManagementUrl = selectedProject && (canManageReview || me?.systemRole === "admin")
    ? buildFeedbackAdminUrl(import.meta.env.VITE_FEEDBACK_ADMIN_URL ?? "http://localhost:5174/", {
        applicationKey: import.meta.env.VITE_FEEDBACK_APPLICATION_KEY ?? "web-gis",
        environmentKey: import.meta.env.VITE_FEEDBACK_ENVIRONMENT_KEY ?? "local",
        externalWorkspaceKey: selectedProject
      }, "create-review")
    : undefined;

  // URL (マッチ中ルートの staticData) を唯一の正としてタブ強調・タイトルを導出する
  const activeTab = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.tab ?? "zone" });
  const screenTitle = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.title ?? null });
  const linkedProjectId = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).projectId;
      return typeof value === "string" ? value : null;
    }
  });
  const linkedThreadId = useRouterState({
    select: (state) => resolveWebGisFeedbackThread(state.location.search as Record<string, unknown>)
  });
  const handledReviewLink = useRef("");
  useEffect(() => {
    document.title = screenTitle ? `${screenTitle} · Web GIS MVP` : "Web GIS MVP";
  }, [screenTitle]);

  useEffect(() => {
    if (!linkedThreadId) {
      handledReviewLink.current = "";
      return;
    }
    if (linkedProjectId && !projects.some((project) => project.id === linkedProjectId)) return;
    // projectId付きリンクは先にホスト側のプロジェクト文脈を切り替え、次のrenderで
    // SDKへthreadIdを渡す。異なるprojectIdのキャッシュ／Drawerを一瞬開かない。
    if (linkedProjectId && linkedProjectId !== selectedProject) {
      setSelectedProject(linkedProjectId);
      return;
    }
    const linkKey = `${linkedProjectId ?? ""}:${linkedThreadId}`;
    if (handledReviewLink.current === linkKey) return;
    handledReviewLink.current = linkKey;
    openThread(linkedThreadId);
  }, [linkedProjectId, linkedThreadId, openThread, projects, selectedProject, setSelectedProject]);

  const navigateTab = (tab: BusinessTab) => void navigate({ to: tabBasePath[tab] });

  return (
    <div className={`business-app${mapFullscreen ? " map-fullscreen" : ""}`}>
      <header className="top-shell">
        <div className="product-mark">
          <FileText size={20} />
          <div>
            <strong>不動産業務管理</strong>
            <span>{projects.find((project) => project.id === selectedProject)?.name ?? "Project"}</span>
          </div>
        </div>
        <nav className="top-tabs" aria-label="業務タブ">
          <button data-feedback-id="navigation.zones" className={activeTab === "zone" ? "active" : ""} type="button" onClick={() => navigateTab("zone")}>
            <MapIcon size={17} />
            区域
          </button>
          <button data-feedback-id="navigation.lands" className={activeTab === "lands" ? "active" : ""} type="button" onClick={() => navigateTab("lands")}>
            <MapIcon size={17} />
            土地
          </button>
          <button data-feedback-id="navigation.buildings" className={activeTab === "buildings" ? "active" : ""} type="button" onClick={() => navigateTab("buildings")}>
            <Building2 size={17} />
            建物
          </button>
          <button data-feedback-id="navigation.parties" className={activeTab === "parties" ? "active" : ""} type="button" onClick={() => navigateTab("parties")}>
            <Users size={17} />
            関係者
          </button>
          {me?.systemRole === "admin" ? (
            <button data-feedback-id="navigation.admin" className={activeTab === "admin" ? "active" : ""} type="button" onClick={() => navigateTab("admin")}>
              <ShieldCheck size={17} />
              管理
            </button>
          ) : null}
        </nav>
        <div className="top-shell-actions">
          <button
            className="icon-button"
            type="button"
            onClick={toggleBusinessPane}
            aria-label={businessPaneOpen ? "業務画面を隠す" : "業務画面を表示"}
            aria-pressed={!businessPaneOpen}
            title={businessPaneOpen ? "業務画面を隠す" : "業務画面を表示"}
          >
            {businessPaneOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button
            data-feedback-id="map.visibility"
            className="icon-button"
            type="button"
            onClick={toggleMapPane}
            aria-label={mapSupportOpen ? "地図を隠す" : "地図を表示"}
            aria-pressed={!mapSupportOpen}
            title={mapSupportOpen ? "地図を隠す" : "地図を表示"}
          >
            {mapSupportOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="ログアウト"
            title={`ログアウト${auth.user?.profile.preferred_username ?? auth.user?.profile.email ? ` (${auth.user?.profile.preferred_username ?? auth.user?.profile.email})` : ""}`}
            onClick={() => void auth.signoutRedirect()}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <main
        className={`business-workspace ${paneMode}${mapFullscreen ? " map-fullscreen" : ""}`}
        style={{ "--map-pane-width": `${mapPaneWidth}px` } as CSSProperties}
      >
        <div className="workspace-tabs">
          <ScreenGuard me={me}>
            <Outlet />
          </ScreenGuard>
        </div>
        <MapPaneHost />
      </main>

      {/* レビュー機能はどの画面からでも状態が分かるよう、画面ではなく最前面のシェルに置く。 */}
      <FeedbackOverlay reviewManagementUrl={reviewManagementUrl} />
      <Toaster />
      <ConfirmDialogHost />
    </div>
  );
}

// マッチしたルートの staticData を見て、system role／project permissionを一元的に強制するガード。
// 個別画面へ権限の直判定を増やさず、ルート定義のメタ情報だけで保護する。
function ScreenGuard({ me, children }: { me: Me | null; children: ReactNode }) {
  const { selectedProject } = useAppShell();
  const requiredSystemRole = useRouterState({
    select: (state) => activeScreenMeta(state.matches)?.requiredSystemRole ?? null
  });
  const requiredProjectPermission = useRouterState({
    select: (state) => activeScreenMeta(state.matches)?.requiredProjectPermission ?? null
  });
  if (requiredSystemRole || requiredProjectPermission) {
    // /api/me 取得完了までガード判定を保留する (未ロード時に誤リダイレクトしない)
    if (!me || (requiredProjectPermission && !selectedProject && me.systemRole !== "admin")) {
      return (
        <section className="tab-pane active">
          <p className="admin-hint">権限を確認しています…</p>
        </section>
      );
    }
    if (requiredSystemRole && me.systemRole !== requiredSystemRole) {
      return <Navigate to="/zones" replace />;
    }
  }
  if (
    requiredProjectPermission &&
    !hasProjectPermission(me, selectedProject, requiredProjectPermission)
  ) {
    return <Navigate to="/zones" replace />;
  }
  return <>{children}</>;
}
