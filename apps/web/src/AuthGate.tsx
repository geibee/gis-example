// 認証ゲート。責務:
// - 認証が確立しトークンが auth.ts の共有点へ同期されるまで App を描画しない
//   (マウント時 fetch より先にトークンが必要なため。同期はレンダー中ではなく effect で行う)
// - 未認証時はまず silent サインイン (IdP の SSO Cookie + prompt=none iframe) を試し、
//   失敗した場合のみリダイレクトログインへ誘導する (in-memory 保管でもリロードで再入力にならない)
// - api.ts の 401 リカバリ経路 (silent renew / 再ログイン誘導) を auth.ts へ登録する
// - リダイレクト時は現在の URL を state に載せ、ログイン後に元の画面へ復帰させる
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { currentLocationState, setAccessToken, setSilentRenewHandler, setUnauthorizedHandler } from "./auth";

export default function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [tokenReady, setTokenReady] = useState(false);
  // 多重リダイレクト防止 (並行する複数 401 が同時に notifyUnauthorized を呼ぶケース)
  const redirectingRef = useRef(false);
  // 起動時 silent サインインの多重実行防止 (StrictMode の effect 二重実行を含む)
  const silentAttemptedRef = useRef(false);

  // トークン同期。automaticSilentRenew で auth.user が入れ替わるたびに再同期される
  useEffect(() => {
    setAccessToken(auth.user?.access_token);
    setTokenReady(auth.user != null && !auth.user.expired);
    if (auth.isAuthenticated) silentAttemptedRef.current = false;
  }, [auth.user, auth.isAuthenticated]);

  useEffect(() => {
    // 401 時のリカバリ: まず refresh token による silent renew を試す (api.ts が呼ぶ)
    setSilentRenewHandler(async () => {
      const user = await auth.signinSilent();
      return user?.access_token;
    });
    // renew でも解決しない 401 は対話ログインへ (復帰先 URL を state に載せる)
    setUnauthorizedHandler(() => {
      if (redirectingRef.current || auth.activeNavigator) return;
      redirectingRef.current = true;
      void auth.signinRedirect({ state: currentLocationState() });
    });
    return () => {
      setSilentRenewHandler(undefined);
      setUnauthorizedHandler(undefined);
    };
  }, [auth]);

  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || auth.activeNavigator || auth.error) return;
    if (silentAttemptedRef.current) return;
    silentAttemptedRef.current = true;
    void (async () => {
      try {
        // リロード直後など: in-memory 保管はトークンを持たないため、SSO Cookie による
        // silent サインインで復元を試みる (SSO セッションが無ければ login_required で失敗する)
        const user = await auth.signinSilent();
        if (user) return;
      } catch {
        // silent 不可 (未ログイン・Cookie ブロック等) → リダイレクトログインへ
      }
      await auth.signinRedirect({ state: currentLocationState() });
    })();
  }, [auth, auth.isLoading, auth.isAuthenticated, auth.activeNavigator, auth.error]);

  if (auth.error) {
    return (
      <div className="auth-screen">
        <p>認証でエラーが発生しました: {auth.error.message}</p>
        <button type="button" onClick={() => void auth.signinRedirect({ state: currentLocationState() })}>
          再ログイン
        </button>
      </div>
    );
  }
  if (!auth.isAuthenticated || !tokenReady) {
    return (
      <div className="auth-screen">
        {auth.activeNavigator === "signinSilent" ? "セッションを確認しています…" : "ログインへ移動しています…"}
      </div>
    );
  }
  return <>{children}</>;
}
