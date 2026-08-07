import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { captureViewport, type ViewportEvidence } from "./capture";
import type { FeedbackTarget } from "./types";
import { errorMessage } from "../utils";

export type ReviewMode = "idle" | "picking" | "capturing" | "composing";

export type PickedFeedbackTarget = {
  target: FeedbackTarget;
  evidence: ViewportEvidence | null;
  /** 証跡の生成に失敗した場合の理由 (指摘自体は残せるので投稿は止めない)。 */
  captureError: string | null;
};

type ReviewContextValue = {
  mode: ReviewMode;
  picked: PickedFeedbackTarget | null;
  startPicking: () => void;
  selectTarget: (target: FeedbackTarget) => Promise<void>;
  reset: () => void;
};

const ReviewContext = createContext<ReviewContextValue | null>(null);

/**
 * DOM と MapLibre のどちらから対象が選ばれても、同じ 1 回の証跡取得へ合流させる。
 * 世代番号でキャンセル後に完了した非同期キャプチャが Composer を再表示する競合も防ぐ。
 */
export function ReviewProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ReviewMode>("idle");
  const [picked, setPicked] = useState<PickedFeedbackTarget | null>(null);
  const modeRef = useRef<ReviewMode>("idle");
  const generation = useRef(0);

  const transition = useCallback((next: ReviewMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    setPicked(null);
    transition("idle");
  }, [transition]);

  const startPicking = useCallback(() => {
    generation.current += 1;
    setPicked(null);
    transition("picking");
  }, [transition]);

  const selectTarget = useCallback(
    async (target: FeedbackTarget) => {
      if (modeRef.current !== "picking") return;
      const activeGeneration = generation.current;
      transition("capturing");
      let evidence: ViewportEvidence | null = null;
      let captureError: string | null = null;
      try {
        evidence = await captureViewport();
      } catch (error) {
        captureError = errorMessage(error);
      }
      if (generation.current !== activeGeneration) return;
      setPicked({ target, evidence, captureError });
      transition("composing");
    },
    [transition]
  );

  const value = useMemo(
    () => ({ mode, picked, startPicking, selectTarget, reset }),
    [mode, picked, reset, selectTarget, startPicking]
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview() {
  const context = useContext(ReviewContext);
  if (!context) throw new Error("useReview must be used within ReviewProvider");
  return context;
}
