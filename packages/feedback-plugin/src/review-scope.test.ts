import { describe, expect, it } from "vitest";
import type { ReviewSession } from "./contracts";
import { resolveReviewPageScope } from "./review-scope";

const session: ReviewSession = {
  id: "session-1",
  projectId: "project-1",
  title: "画面確認",
  status: "open",
  evidenceRetentionDays: null,
  effectiveEvidenceRetentionDays: null,
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  perspectives: [],
  scopes: [
    {
      id: "scope-list",
      pageId: "zones.list",
      route: "/zones",
      reviewable: true,
      displayOrder: 1
    },
    {
      id: "scope-detail-all",
      pageId: "zones.detail",
      route: "/zones/{id}",
      reviewable: true,
      displayOrder: 2
    },
    {
      id: "scope-detail-excluded",
      pageId: "zones.detail",
      route: "/zones/excluded",
      reviewable: false,
      displayOrder: 3
    }
  ]
};

describe("resolveReviewPageScope", () => {
  it("一覧と{id}を含む詳細画面を対象として判定する", () => {
    expect(resolveReviewPageScope(session, "zones.list", "/zones")).toBe("reviewable");
    expect(resolveReviewPageScope(session, "zones.detail", "/zones/Z-1")).toBe("reviewable");
  });

  it("具体的な対象外ルートを画面種別全体の指定より優先する", () => {
    expect(resolveReviewPageScope(session, "zones.detail", "/zones/excluded")).toBe("excluded");
  });

  it("ルート一覧にない画面は対象外として扱う", () => {
    expect(resolveReviewPageScope(session, "lands.list", "/lands")).toBe("unscoped");
    expect(resolveReviewPageScope(session, undefined, "/unknown")).toBe("unscoped");
  });
});
