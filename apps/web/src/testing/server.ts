// Node 環境用の MSW サーバ。setup.ts がライフサイクル (listen / reset / close) を管理する。
// テスト固有の応答は `server.use(http.get("*/api/...", ...))` で上書きする
// (afterEach の resetHandlers で既定ハンドラへ戻る)。
import { setupServer } from "msw/node";
import { defaultHandlers } from "./handlers";

export const server = setupServer(...defaultHandlers);
