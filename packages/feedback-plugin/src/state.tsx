import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { captureViewport, type ViewportEvidence } from "./capture";
import { useFeedbackPluginContext } from "./plugin-context";
import type { FeedbackTarget } from "./types";

export type FeedbackMode = "idle" | "picking" | "capturing" | "composing";

export type PickedFeedbackTarget = {
  target: FeedbackTarget;
  evidence: ViewportEvidence | null;
  captureError: string | null;
};

type FeedbackState = {
  mode: FeedbackMode;
  picked: PickedFeedbackTarget | null;
  activeThreadId: string | null;
  startPicking: () => void;
  selectTarget: (target: FeedbackTarget) => Promise<void>;
  openThread: (threadId: string) => void;
  closeThread: () => void;
  reset: () => void;
};

const FeedbackStateContext = createContext<FeedbackState | null>(null);

export function FeedbackStateProvider({ children }: { children: ReactNode }) {
  const { appVersion, projectId } = useFeedbackPluginContext();
  const [mode, setMode] = useState<FeedbackMode>("idle");
  const [picked, setPicked] = useState<PickedFeedbackTarget | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const modeRef = useRef<FeedbackMode>("idle");
  const generation = useRef(0);
  const activeThreadProjectId = useRef<string | null>(null);

  const transition = useCallback((next: FeedbackMode) => {
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
    activeThreadProjectId.current = null;
    setActiveThreadId(null);
    transition("picking");
  }, [transition]);
  const openThread = useCallback(
    (threadId: string) => {
      generation.current += 1;
      setPicked(null);
      activeThreadProjectId.current = projectId;
      setActiveThreadId(threadId);
      transition("idle");
    },
    [projectId, transition]
  );
  const closeThread = useCallback(() => {
    activeThreadProjectId.current = null;
    setActiveThreadId(null);
  }, []);

  useEffect(() => {
    generation.current += 1;
    setPicked(null);
    setActiveThreadId((current) => activeThreadProjectId.current === projectId ? current : null);
    transition("idle");
  }, [projectId, transition]);

  const selectTarget = useCallback(
    async (target: FeedbackTarget) => {
      if (modeRef.current !== "picking") return;
      const activeGeneration = generation.current;
      transition("capturing");
      let evidence: ViewportEvidence | null = null;
      let captureError: string | null = null;
      try {
        evidence = await captureViewport({ appVersion });
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
      if (generation.current !== activeGeneration) return;
      setPicked({ target, evidence, captureError });
      transition("composing");
    },
    [appVersion, transition]
  );
  const value = useMemo(
    () => ({ mode, picked, activeThreadId, startPicking, selectTarget, openThread, closeThread, reset }),
    [activeThreadId, closeThread, mode, openThread, picked, reset, selectTarget, startPicking]
  );
  return <FeedbackStateContext.Provider value={value}>{children}</FeedbackStateContext.Provider>;
}

export function useFeedbackState(): FeedbackState {
  const context = useContext(FeedbackStateContext);
  if (!context) throw new Error("フィードバックSDKはFeedbackPluginProviderの内側で使用してください");
  return context;
}

export function useFeedbackPlugin() {
  const { mode, startPicking, openThread, closeThread } = useFeedbackState();
  return useMemo(
    () => ({ mode, startPicking, openThread, closeThread }),
    [closeThread, mode, openThread, startPicking]
  );
}
