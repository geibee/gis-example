import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import type { Project, ProjectMember, UserAccount } from "../contracts";
import { deleteProjectMember, getProjectMembers, getUsers, putProjectMember, updateUser } from "../api";
import { notifyError } from "../notifications";
import { DataTable, type DataTableColumn } from "../ui/DataTable";
import { errorMessage } from "../utils";

// system admin 専用の管理画面: ユーザーの有効化・ロール変更と、
// プロジェクトメンバー (editor/viewer) の付与・剥奪を行う
export function AdminWorkspace({
  projects,
  meUserId
}: {
  projects: Project[];
  meUserId: string;
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
      notifyError(errorMessage(error));
    } finally {
      setLoadingUsers(false);
    }
  }, []);

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
        notifyError(errorMessage(error));
      } finally {
        setLoadingMembers(false);
      }
    },
    []
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
      notifyError(errorMessage(error));
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

  const userColumns: Array<DataTableColumn<UserAccount>> = [
    {
      key: "name",
      header: "名前",
      render: (user) => (
        <>
          {userLabel(user)}
          {user.id === meUserId ? <span className="admin-self-mark">(自分)</span> : null}
        </>
      )
    },
    { key: "email", header: "メール", render: (user) => user.email ?? "-" },
    { key: "systemRole", header: "システムロール", render: (user) => (user.systemRole === "admin" ? "admin" : "user") },
    { key: "state", header: "状態", render: (user) => (user.isActive ? "有効" : "無効") },
    {
      key: "actions",
      header: "操作",
      render: (user) => {
        const isSelf = user.id === meUserId;
        return (
          <span className="admin-actions">
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
          </span>
        );
      }
    }
  ];

  const memberColumns: Array<DataTableColumn<ProjectMember>> = [
    { key: "name", header: "名前", render: (member) => userLabel(member) },
    { key: "email", header: "メール", render: (member) => member.email ?? "-" },
    {
      key: "role",
      header: "ロール",
      render: (member) => (
        <select
          value={member.role}
          disabled={busy}
          onChange={(event) => void changeMemberRole(member.userId, event.target.value as "editor" | "viewer")}
        >
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
      )
    },
    {
      key: "actions",
      header: "操作",
      render: (member) => (
        <span className="admin-actions">
          <button className="subtle-button" type="button" disabled={busy} onClick={() => void removeMember(member.userId)}>
            <Trash2 size={14} />
            削除
          </button>
        </span>
      )
    }
  ];

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
        <DataTable
          columns={userColumns}
          rows={users}
          rowKey={(user) => user.id}
          rowClassName={(user) => (user.isActive ? undefined : "admin-row-inactive")}
          emptyMessage={loadingUsers ? "読み込み中です" : "ユーザーがいません"}
          tableClassName="admin-table"
          scroll={false}
        />
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
        <DataTable
          columns={memberColumns}
          rows={members}
          rowKey={(member) => member.userId}
          emptyMessage={loadingMembers ? "読み込み中です" : "メンバーがいません"}
          tableClassName="admin-table"
          scroll={false}
        />
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
