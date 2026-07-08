import { createContext, useContext } from "react";
import type { AppState } from "./App";

// App (ルートレイアウト) が保持する state と handler 群を各画面へ渡すための Context。
// 状態管理の本格的な解体は issue #9 で行う予定で、当面は App が単一の保持者。
// 注意: App からは型のみ import しているため、画面チャンクへ App 本体は混入しない。
export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) {
    throw new Error("AppStateContext が提供されていません (App 配下でのみ使用できます)");
  }
  return state;
}
