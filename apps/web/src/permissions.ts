import type { Me } from "./contracts";

/** システム管理者、または選択プロジェクトで指定権限を持つユーザーかを判定する。 */
export function hasProjectPermission(me: Me | null, projectId: string, permission: string): boolean {
  if (me?.systemRole === "admin") return true;
  if (!me || !projectId) return false;
  return me.memberships.some(
    (membership) => membership.projectId === projectId && membership.permissions?.includes(permission) === true
  );
}
