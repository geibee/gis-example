import { createRoot } from "react-dom/client";
import { FeedbackErrorBoundary, FeedbackOverlay, FeedbackProvider } from "@feedback/react";
import type { FeedbackHostAdapter, FeedbackTransport } from "@feedback/core";
import "@feedback/react/styles.css";

const adapter: FeedbackHostAdapter = {
  getContext: () => ({
    schemaVersion: "1",
    applicationKey: "clean-fixture",
    environmentKey: "test",
    externalWorkspaceKey: "workspace-1",
    release: "fixture"
  }),
  getLocation: () => ({ schemaVersion: "1", pageKey: "home", routeTemplate: "/", pathParameters: {} }),
  getAccessToken: async () => null,
  navigate: () => undefined
};

const transport = {
  getCapabilities: async () => ({
    apiVersion: "1.0",
    apiMajorVersion: 1,
    manifestSchemaVersions: ["1"],
    targetSchemaVersions: ["1"],
    evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
    features: []
  }),
  getReviewContext: async () => ({
    session: null,
    scope: "unregistered",
    posting: "deny",
    permissions: [],
    participantPolicy: { mode: "authenticated-identity" },
    evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
  }),
  request: async () => { throw new Error("fixtureではHTTP接続しません"); },
  requestBinary: async () => { throw new Error("fixtureではHTTP接続しません"); }
} as unknown as FeedbackTransport;

createRoot(document.getElementById("root")!).render(
  <FeedbackErrorBoundary>
    <FeedbackProvider adapter={adapter} transport={transport}>
      <main data-feedback-key="home"><h1>Clean fixture</h1></main>
      <FeedbackOverlay />
    </FeedbackProvider>
  </FeedbackErrorBoundary>
);
