import type { FeedbackHostAdapter, FeedbackLocationV1 } from "@feedback/core";
import { resolveFeedbackLocation } from "@feedback/core";
import { feedbackApplicationManifest } from "./appRoutes";

export type WebGisFeedbackHostAdapterOptions = {
  environmentKey: string;
  release: string;
  getWorkspaceKey(): string;
  getPathname(): string;
  getSearch(): string;
  getAccessToken(): string | null | Promise<string | null>;
  refreshAccessToken?(): Promise<string | null>;
  navigate(path: string): void | Promise<void>;
};

/** Web GIS 固有のproject/router/authを、Feedback v1の安定HostAdapterへ変換する。 */
export function createWebGisFeedbackHostAdapter(
  options: WebGisFeedbackHostAdapterOptions
): FeedbackHostAdapter {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: feedbackApplicationManifest.applicationKey,
      environmentKey: options.environmentKey,
      externalWorkspaceKey: options.getWorkspaceKey(),
      release: options.release,
      locale: "ja-JP"
    }),
    getLocation: () => resolveFeedbackLocation(
      feedbackApplicationManifest,
      options.getPathname(),
      options.getSearch()
    ),
    getAccessToken: async () => await options.getAccessToken(),
    ...(options.refreshAccessToken ? { refreshAccessToken: options.refreshAccessToken } : {}),
    navigate: (location, threadId) => options.navigate(
      buildWebGisFeedbackPath(location, options.getWorkspaceKey(), threadId)
    )
  };
}

/** 登録済みroute templateと保存許可済みparameterだけからdeep linkを再構築する。 */
export function buildWebGisFeedbackPath(
  location: FeedbackLocationV1,
  externalWorkspaceKey: string,
  threadId: string
): string {
  const pathname = location.routeTemplate.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_segment, name: string) => encodeURIComponent(location.pathParameters[name] ?? "")
  );
  const search = new URLSearchParams(location.queryParameters ?? {});
  search.set("projectId", externalWorkspaceKey);
  search.set("threadId", threadId);
  return `${pathname}?${search}`;
}
