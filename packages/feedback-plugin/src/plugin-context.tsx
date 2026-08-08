import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  createFeedbackApiClient,
  type FeedbackApiClient,
  type TokenGetter,
  type TokenRefresher
} from "./api";
import { FeedbackStateProvider } from "./state";
import type { FeedbackPluginNotificationHandler } from "./types";
import { matchFeedbackRoute, type FeedbackRouteDefinition } from "./routes";

export type FeedbackPluginProviderProps = {
  apiBaseUrl: string;
  projectId: string;
  appVersion: string;
  /** ホストアプリが明示的に公開する画面ルートの一覧。 */
  routes: readonly FeedbackRouteDefinition[];
  /** SPAルーターが保持する現在のpathname。省略時はwindow.location.pathnameを使う。 */
  currentPath?: string;
  getAccessToken: TokenGetter;
  refreshAccessToken?: TokenRefresher;
  onNotification?: FeedbackPluginNotificationHandler;
  /** 端末ごとの自己申告名を保存するlocalStorageキー。 */
  participantNameStorageKey?: string;
  queryClient?: QueryClient;
  children: ReactNode;
};

type FeedbackPluginContextValue = {
  api: FeedbackApiClient;
  projectId: string;
  appVersion: string;
  currentPageId?: string;
  currentPath: string;
  participantName: string | null;
  saveParticipantName: (name: string) => void;
  notify: FeedbackPluginNotificationHandler;
};

const FeedbackPluginContext = createContext<FeedbackPluginContextValue | null>(null);
const ignoreNotification: FeedbackPluginNotificationHandler = () => undefined;
export const defaultParticipantNameStorageKey = "web-gis.feedback.participant-name";

export function FeedbackPluginProvider({
  apiBaseUrl,
  projectId,
  appVersion,
  routes,
  currentPath,
  getAccessToken,
  refreshAccessToken,
  onNotification,
  participantNameStorageKey = defaultParticipantNameStorageKey,
  queryClient,
  children
}: FeedbackPluginProviderProps) {
  const internalQueryClient = useRef<QueryClient>();
  if (!internalQueryClient.current) {
    internalQueryClient.current = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
  }
  const activeQueryClient = queryClient ?? internalQueryClient.current;
  const notify = onNotification ?? ignoreNotification;
  const [participantName, setParticipantName] = useState<string | null>(() =>
    readParticipantName(participantNameStorageKey)
  );
  const saveParticipantName = useCallback((name: string) => {
    const normalized = normalizeParticipantName(name);
    setParticipantName(normalized);
    if (typeof window === "undefined") return;
    try {
      if (normalized) window.localStorage.setItem(participantNameStorageKey, normalized);
      else window.localStorage.removeItem(participantNameStorageKey);
    } catch {
      // localStorageが無効でも、このタブ内では入力名を保持して投稿を続行する。
    }
  }, [participantNameStorageKey]);
  useEffect(() => {
    setParticipantName(readParticipantName(participantNameStorageKey));
    if (typeof window === "undefined") return;
    const syncParticipantName = (event: StorageEvent) => {
      if (event.key === participantNameStorageKey) {
        setParticipantName(normalizeParticipantName(event.newValue));
      }
    };
    window.addEventListener("storage", syncParticipantName);
    return () => window.removeEventListener("storage", syncParticipantName);
  }, [participantNameStorageKey]);
  const api = useMemo(
    () =>
      createFeedbackApiClient({
        apiBaseUrl,
        getAccessToken,
        refreshAccessToken,
        onNotification: notify
      }),
    [apiBaseUrl, getAccessToken, notify, refreshAccessToken]
  );
  const resolvedCurrentPath = currentPath ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  const activeRoute = useMemo(
    () => matchFeedbackRoute(routes, resolvedCurrentPath),
    [resolvedCurrentPath, routes]
  );
  const value = useMemo(
    () => ({
      api,
      projectId,
      appVersion,
      currentPageId: activeRoute?.pageId,
      currentPath: resolvedCurrentPath,
      participantName,
      saveParticipantName,
      notify
    }),
    [activeRoute, api, appVersion, notify, participantName, projectId, resolvedCurrentPath, saveParticipantName]
  );

  return (
    <QueryClientProvider client={activeQueryClient}>
      <FeedbackPluginContext.Provider value={value}>
        <FeedbackStateProvider>{children}</FeedbackStateProvider>
      </FeedbackPluginContext.Provider>
    </QueryClientProvider>
  );
}

function readParticipantName(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeParticipantName(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function normalizeParticipantName(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 100) : null;
}

export function useFeedbackPluginContext(): FeedbackPluginContextValue {
  const context = useContext(FeedbackPluginContext);
  if (!context) {
    throw new Error("フィードバックSDKはFeedbackPluginProviderの内側で使用してください");
  }
  return context;
}
