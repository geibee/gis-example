import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode
} from "react";
import type {
  FeedbackHostAdapter,
  FeedbackTelemetry,
  FeedbackTransport
} from "@feedback/core";
import type {
  FeedbackHostContextV1,
  FeedbackLocationV1,
  FeedbackReviewContextV1
} from "@feedback/contracts";

export type FeedbackFeatureFlags = {
  contextMenu?: boolean;
  autoIntroduction?: boolean;
  participantPrompt?: boolean;
  evidenceCapture?: boolean;
};

export type FeedbackMessages = {
  unavailable: string;
  loading: string;
  launcher: string;
  close: string;
  submit: string;
  reply: string;
  resolve: string;
  reopen: string;
  participantName: string;
  comment: string;
  threads: string;
  edit: string;
  save: string;
  history: string;
  evidence: string;
  postingWarning: string;
  postingDenied: string;
};

export const defaultFeedbackMessages: FeedbackMessages = {
  unavailable: "フィードバック機能を一時的に利用できません",
  loading: "フィードバック機能を準備しています",
  launcher: "フィードバック",
  close: "閉じる",
  submit: "投稿する",
  reply: "返信する",
  resolve: "解決済みにする",
  reopen: "再開する",
  participantName: "投稿者名",
  comment: "コメント",
  threads: "フィードバック一覧",
  edit: "編集",
  save: "保存",
  history: "編集履歴",
  evidence: "証跡",
  postingWarning: "この画面はレビュー対象外ですが、確認のうえ投稿できます",
  postingDenied: "この画面にはフィードバックを投稿できません"
};

export type FeedbackProviderProps = {
  adapter: FeedbackHostAdapter;
  transport: FeedbackTransport;
  children: ReactNode;
  messages?: Partial<FeedbackMessages>;
  features?: FeedbackFeatureFlags;
  portalTarget?: Element | DocumentFragment | null;
  onUnavailable?: (error: unknown) => void;
  requestTimeoutMs?: number;
  contextRetryCount?: number;
  telemetry?: FeedbackTelemetry;
};

export type FeedbackRuntimeState = "loading" | "ready" | "unavailable";

export type FeedbackContextValue = {
  adapter: FeedbackHostAdapter;
  transport: FeedbackTransport;
  state: FeedbackRuntimeState;
  hostContext: FeedbackHostContextV1 | null;
  location: FeedbackLocationV1 | null;
  reviewContext: FeedbackReviewContextV1 | null;
  error: unknown;
  messages: FeedbackMessages;
  features: FeedbackFeatureFlags;
  portalTarget: Element | DocumentFragment | null;
  telemetry?: FeedbackTelemetry;
  refresh(): Promise<void>;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

/** Service 障害をホスト画面の rendering 失敗へ伝播させない runtime provider。 */
export function FeedbackProvider({
  adapter,
  transport,
  children,
  messages: messageOverrides,
  features = {},
  portalTarget = null,
  onUnavailable,
  requestTimeoutMs = 5000,
  contextRetryCount = 1,
  telemetry
}: FeedbackProviderProps) {
  const [state, setState] = useState<FeedbackRuntimeState>("loading");
  const [hostContext, setHostContext] = useState<FeedbackHostContextV1 | null>(null);
  const [location, setLocation] = useState<FeedbackLocationV1 | null>(null);
  const [reviewContext, setReviewContext] = useState<FeedbackReviewContextV1 | null>(null);
  const [error, setError] = useState<unknown>(null);
  const messages = useMemo(() => ({ ...defaultFeedbackMessages, ...messageOverrides }), [messageOverrides]);

  const refresh = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const load = async () => {
        await withTimeout(transport.getCapabilities(), requestTimeoutMs);
        const nextHostContext = adapter.getContext();
        const nextLocation = adapter.getLocation();
        const nextReviewContext = nextLocation
          ? await withTimeout(transport.getReviewContext(nextHostContext, nextLocation), requestTimeoutMs)
          : null;
        return { nextHostContext, nextLocation, nextReviewContext };
      };
      let loaded: Awaited<ReturnType<typeof load>> | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt <= contextRetryCount; attempt += 1) {
        try {
          loaded = await load();
          break;
        } catch (nextError) {
          lastError = nextError;
        }
      }
      if (!loaded) throw lastError;
      const { nextHostContext, nextLocation, nextReviewContext } = loaded;
      setHostContext(nextHostContext);
      setLocation(nextLocation);
      setReviewContext(nextReviewContext);
      setState("ready");
    } catch (nextError) {
      setHostContext(null);
      setLocation(null);
      setReviewContext(null);
      setError(nextError);
      setState("unavailable");
      telemetry?.increment("service_unavailable", hostContextDimensions(adapter));
      onUnavailable?.(nextError);
    }
  }, [adapter, contextRetryCount, onUnavailable, requestTimeoutMs, telemetry, transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<FeedbackContextValue>(() => ({
    adapter,
    transport,
    state,
    hostContext,
    location,
    reviewContext,
    error,
    messages,
    features,
    portalTarget,
    refresh,
    telemetry
  }), [adapter, error, features, hostContext, location, messages, portalTarget, refresh, reviewContext, state, telemetry, transport]);

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

function hostContextDimensions(adapter: FeedbackHostAdapter) {
  try {
    const context = adapter.getContext();
    return {
      applicationKey: context.applicationKey,
      environmentKey: context.environmentKey,
      externalWorkspaceKey: context.externalWorkspaceKey
    };
  } catch {
    return {};
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Feedback Service request timeout")), milliseconds);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedbackはFeedbackProviderの内側で使用してください");
  return value;
}

export type FeedbackUnavailableProps = {
  children?: ReactNode;
};

/** host が明示的に配置した場合だけ表示する、業務画面を塞がない unavailable UI。 */
export function FeedbackUnavailable({ children }: FeedbackUnavailableProps) {
  const feedback = useFeedback();
  if (feedback.state !== "unavailable") return null;
  return <div role="status" data-feedback-unavailable="">{children ?? feedback.messages.unavailable}</div>;
}

type FeedbackErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
};

type FeedbackErrorBoundaryState = { failed: boolean };

/** SDK subtree の例外をホスト application の ErrorBoundary まで漏らさない。 */
export class FeedbackErrorBoundary extends Component<FeedbackErrorBoundaryProps, FeedbackErrorBoundaryState> {
  state: FeedbackErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): FeedbackErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

export type {
  FeedbackEvidencePayload,
  FeedbackEvidenceProvider,
  FeedbackEvidenceRequest,
  FeedbackHostAdapter,
  FeedbackTelemetry,
  FeedbackTransport
} from "@feedback/core";
export type {
  FeedbackHostContextV1,
  FeedbackLocationV1,
  FeedbackReviewContextV1,
  FeedbackTargetV1
} from "@feedback/contracts";
export { createDomEvidenceProvider } from "./capture.js";
export type { DomCaptureRenderOptions, DomEvidenceProviderOptions } from "./capture.js";
export { FeedbackOverlay, createLocalStorageParticipantAdapter, feedbackThreadMatchesLocation } from "./overlay.js";
export type { FeedbackOverlayProps, LocalStorageParticipantAdapter } from "./overlay.js";
