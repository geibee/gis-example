import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewSession } from "./contracts";
import { FeedbackPluginProvider } from "./plugin-context";
import { feedbackPluginKeys, useOpenReviewSessionQuery } from "./queries";

function Probe() {
  const query = useOpenReviewSessionQuery();
  return <output aria-label="セッション">{query.data?.projectId ?? "loading"}</output>;
}

describe("FeedbackPluginProvider", () => {
  it("projectId変更時にキャッシュを混在させない", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const requestFetch = vi.fn(async (input: RequestInfo | URL) => {
      const projectId = new URL(String(input)).searchParams.get("projectId")!;
      const session = {
        id: `session-${projectId}`,
        projectId,
        title: projectId,
        status: "open",
        evidenceRetentionDays: null,
        effectiveEvidenceRetentionDays: null,
        createdAt: "2026-08-08T00:00:00Z",
        updatedAt: "2026-08-08T00:00:00Z",
        perspectives: [],
        scopes: []
      } satisfies ReviewSession;
      return new Response(JSON.stringify([session]), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", requestFetch);
    const props = {
      apiBaseUrl: "https://feedback.example.test",
      appVersion: "test",
      routes: [{ pageId: "host.home", path: "/", label: "ホーム" }],
      getAccessToken: () => "token",
      queryClient
    };
    const view = render(<FeedbackPluginProvider {...props} projectId="p1"><Probe /></FeedbackPluginProvider>);
    expect(await screen.findByText("p1")).toBeInTheDocument();
    view.rerender(<FeedbackPluginProvider {...props} projectId="p2"><Probe /></FeedbackPluginProvider>);
    expect(await screen.findByText("p2")).toBeInTheDocument();
    expect(queryClient.getQueryData(feedbackPluginKeys.sessions("p1", "open"))).toBeDefined();
    expect(queryClient.getQueryData(feedbackPluginKeys.sessions("p2", "open"))).toBeDefined();
  });
});
