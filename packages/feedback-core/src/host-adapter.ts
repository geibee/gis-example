import type {
  FeedbackHostContextV1,
  FeedbackLocationV1,
  FeedbackParticipant,
  FeedbackTargetV1
} from "@feedback/contracts";

export type FeedbackEvidenceRequest = {
  context: FeedbackHostContextV1;
  location: FeedbackLocationV1;
  target: FeedbackTargetV1;
  excludeSelector: string;
  maskSelector: string;
};

/** DOM や Blob を要求しない、host から transport へ渡せる証跡表現。 */
export type FeedbackEvidencePayload = {
  bytes: Uint8Array;
  contentType: "image/png" | "image/webp";
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  capturedAt: string;
};

export type FeedbackEvidenceProvider = (
  request: FeedbackEvidenceRequest
) => Promise<FeedbackEvidencePayload | null>;

export type FeedbackHostAdapter = {
  getContext(): FeedbackHostContextV1;
  getLocation(): FeedbackLocationV1 | null;
  getAccessToken(): Promise<string | null>;
  refreshAccessToken?(): Promise<string | null>;
  getIdentity?(): Promise<FeedbackParticipant | null>;
  /** 自己申告名の保存先。未実装時は React package がメモリ内だけで保持する。 */
  getParticipantName?(): string | null | Promise<string | null>;
  setParticipantName?(value: string | null): void | Promise<void>;
  navigate(location: FeedbackLocationV1, threadId: string): void | Promise<void>;
  captureEvidence?: FeedbackEvidenceProvider;
};
