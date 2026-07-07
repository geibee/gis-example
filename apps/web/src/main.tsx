import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider, useAuth } from "react-oidc-context";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "./App";
import { oidcConfig, setAccessToken, setUnauthorizedHandler } from "./auth";
import "./styles.css";

// 認証が確立するまで App を描画しない。未認証なら IdP のログイン画面へ誘導する
function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  // App のマウント時 fetch より先にトークンが必要なため、描画中に同期して設定する
  setAccessToken(auth.user?.access_token);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void auth.signinRedirect();
    });
  }, [auth]);

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.activeNavigator && !auth.error) {
      void auth.signinRedirect();
    }
  }, [auth, auth.isLoading, auth.isAuthenticated, auth.activeNavigator, auth.error]);

  if (auth.error) {
    return (
      <div className="auth-screen">
        <p>認証でエラーが発生しました: {auth.error.message}</p>
        <button type="button" onClick={() => void auth.signinRedirect()}>
          再ログイン
        </button>
      </div>
    );
  }
  if (!auth.isAuthenticated) {
    return <div className="auth-screen">ログインへ移動しています…</div>;
  }
  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider {...oidcConfig}>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
);
