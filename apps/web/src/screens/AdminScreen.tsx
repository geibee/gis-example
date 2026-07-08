import { useAppState } from "../appState";
import { AdminWorkspace } from "../components/AdminWorkspace";

// 管理画面: system admin 専用。到達可否はルートの staticData (requiredSystemRole) を
// 見るルートガード (App 側) が一元的に enforce する。
export default function AdminScreen() {
  const app = useAppState();
  return (
    <section className="tab-pane admin-tab active">
      {app.me?.systemRole === "admin" ? (
        <AdminWorkspace projects={app.projects} meUserId={app.me.userId} onNotice={app.setNotice} />
      ) : (
        <p className="admin-hint">この画面は system admin 専用です。</p>
      )}
    </section>
  );
}
