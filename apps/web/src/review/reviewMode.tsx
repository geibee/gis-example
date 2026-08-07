import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { FeedbackTarget } from "./types";

// レビューモードの横断状態 (docs/prototype-review.md Phase 3)。
//
// コメント対象の指定は 2 経路ある:
//   - 通常 DOM: FeedbackOverlay が document のクリックを capture フェーズで横取りする
//   - MapLibre: 地図は WebGL Canvas 1 枚で DOM 要素を持たないため、MapPane 側の
//     クリックハンドラが地物・地点として解決する (FeedbackMapAdapter)
// どちらも最終的に submitTarget へ集約し、その先 (証跡取得・入力パネル) は 1 本にする。

export type ReviewModeState = {
  /** 対象を選んでいる最中か。地図ペインはこのフラグでクリックの意味を切り替える */
  picking: boolean;
  beginPicking: () => void;
  cancelPicking: () => void;
  /** 対象が決まったときに呼ぶ (DOM 経路・地図経路の共通出口) */
  submitTarget: (target: FeedbackTarget) => void;
  /** 直近に確定した対象 (FeedbackOverlay が入力パネルを開くために読む) */
  pendingTarget: FeedbackTarget | null;
  clearPendingTarget: () => void;
  /** コメントピンの表示切替 */
  pinsVisible: boolean;
  togglePins: () => void;
  /** ピンから開いているスレッド (画面ピンと地図ピンで 1 つを共有する) */
  selectedThreadId: string | null;
  selectThread: (threadId: string | null) => void;
};

const ReviewModeContext = createContext<ReviewModeState | null>(null);

export function ReviewModeProvider({ children }: { children: ReactNode }) {
  const [picking, setPicking] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<FeedbackTarget | null>(null);
  const [pinsVisible, setPinsVisible] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const beginPicking = useCallback(() => {
    setPendingTarget(null);
    setPicking(true);
  }, []);

  const cancelPicking = useCallback(() => {
    setPicking(false);
    setPendingTarget(null);
  }, []);

  const submitTarget = useCallback((target: FeedbackTarget) => {
    setPicking(false);
    setPendingTarget(target);
  }, []);

  const value = useMemo<ReviewModeState>(
    () => ({
      picking,
      beginPicking,
      cancelPicking,
      submitTarget,
      pendingTarget,
      clearPendingTarget: () => setPendingTarget(null),
      pinsVisible,
      togglePins: () =>
        setPinsVisible((visible) => {
          // 閉じるときは開いていたスレッドも畳む
          if (visible) setSelectedThreadId(null);
          return !visible;
        }),
      selectedThreadId,
      selectThread: setSelectedThreadId
    }),
    [beginPicking, cancelPicking, pendingTarget, picking, pinsVisible, selectedThreadId, submitTarget]
  );

  return <ReviewModeContext.Provider value={value}>{children}</ReviewModeContext.Provider>;
}

export function useReviewMode(): ReviewModeState {
  const state = useContext(ReviewModeContext);
  if (!state) {
    throw new Error("ReviewModeContext が提供されていません (ReviewModeProvider 配下でのみ使用できます)");
  }
  return state;
}
