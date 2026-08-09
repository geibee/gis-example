import {
  resolveFeedbackLocation,
  type FeedbackHostAdapter,
  type FeedbackLocationV1
} from "@feedback/core";
import { inventoryFeedbackManifest } from "./manifest";
import type { FeedbackExchangeScope, FeedbackTokenExchangeAdapter } from "./tokenExchange";

export type FixtureRouter = {
  pathname(): string;
  search(): string;
  navigate(path: string): void | Promise<void>;
};

export type InventoryHostAdapterOptions = {
  environmentKey: string;
  release: string;
  router: FixtureRouter;
  tokenExchange: FeedbackTokenExchangeAdapter;
};

/** native History router と token exchange を安定した HostAdapter へ変換する。 */
export function createInventoryHostAdapter(options: InventoryHostAdapterOptions): FeedbackHostAdapter {
  const scope = (): FeedbackExchangeScope => ({
    applicationKey: inventoryFeedbackManifest.applicationKey,
    environmentKey: options.environmentKey,
    externalWorkspaceKey: workspaceFromPath(options.router.pathname())
  });
  return {
    getContext: () => ({
      schemaVersion: "1",
      ...scope(),
      release: options.release,
      locale: "en-US"
    }),
    getLocation: () => resolveFeedbackLocation(
      inventoryFeedbackManifest,
      options.router.pathname(),
      options.router.search()
    ),
    getAccessToken: () => options.tokenExchange.getAccessToken(scope()),
    refreshAccessToken: () => options.tokenExchange.getAccessToken(scope(), true),
    getIdentity: async () => options.tokenExchange.getIdentity(scope()),
    navigate: (location, threadId) => options.router.navigate(buildInventoryFeedbackPath(location, threadId))
  };
}

export function workspaceFromPath(pathname: string): string {
  const match = /^\/sites\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) throw new Error("URLからsite workspaceを解決できません");
  return decodeURIComponent(match[1]);
}

export function buildInventoryFeedbackPath(location: FeedbackLocationV1, threadId: string): string {
  const pathname = location.routeTemplate.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_segment, key: string) => {
    const value = location.pathParameters[key];
    if (value === undefined || value.startsWith("sha256:")) throw new Error(`deep link parameter ${key} を復元できません`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(location.queryParameters ?? {});
  query.set("feedbackThread", threadId);
  return `${pathname}?${query}`;
}

export function deepLinkThread(search: string): string | null {
  const value = new URLSearchParams(search).get("feedbackThread")?.trim();
  return value && value.length <= 200 ? value : null;
}
