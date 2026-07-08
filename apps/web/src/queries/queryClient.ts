import { QueryCache, QueryClient } from "@tanstack/react-query";
import { notify } from "../notifications";
import { errorMessage } from "../utils";

// アプリ共通の QueryClient。
// - staleTime 30s: 画面遷移のたびの全件再取得を抑える控えめなキャッシュ
// - retry 1: 業務 API の一時失敗のみ吸収 (認証エラーは api.ts 側で再ログイン誘導)
// - クエリの失敗は QueryCache の onError で通知トーストへ一元集約する
//   (ミューテーションは文脈依存のメッセージを出すため各呼び出し側で処理する)
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => notify(errorMessage(error))
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false
      }
    }
  });
}
