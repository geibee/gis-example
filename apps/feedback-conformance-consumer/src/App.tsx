import { useEffect, useMemo, useState } from "react";
import { FeedbackErrorBoundary, FeedbackOverlay, FeedbackProvider, FeedbackUnavailable } from "@feedback/react";
import { createFeedbackTransport, type FeedbackTransport } from "@feedback/core";
import {
  buildInventoryFeedbackPath,
  createInventoryHostAdapter,
  deepLinkThread,
  type FixtureRouter
} from "./hostAdapter";
import { browserTokenBroker, FeedbackTokenExchangeAdapter } from "./tokenExchange";

export type InventoryConsumerProps = {
  transport?: FeedbackTransport;
  tokenExchange?: FeedbackTokenExchangeAdapter;
};

export function InventoryConsumer({ transport: injectedTransport, tokenExchange: injectedExchange }: InventoryConsumerProps) {
  const route = useNativeRoute();
  const tokenExchange = useMemo(
    () => injectedExchange ?? new FeedbackTokenExchangeAdapter(browserTokenBroker),
    [injectedExchange]
  );
  const router = useMemo<FixtureRouter>(() => ({
    pathname: () => window.location.pathname,
    search: () => window.location.search,
    navigate: (path) => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }), []);
  const adapter = useMemo(() => createInventoryHostAdapter({
    environmentKey: "fixture",
    release: "consumer-2",
    router,
    tokenExchange
  }), [route, router, tokenExchange]);
  const transport = useMemo(() => injectedTransport ?? createFeedbackTransport({
    baseUrl: "/feedback/v1",
    getAccessToken: adapter.getAccessToken,
    refreshAccessToken: adapter.refreshAccessToken,
    fetch: (url, init) => fetch(url, init)
  }), [adapter, injectedTransport]);
  const currentSite = /^\/sites\/([^/]+)/.exec(window.location.pathname)?.[1] ?? "east";

  return <FeedbackErrorBoundary fallback={<p>Feedback UI failed safely.</p>}>
    <FeedbackProvider
      key={`${currentSite}:${route}`}
      adapter={adapter}
      transport={transport}
      features={{ contextMenu: true, evidenceCapture: false }}
      messages={{ launcher: "Send feedback", comment: "Comment", submit: "Post", participantName: "Display name" }}
    >
      <header className="fixture-header" data-feedback-exclude="">
        <strong>Inventory Approval</strong>
        <nav>
          <button type="button" onClick={() => router.navigate(`/sites/${currentSite}/inventory`)}>Inventory</button>
          <button type="button" onClick={() => router.navigate(`/sites/${currentSite}/approvals/REQ-7`)}>Approvals</button>
          <button type="button" onClick={() => router.navigate(`/sites/${currentSite === "east" ? "west" : "east"}/inventory`)}>
            Switch site
          </button>
        </nav>
      </header>
      <FixtureScreen route={window.location.pathname} />
      <FeedbackUnavailable />
      <FeedbackOverlay deepLinkThreadId={deepLinkThread(window.location.search)} />
    </FeedbackProvider>
  </FeedbackErrorBoundary>;
}

function FixtureScreen({ route }: { route: string }) {
  const itemMatch = /^\/sites\/([^/]+)\/inventory\/([^/]+)/.exec(route);
  const approvalMatch = /^\/sites\/([^/]+)\/approvals\/([^/]+)/.exec(route);
  if (itemMatch) return <main>
    <h1>Inventory item</h1>
    <article data-feedback-key="inventory-card">
      <strong>{decodeURIComponent(itemMatch[2])}</strong>
      <span data-feedback-mask="">supplier@example.invalid</span>
    </article>
  </main>;
  if (approvalMatch) return <main>
    <h1>Approval request</h1>
    <button type="button" data-feedback-key="approval.decision">Approve {decodeURIComponent(approvalMatch[2])}</button>
  </main>;
  return <main>
    <h1>Inventory</h1>
    <a href={`/sites/${decodeURIComponent(route.split("/")[2] ?? "east")}/inventory/SKU-7`}>SKU-7</a>
  </main>;
}

function useNativeRoute(): string {
  const [route, setRoute] = useState(() => `${window.location.pathname}${window.location.search}`);
  useEffect(() => {
    const update = () => setRoute(`${window.location.pathname}${window.location.search}`);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}

// 型レベルでもHostAdapterのdeep link builderをconsumer appへ組み込む。
export const inventoryDeepLinkBuilder = buildInventoryFeedbackPath;
