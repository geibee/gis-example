import { useEffect, type ReactNode } from "react";
import { Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Building2, EyeOff, FileText, LogOut, Map as MapIcon, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "react-oidc-context";
import { AppShellProvider, useAppShell } from "./appShell";
import { MapStateProvider } from "./mapState";
import { MapPaneHost } from "./components/MapPaneHost";
import { activeScreenMeta, tabBasePath } from "./routeMeta";
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
  const { me, projects, selectedProject, notice, setNotice, mapSupportOpen, setMapSupportOpen } = useAppShell();

  // URL (マッチ中ルートの staticData) を唯一の正としてタブ強調・タイトルを導出する
  const activeTab = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.tab ?? "zone" });
  const screenTitle = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.title ?? null });
  useEffect(() => {
    document.title = screenTitle ? `${screenTitle} · Web GIS MVP` : "Web GIS MVP";
  }, [screenTitle]);

  const navigateTab = (tab: BusinessTab) => void navigate({ to: tabBasePath[tab] });

  return (
    <div className="business-app">
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
        <button className="subtle-button top-map-toggle" type="button" onClick={() => setMapSupportOpen((open) => !open)}>
          {mapSupportOpen ? <EyeOff size={16} /> : <MapIcon size={16} />}
          {mapSupportOpen ? "地図を隠す" : "地図を表示"}
        </button>
        <button
          className="subtle-button"
          type="button"
          title={auth.user?.profile.preferred_username ?? auth.user?.profile.email ?? undefined}
          onClick={() => void auth.signoutRedirect()}
        >
          <LogOut size={16} />
          ログアウト
        </button>
      </header>

      <main className={`business-workspace${mapSupportOpen ? " map-open" : " map-closed"}`}>
        <div className="workspace-tabs">
          <ScreenGuard me={me}>
            <Outlet />
          </ScreenGuard>
        </div>
        <MapPaneHost />
      </main>

      {notice ? (
        <div className="notice business-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      ) : null}
    </div>
  );
}

// マッチしたルートの staticData (requiredSystemRole) を見て権限を一元的に enforce するガード。
// 個別画面に me?.systemRole の直判定を増やさなくても、ルート定義のメタ情報だけで保護される。
function ScreenGuard({ me, children }: { me: Me | null; children: ReactNode }) {
  const requiredSystemRole = useRouterState({
    select: (state) => activeScreenMeta(state.matches)?.requiredSystemRole ?? null
  });
  if (requiredSystemRole) {
    // /api/me 取得完了までガード判定を保留する (未ロード時に誤リダイレクトしない)
    if (!me) {
      return (
        <section className="tab-pane active">
          <p className="admin-hint">権限を確認しています…</p>
        </section>
      );
    }
    if (me.systemRole !== requiredSystemRole) {
      return <Navigate to="/zones" replace />;
    }
  }
  return <>{children}</>;
}
