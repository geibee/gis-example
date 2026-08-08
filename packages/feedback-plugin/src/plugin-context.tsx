import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
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
  queryClient?: QueryClient;
  children: ReactNode;
};

type FeedbackPluginContextValue = {
  api: FeedbackApiClient;
  projectId: string;
  appVersion: string;
  currentPageId?: string;
  notify: FeedbackPluginNotificationHandler;
};

const FeedbackPluginContext = createContext<FeedbackPluginContextValue | null>(null);
const ignoreNotification: FeedbackPluginNotificationHandler = () => undefined;

export function FeedbackPluginProvider({
  apiBaseUrl,
  projectId,
  appVersion,
  routes,
  currentPath,
  getAccessToken,
  refreshAccessToken,
  onNotification,
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
  const activeRoute = useMemo(
    () => matchFeedbackRoute(routes, currentPath ?? (typeof window === "undefined" ? "/" : window.location.pathname)),
    [currentPath, routes]
  );
  const value = useMemo(
    () => ({
      api,
      projectId,
      appVersion,
      currentPageId: activeRoute?.pageId,
      notify
    }),
    [activeRoute, api, appVersion, notify, projectId]
  );

  return (
    <QueryClientProvider client={activeQueryClient}>
      <FeedbackPluginContext.Provider value={value}>
        <FeedbackStateProvider>{children}</FeedbackStateProvider>
      </FeedbackPluginContext.Provider>
    </QueryClientProvider>
  );
}

export function useFeedbackPluginContext(): FeedbackPluginContextValue {
  const context = useContext(FeedbackPluginContext);
  if (!context) {
    throw new Error("フィードバックSDKはFeedbackPluginProviderの内側で使用してください");
  }
  return context;
}
