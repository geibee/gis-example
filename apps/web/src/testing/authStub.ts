// setup.ts の react-oidc-context モックの実体。既定は「認証済みユーザー」で、
// どの画面テストもそのまま認証済みとして描画できる。
// AuthGate など認証状態そのものを検証するテストは `authStub.current = makeAuthStub({...})`
// で差し替える (afterEach で setup.ts が既定へ戻す)。
import { vi } from "vitest";

export function makeAuthStub(overrides: Record<string, unknown> = {}) {
  return {
    isAuthenticated: true,
    isLoading: false,
    activeNavigator: undefined as string | undefined,
    error: undefined as Error | undefined,
    user: {
      access_token: "test-access-token",
      expired: false,
      profile: { preferred_username: "test-user", email: "test-user@example.com" }
    } as { access_token: string; expired: boolean; profile: Record<string, unknown> } | undefined,
    // 実装は vi.fn(impl) 形式で渡す (restoreMocks が mockResolvedValue を剥がしても既定実装が残る)
    signinRedirect: vi.fn(async () => undefined),
    signinSilent: vi.fn(async () => null),
    signoutRedirect: vi.fn(async () => undefined),
    ...overrides
  };
}

export const authStub = { current: makeAuthStub() };
