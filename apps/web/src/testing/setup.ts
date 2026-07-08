// 全テスト共通のセットアップ (vitest.config.ts の setupFiles)。
// - jest-dom マッチャ (toBeInTheDocument など)
// - MSW サーバのライフサイクル。ハンドラ未定義のリクエストは fail-closed でエラーにする
//   (契約にないエンドポイントを叩いたことをテストで検知する)
// - jsdom で動かないモジュールの全体モック (maplibre-gl / OIDC)
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { authStub, makeAuthStub } from "./authStub";
import { server } from "./server";

// maplibre-gl (WebGL 前提) は jsdom で動作しないため、遅延ロードされる地図ペインを
// 空コンポーネントに差し替える。地図連携のロジックは MapPane より外側
// (mapState / utils) にあるので、テスト対象はそのまま残る。
vi.mock("../components/MapPane", () => ({ default: () => null }));

// react-oidc-context はスタブに差し替える (既定は「認証済みユーザー」= testing/authStub.ts)。
// AuthGate のように認証状態を検証するテストは authStub.current を差し替える。
vi.mock("react-oidc-context", async () => {
  const { authStub: stub } = await import("./authStub");
  return {
    AuthProvider: ({ children }: { children: unknown }) => children,
    useAuth: () => stub.current
  };
});

// jsdom 未実装の scrollTo (ルーターのスクロール復元が呼ぶ) を no-op にして警告を消す
window.scrollTo = vi.fn();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  server.resetHandlers();
  authStub.current = makeAuthStub();
  cleanup();
});

afterAll(() => server.close());
