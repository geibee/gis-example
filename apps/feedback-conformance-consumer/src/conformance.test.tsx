import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackHostAdapter, FeedbackTransport } from "@feedback/core";
import { InventoryConsumer } from "./App";
import {
  buildInventoryFeedbackPath,
  createInventoryHostAdapter,
  deepLinkThread,
  type FixtureRouter
} from "./hostAdapter";
import { FeedbackTokenExchangeAdapter } from "./tokenExchange";

const sessionId = "91000000-0000-4000-8000-000000000001";
const threadId = "92000000-0000-4000-8000-000000000001";

beforeEach(() => {
  window.history.replaceState({}, "", "/sites/east/inventory/SKU-7?panel=stock&access_token=discard-me");
  vi.stubGlobal("crypto", { randomUUID: () => "93000000-0000-4000-8000-000000000001" });
});

describe("consumer 2 conformance", () => {
  it("native routerをmanifest locationへ変換し機微queryを破棄する", () => {
    const adapter = adapterForCurrentUrl();
    expect(adapter.getContext()).toMatchObject({
      applicationKey: "inventory-approval-fixture",
      environmentKey: "fixture",
      externalWorkspaceKey: "east"
    });
    expect(adapter.getLocation()).toEqual({
      schemaVersion: "1",
      pageKey: "inventory.item",
      routeTemplate: "/sites/{siteKey}/inventory/{sku}",
      pathParameters: { siteKey: "east", sku: "SKU-7" },
      queryParameters: { panel: "stock" }
    });
    expect(buildInventoryFeedbackPath(threadFixture().location, threadId)).toContain("feedbackThread=");
  });

  it("token exchangeをworkspaceごとに分離し有効期限前は再利用する", async () => {
    let now = 1000;
    const broker = vi.fn(async (scope: { externalWorkspaceKey: string }) => ({
      accessToken: `feedback-token:${scope.externalWorkspaceKey}:${now}`,
      expiresAtEpochSeconds: now + 60,
      participant: { principalId: `participant:${scope.externalWorkspaceKey}`, displayName: "Fixture reviewer" }
    }));
    const exchange = new FeedbackTokenExchangeAdapter(broker, () => now);
    const east = { applicationKey: "inventory-approval-fixture", environmentKey: "fixture", externalWorkspaceKey: "east" };
    const west = { ...east, externalWorkspaceKey: "west" };

    expect(await exchange.getAccessToken(east)).toBe("feedback-token:east:1000");
    expect(await exchange.getAccessToken(east)).toBe("feedback-token:east:1000");
    expect(await exchange.getAccessToken(west)).toBe("feedback-token:west:1000");
    expect(broker).toHaveBeenCalledTimes(2);
    expect(exchange.getIdentity(east)?.principalId).toBe("participant:east");
    now = 1031;
    expect(await exchange.getAccessToken(east)).toBe("feedback-token:east:1031");
  });

  it("投稿 DOM pin deep linkとworkspace切替をhost固有importなしで処理する", async () => {
    const posted: unknown[] = [];
    const contexts: string[] = [];
    let activeWorkspace = "east";
    const transport = createTransport({ posted, contexts, setActive: (value) => { activeWorkspace = value; }, active: () => activeWorkspace });
    render(<InventoryConsumer transport={transport} tokenExchange={exchangeFixture()} />);

    expect(await screen.findByRole("button", { name: "#11" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Check reorder threshold" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(posted).toHaveLength(1));

    window.history.pushState({}, "", `/sites/east/inventory?feedbackThread=${threadId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: /#11/ })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/sites/east/inventory/SKU-7"));
    expect(deepLinkThread(window.location.search)).toBe(threadId);

    fireEvent.click(screen.getByRole("button", { name: "Switch site" }));
    await waitFor(() => expect(contexts).toContain("west"));
    expect(screen.queryByRole("button", { name: "#11" })).toBeNull();
  });
});

function adapterForCurrentUrl(): FeedbackHostAdapter {
  const router: FixtureRouter = {
    pathname: () => window.location.pathname,
    search: () => window.location.search,
    navigate: (path) => window.history.pushState({}, "", path)
  };
  return createInventoryHostAdapter({
    environmentKey: "fixture",
    release: "test",
    router,
    tokenExchange: exchangeFixture()
  });
}

function exchangeFixture(): FeedbackTokenExchangeAdapter {
  return new FeedbackTokenExchangeAdapter(async (scope) => ({
    accessToken: `token:${scope.externalWorkspaceKey}`,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 60,
    participant: { principalId: `user:${scope.externalWorkspaceKey}`, displayName: "Fixture reviewer" }
  }));
}

function createTransport(state: {
  posted: unknown[];
  contexts: string[];
  setActive(value: string): void;
  active(): string;
}): FeedbackTransport {
  const thread = threadFixture();
  return {
    getCapabilities: async () => ({
      apiVersion: "1.0",
      apiMajorVersion: 1,
      manifestSchemaVersions: ["1"],
      targetSchemaVersions: ["1"],
      evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
      features: []
    }),
    getReviewContext: async (context) => {
      state.contexts.push(context.externalWorkspaceKey);
      state.setActive(context.externalWorkspaceKey);
      return {
        session: sessionFixture(context.externalWorkspaceKey),
        scope: "reviewable",
        posting: "allow",
        permissions: ["feedback.read", "feedback.comment", "feedback.manage"],
        participantPolicy: { mode: "authenticated-identity" },
        evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
      };
    },
    request: async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        state.posted.push(options.body);
        return { value: thread, etag: '"v1"' };
      }
      if (path.endsWith("/threads")) {
        return { value: { items: state.active() === "east" ? [thread] : [] }, etag: null };
      }
      if (path === `/threads/${threadId}`) return { value: thread, etag: '"v1"' };
      throw new Error(`unexpected conformance request: ${path}`);
    },
    requestBinary: async () => { throw new Error("fixture evidence disabled"); }
  } as FeedbackTransport;
}

function sessionFixture(workspace: string) {
  return {
    id: workspace === "east" ? sessionId : "94000000-0000-4000-8000-000000000001",
    applicationKey: "inventory-approval-fixture",
    environmentKey: "fixture",
    externalWorkspaceKey: workspace,
    manifestVersion: "2026.08.1",
    title: "Inventory review",
    description: null,
    status: "open" as const,
    outOfScopePosting: "warn" as const,
    startAt: null,
    endAt: null,
    scopes: [{ pageKey: "inventory.item", routeTemplate: "/sites/{siteKey}/inventory/{sku}", reviewable: true }],
    perspectives: [{ code: "workflow", label: "Workflow", status: "active" as const, guidance: null }],
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    version: 1
  };
}

function threadFixture() {
  return {
    id: threadId,
    sessionId,
    displayNumber: 11,
    location: {
      schemaVersion: "1" as const,
      pageKey: "inventory.item",
      routeTemplate: "/sites/{siteKey}/inventory/{sku}",
      pathParameters: { siteKey: "east", sku: "SKU-7" },
      queryParameters: { panel: "stock" }
    },
    target: {
      schemaVersion: "1" as const,
      kind: "ui-element" as const,
      elementKey: "inventory-card",
      relativeX: 0.5,
      relativeY: 0.5
    },
    perspectiveCode: "workflow",
    status: "open" as const,
    reporter: { principalId: "fixture-reviewer", displayName: "Fixture reviewer", participantName: null },
    evidenceAvailable: false,
    messages: [],
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    version: 1
  };
}
