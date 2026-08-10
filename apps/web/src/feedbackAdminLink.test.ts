import { describe, expect, it } from "vitest";
import { buildFeedbackAdminUrl } from "./feedbackAdminLink";

describe("Feedback Admin Console link", () => {
  it("公開scopeだけをqueryへ渡す", () => {
    expect(buildFeedbackAdminUrl("https://admin.example.test/", {
      applicationKey: "web-gis",
      environmentKey: "prod",
      externalWorkspaceKey: "project/1"
    })).toBe(
      "https://admin.example.test/?applicationKey=web-gis&environmentKey=prod&workspaceKey=project%2F1"
    );
  });

  it("レビュー開始操作を安全な固定値で渡す", () => {
    expect(buildFeedbackAdminUrl("https://admin.example.test/", {
      applicationKey: "web-gis",
      environmentKey: "local",
      externalWorkspaceKey: "workspace-1"
    }, "create-review")).toContain("action=create-review");
  });
});
