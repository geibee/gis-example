// AuthGate の認証フロー (トークン同期・リロード時の silent サインイン → リダイレクト
// フォールバック・401 リカバリ経路の登録) を検証する。
// react-oidc-context は setup.ts でスタブ済み。認証状態は authStub.current の差し替えで制御する。
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AuthGate from "./AuthGate";
import { getAccessToken, notifyUnauthorized, setAccessToken, tryRenewAccessToken } from "./auth";
import { authStub, makeAuthStub } from "./testing/authStub";

describe("AuthGate", () => {
  afterEach(() => {
    setAccessToken(undefined);
  });

  test("認証済みならトークンを共有点へ同期してから children を描画する", async () => {
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>
    );

    expect(await screen.findByText("app-content")).toBeInTheDocument();
    expect(getAccessToken()).toBe("test-access-token");
  });

  test("未認証時は silent サインインを試み、成功したらリダイレクトしない", async () => {
    const signinSilent = vi.fn(async () => ({ access_token: "restored", expired: false, profile: {} }));
    authStub.current = makeAuthStub({ isAuthenticated: false, user: undefined, signinSilent });

    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>
    );

    await waitFor(() => expect(signinSilent).toHaveBeenCalled());
    expect(authStub.current.signinRedirect).not.toHaveBeenCalled();
    expect(screen.queryByText("app-content")).not.toBeInTheDocument();
  });

  test("silent サインイン失敗時のみリダイレクトへ落とし、復帰先 URL を state に載せる", async () => {
    const signinSilent = vi.fn(async () => {
      throw new Error("login_required");
    });
    authStub.current = makeAuthStub({ isAuthenticated: false, user: undefined, signinSilent });

    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>
    );

    await waitFor(() => expect(authStub.current.signinRedirect).toHaveBeenCalledTimes(1));
    expect(authStub.current.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: expect.stringContaining("/") }
    });
  });

  test("401 リカバリを登録する: renew は signinSilent 経由、失敗時の誘導は signinRedirect (多重防止付き)", async () => {
    const signinSilent = vi.fn(async () => ({ access_token: "renewed-token", expired: false, profile: {} }));
    authStub.current = makeAuthStub({ signinSilent });

    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>
    );
    await screen.findByText("app-content");

    // api.ts が 401 時に呼ぶ renew: signinSilent の結果で共有トークンが更新される
    await expect(tryRenewAccessToken()).resolves.toBe("renewed-token");
    expect(getAccessToken()).toBe("renewed-token");

    // renew も失敗した 401: 再ログイン誘導は 1 回しか発火しない
    notifyUnauthorized();
    notifyUnauthorized();
    expect(authStub.current.signinRedirect).toHaveBeenCalledTimes(1);
    expect(authStub.current.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: expect.stringContaining("/") }
    });
  });
});
