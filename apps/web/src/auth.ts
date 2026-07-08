// 認証まわりの共有点: AuthProvider が保持するアクセストークンを、
// React の外にいる api.ts と MapLibre (transformRequest) から参照できるようにする。
//
// トークンの保管は in-memory (InMemoryWebStorage):
// - localStorage / sessionStorage は XSS 一発でトークンを丸ごと窃取できる保管場所のため使わない
// - リロードで失われるセッションは IdP の SSO Cookie を使った silent サインイン
//   (prompt=none の iframe → silent-renew.html) で回復し、失敗時のみリダイレクトログインへ落とす
// - 期限切れは automaticSilentRenew (refresh token) で失効前にバックグラウンド更新する
// トレードオフの詳細と IdP 側の前提: docs/web-oidc-token-management.md
import { InMemoryWebStorage, WebStorageStateStore, type User } from "oidc-client-ts";

// signinRedirect の state に載せ、ログイン往復後に元の画面 URL へ復帰するための情報
export type SigninReturnState = { returnTo?: string };

export function currentLocationState(): SigninReturnState {
  return { returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}` };
}

export const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "http://localhost:8081/realms/gis",
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "gis-web",
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  // silent サインイン / renew の iframe が戻る最小ページ (vite.config.ts で別エントリとしてビルド)
  silent_redirect_uri: `${window.location.origin}/silent-renew.html`,
  // 失効の 60 秒前 (accessTokenExpiring の既定) に refresh token でバックグラウンド更新する
  automaticSilentRenew: true,
  // トークンは in-memory 保管 (理由は冒頭コメント)。renew の一時 state (stateStore) は既定のまま
  userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  // ログアウトは end_session への遷移に加えて revocation endpoint で refresh/access token を失効させる
  revokeTokensOnSignout: true,
  // コールバック後に URL から code/state を消し、ログイン前に開いていた画面へ復帰する
  onSigninCallback: (user: User | undefined) => {
    const returnTo = (user?.state as SigninReturnState | undefined)?.returnTo;
    window.history.replaceState({}, document.title, returnTo ?? window.location.pathname);
  }
};

let accessToken: string | undefined;

export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}

export function getAccessToken(): string | undefined {
  return accessToken;
}

// ---------------------------------------------------------------- 401 リカバリ
// api.ts が 401 を受けたときの復旧経路。AuthGate が signinSilent を登録する。

type SilentRenewHandler = () => Promise<string | undefined>;

let silentRenewHandler: SilentRenewHandler | undefined;
let renewInFlight: Promise<string | undefined> | undefined;

export function setSilentRenewHandler(handler: SilentRenewHandler | undefined): void {
  silentRenewHandler = handler;
}

// silent renew を試み、成功したら共有トークンを更新して返す (失敗は undefined)。
// 並行する複数の 401 で renew が競合しないよう single-flight にする。
export function tryRenewAccessToken(): Promise<string | undefined> {
  if (!silentRenewHandler) return Promise.resolve(undefined);
  if (!renewInFlight) {
    renewInFlight = silentRenewHandler()
      .then((token) => {
        if (token) setAccessToken(token);
        return token;
      })
      .catch(() => undefined)
      .finally(() => {
        renewInFlight = undefined;
      });
  }
  return renewInFlight;
}

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

// silent renew でも解決しない 401 (セッション失効・ユーザー無効化) で再ログインへ誘導する
export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}
