import { UserManager, WebStorageStateStore } from "oidc-client-ts";

let manager: UserManager | null = null;

export function getUserManager(): UserManager {
  if (manager) return manager;
  const authority = required("VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY", import.meta.env.VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY);
  const clientId = required("VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID", import.meta.env.VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID);
  manager = new UserManager({
    authority,
    client_id: clientId,
    redirect_uri: import.meta.env.VITE_FEEDBACK_ADMIN_OIDC_REDIRECT_URI || `${window.location.origin}/`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: import.meta.env.VITE_FEEDBACK_ADMIN_OIDC_SCOPE || "openid profile email",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false
  });
  return manager;
}

export async function getAccessToken(): Promise<string | null> {
  const user = await getUserManager().getUser();
  return user && !user.expired ? user.access_token : null;
}

export async function refreshAccessToken(): Promise<string | null> {
  return (await getUserManager().signinSilent())?.access_token ?? null;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}
