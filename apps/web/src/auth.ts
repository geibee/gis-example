// 認証まわりの共有点: AuthProvider が保持するアクセストークンを、
// React の外にいる api.ts と MapLibre (transformRequest) から参照できるようにする
import { WebStorageStateStore } from "oidc-client-ts";

export const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "http://localhost:8081/realms/gis",
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "gis-web",
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  // リロードしてもセッションを保つ (既定はメモリ保持)
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  // コールバック後に URL から code/state を消す
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
};

let accessToken: string | undefined;

export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}

export function getAccessToken(): string | undefined {
  return accessToken;
}

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

// API が 401 を返したとき (トークン失効・ユーザー無効化) に再ログインへ誘導する
export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}
