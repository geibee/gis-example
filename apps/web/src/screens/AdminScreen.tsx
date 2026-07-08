import { useAppShell } from "../appShell";
import { AdminWorkspace } from "../components/AdminWorkspace";

// 管理画面: system admin 専用。到達可否はルートの staticData (requiredSystemRole) を
// 見るルートガード (App 側) が一元的に enforce する。
export default function AdminScreen() {
  const { me, projects } = useAppShell();
  return (
    <section className="tab-pane admin-tab active">
      {me?.systemRole === "admin" ? (
        <AdminWorkspace projects={projects} meUserId={me.userId} />
      ) : (
        <p className="admin-hint">この画面は system admin 専用です。</p>
      )}
    </section>
  );
}
