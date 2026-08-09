export type FeedbackTelemetryEvent =
  | "capture_failure"
  | "post_success"
  | "service_unavailable";

export type FeedbackTelemetryDimensions = {
  applicationKey?: string;
  environmentKey?: string;
  externalWorkspaceKey?: string;
};

export interface FeedbackTelemetry {
  increment(event: FeedbackTelemetryEvent, dimensions?: FeedbackTelemetryDimensions): void;
}

export type FeedbackTelemetrySnapshot = Readonly<Record<FeedbackTelemetryEvent, number>>;

/** 本文やlocation parameterを保持しない、hostのmetrics adapterへ接続可能な最小counter。 */
export function createInMemoryFeedbackTelemetry(): FeedbackTelemetry & { snapshot(): FeedbackTelemetrySnapshot } {
  const counters: Record<FeedbackTelemetryEvent, number> = {
    capture_failure: 0,
    post_success: 0,
    service_unavailable: 0
  };
  return {
    increment(event) { counters[event] += 1; },
    snapshot: () => ({ ...counters })
  };
}
