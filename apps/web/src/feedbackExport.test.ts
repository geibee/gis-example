import { describe, expect, it, vi } from "vitest";
import { makeFeedbackThread, makeReviewSession } from "./testing/fixtures";
import { buildFeedbackExportCsv, loadFeedbackThreadsForExport } from "./feedbackExport";

describe("feedback export", () => {
  it("画面・対象・投稿者・返信をExcel用CSVへ出力する", () => {
    const session = makeReviewSession();
    const thread = makeFeedbackThread({
      reviewScopeId: session.scopes[0].id,
      targetMetadata: {
        type: "UI_ELEMENT",
        feedbackTargetId: "contract.save",
        relativeX: 0.5,
        relativeY: 0.5
      },
      messages: [
        {
          id: "m1",
          threadId: "ft1",
          authorId: "u1",
          authorName: "利用者A",
          body: "=HYPERLINK(\"危険\")",
          createdAt: "2026-08-08T00:00:00Z",
          editedAt: null
        },
        {
          id: "m2",
          threadId: "ft1",
          authorId: "u2",
          authorName: "担当者B",
          body: "対応します",
          createdAt: "2026-08-08T01:00:00Z",
          editedAt: null
        }
      ]
    });

    const csv = buildFeedbackExportCsv(session, [thread]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("画面要素: contract.save");
    expect(csv).toContain("利用者A");
    expect(csv).toContain("担当者B");
    expect(csv).toContain("'=HYPERLINK");
  });

  it("1000件を超える場合はページを継続取得する", async () => {
    const items = Array.from({ length: 1001 }, (_, index) => makeFeedbackThread({ id: `ft-${index}` }));
    const loader = vi.fn(async (query: { offset?: number; limit?: number }) => ({
      items: items.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 1000)),
      totalCount: items.length
    }));

    const result = await loadFeedbackThreadsForExport({ projectId: "p1" }, loader);

    expect(result).toHaveLength(1001);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
