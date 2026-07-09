// silent サインイン / renew 用 iframe (silent-renew.html) のエントリ。
// IdP から返ってきた応答 URL を親ウィンドウ (UserManager) へ postMessage で通知するだけで、
// トークン処理そのものは親側の oidc-client-ts が行う。
import { UserManager } from "oidc-client-ts";
import { oidcConfig } from "./auth";

new UserManager(oidcConfig).signinSilentCallback().catch((error: unknown) => {
  // 親ウィンドウ側は silentRequestTimeout で失敗を検知してリダイレクトへ落とすため、ここではログのみ
  console.error("silent renew callback failed", error);
});
