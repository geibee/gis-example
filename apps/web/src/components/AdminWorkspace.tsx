import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import type { Project, ProjectMember, UserAccount } from "../types";
import { deleteProjectMember, getProjectMembers, getUsers, putProjectMember, updateUser } from "../api";
import { errorMessage } from "../utils";

// system admin 専用の管理画面: ユーザーの有効化・ロール変更と、
// プロジェクトメンバー (editor/viewer) の付与・剥奪を行う
export function AdminWorkspace({
  projects,
  meUserId,
  onNotice
}: {
  projects: Project[];
  meUserId: string;
  onNotice: (message: string) => void;
}) {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [membersProjectId, setMembersProjectId] = useState<string>("");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [addUserId, setAddUserId] = useState<string>("");
  const [addRole, setAddRole] = useState<"editor" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      setUsers(await getUsers());
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setLoadingUsers(false);
    }
  }, [onNotice]);

  const loadMembers = useCallback(
    async (projectId: string) => {
      if (!projectId) {
        setMembers([]);
        return;
      }
      setLoadingMembers(true);
      try {
        setMembers(await getProjectMembers(projectId));
      } catch (error) {
        onNotice(errorMessage(error));
      } finally {
        setLoadingMembers(false);
      }
    },
    [onNotice]
  );

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!membersProjectId && projects.length) {
      setMembersProjectId(projects[0].id);
    }
  }, [membersProjectId, projects]);

  useEffect(() => {
    void loadMembers(membersProjectId);
  }, [loadMembers, membersProjectId]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const patchUser = (id: string, patch: { systemRole?: "admin" | "user"; isActive?: boolean }) =>
    runAction(async () => {
      const updated = await updateUser(id, patch);
      setUsers((current) => current.map((user) => (user.id === updated.id ? updated : user)));
    });

  const changeMemberRole = (userId: string, role: "editor" | "viewer") =>
    runAction(async () => {
      const updated = await putProjectMember(membersProjectId, userId, role);
      setMembers((current) => current.map((member) => (member.userId === updated.userId ? updated : member)));
    });

  const removeMember = (userId: string) =>
    runAction(async () => {
      await deleteProjectMember(membersProjectId, userId);
      setMembers((current) => current.filter((member) => member.userId !== userId));
    });

  const addMember = () =>
    runAction(async () => {
      if (!addUserId) return;
      const added = await putProjectMember(membersProjectId, addUserId, addRole);
      setMembers((current) => [...current.filter((member) => member.userId !== added.userId), added]);
      setAddUserId("");
    });

  const userLabel = (user: { displayName: string | null; email: string | null; subject?: string }) =>
    user.displayName ?? user.email ?? user.subject ?? "(名前未設定)";

  const memberUserIds = new Set(members.map((member) => member.userId));
  const addableUsers = users.filter((user) => user.isActive && !memberUserIds.has(user.id));

  return (
    <div className="admin-workspace">
      <section className="panel-section">
        <div className="admin-section-header">
          <h2>
            <ShieldCheck size={16} />
            ユーザー
          </h2>
          <button className="subtle-button" type="button" disabled={loadingUsers} onClick={() => void loadUsers()}>
            <RefreshCw size={14} />
            再読込
          </button>
        </div>
        <p className="admin-hint">
          ユーザーは初回ログイン時に自動登録される。無効化すると次のリクエストからアクセスできなくなる。自分自身は変更できない。
        </p>
        <table className="admin-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>メール</th>
              <th>システムロール</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === meUserId;
              return (
                <tr key={user.id} className={user.isActive ? "" : "admin-row-inactive"}>
                  <td>
                    {userLabel(user)}
                    {isSelf ? <span className="admin-self-mark">(自分)</span> : null}
                  </td>
                  <td>{user.email ?? "-"}</td>
                  <td>{user.systemRole === "admin" ? "admin" : "user"}</td>
                  <td>{user.isActive ? "有効" : "無効"}</td>
                  <td className="admin-actions">
                    <button
                      className="subtle-button"
                      type="button"
                      disabled={busy || isSelf}
                      onClick={() =>
                        void patchUser(user.id, { systemRole: user.systemRole === "admin" ? "user" : "admin" })
                      }
                    >
                      {user.systemRole === "admin" ? "admin を解除" : "admin にする"}
                    </button>
                    <button
                      className="subtle-button"
                      type="button"
                      disabled={busy || isSelf}
                      onClick={() => void patchUser(user.id, { isActive: !user.isActive })}
                    >
                      {user.isActive ? "無効化" : "有効化"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!users.length && !loadingUsers ? (
              <tr>
                <td colSpan={5}>ユーザーがいません</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="panel-section">
        <div className="admin-section-header">
          <h2>
            <UserPlus size={16} />
            プロジェクトメンバー
          </h2>
          <select value={membersProjectId} onChange={(event) => setMembersProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <p className="admin-hint">editor は取込・分析・編集が可能、viewer は閲覧のみ。system admin はメンバー登録不要で全プロジェクトを操作できる。</p>
        <table className="admin-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>メール</th>
              <th>ロール</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>{userLabel(member)}</td>
                <td>{member.email ?? "-"}</td>
                <td>
                  <select
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => void changeMemberRole(member.userId, event.target.value as "editor" | "viewer")}
                  >
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td className="admin-actions">
                  <button
                    className="subtle-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void removeMember(member.userId)}
                  >
                    <Trash2 size={14} />
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {!members.length && !loadingMembers ? (
              <tr>
                <td colSpan={4}>メンバーがいません</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="admin-add-member">
          <select value={addUserId} onChange={(event) => setAddUserId(event.target.value)}>
            <option value="">ユーザーを選択…</option>
            {addableUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {userLabel(user)}
              </option>
            ))}
          </select>
          <select value={addRole} onChange={(event) => setAddRole(event.target.value as "editor" | "viewer")}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
          <button
            className="subtle-button"
            type="button"
            disabled={busy || !addUserId || !membersProjectId}
            onClick={() => void addMember()}
          >
            <UserPlus size={14} />
            追加
          </button>
        </div>
      </section>
    </div>
  );
}
