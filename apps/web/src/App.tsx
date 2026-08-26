import { useEffect, type CSSProperties, type ReactNode } from "react";
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
import { AppShellProvider, useAppShell } from "./appShell";
import { MapStateProvider } from "./mapState";
import { MapPaneHost } from "./components/MapPaneHost";
import { ConfirmDialogHost } from "./ui/ConfirmDialog";
import { Toaster } from "./ui/Toaster";
import { activeScreenMeta, tabBasePath } from "./routeMeta";
import { hasProjectPermission } from "./permissions";
import type { BusinessTab } from "./appTypes";
import type { Me } from "./contracts";

// ルートレイアウト。認証・レイアウト・ルーター配置のみを担い、
// サーバ状態は TanStack Query (src/queries/)、画面固有の状態は各 src/screens/、
// 横断状態は AppShellProvider / MapStateProvider が持つ。
export default function App() {
  return (
    <AppShellProvider>
      <MapStateProvider>
        <AppLayout />
      </MapStateProvider>
    </AppShellProvider>
  );
}

function AppLayout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const {
    me,
    projects,
    selectedProject,
    paneMode,
    businessPaneOpen,
    mapSupportOpen,
    toggleBusinessPane,
    toggleMapPane,
    mapPaneWidth,
    mapFullscreen
  } = useAppShell();
  // URL (マッチ中ルートの staticData) を唯一の正としてタブ強調・タイトルを導出する
  const activeTab = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.tab ?? "zone" });
  const screenTitle = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.title ?? null });
  useEffect(() => {
    document.title = screenTitle ? `${screenTitle} · Web GIS MVP` : "Web GIS MVP";
  }, [screenTitle]);

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
          <button className={activeTab === "zone" ? "active" : ""} type="button" onClick={() => navigateTab("zone")}>
            <MapIcon size={17} />
            区域
          </button>
          <button className={activeTab === "lands" ? "active" : ""} type="button" onClick={() => navigateTab("lands")}>
            <MapIcon size={17} />
            土地
          </button>
          <button className={activeTab === "buildings" ? "active" : ""} type="button" onClick={() => navigateTab("buildings")}>
            <Building2 size={17} />
            建物
          </button>
          <button className={activeTab === "parties" ? "active" : ""} type="button" onClick={() => navigateTab("parties")}>
            <Users size={17} />
            関係者
          </button>
          {me?.systemRole === "admin" ? (
            <button className={activeTab === "admin" ? "active" : ""} type="button" onClick={() => navigateTab("admin")}>
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
