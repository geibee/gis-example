import { describe, expect, it } from "vitest";
import { buildFeedbackPermalink, feedbackPermalinkPath } from "./feedbackPermalink";
import { makeFeedbackThread } from "./testing/fixtures";

describe("feedback permalink", () => {
  it("具体的な詳細画面URLへprojectIdとfeedbackThreadを付ける", () => {
    const permalink = buildFeedbackPermalink(
      makeFeedbackThread({ id: "ft-42", pageRoute: "/lands/L-7?tab=owner" }),
      "p1",
      "https://gis.example.test"
    );

    expect(permalink).toBe("https://gis.example.test/lands/L-7?tab=owner&projectId=p1&feedbackThread=ft-42");
    expect(feedbackPermalinkPath(permalink)).toBe("/lands/L-7?tab=owner&projectId=p1&feedbackThread=ft-42");
  });

  it("外部originが保存されていても現在のホストから遷移しない", () => {
    const permalink = buildFeedbackPermalink(
      makeFeedbackThread({ pageRoute: "https://evil.example/lands/L-9" }),
      "p1",
      "https://gis.example.test"
    );

    expect(permalink).toMatch(/^https:\/\/gis\.example\.test\/lands\/L-9\?/);
  });
});
