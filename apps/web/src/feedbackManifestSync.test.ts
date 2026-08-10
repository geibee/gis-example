import { describe, expect, it, vi } from "vitest";
import {
  FeedbackTransportError,
  type FeedbackApplicationManifestV1,
  type FeedbackTransport
} from "@feedback/core";
import { syncFeedbackApplicationManifest } from "./feedbackManifestSync";

const manifest: FeedbackApplicationManifestV1 = {
  schemaVersion: "1",
  applicationKey: "web-gis",
  displayName: "Web GIS",
  manifestVersion: "2",
  routes: [{ pageKey: "zones.list", template: "/zones", label: "区域一覧" }]
};

describe("syncFeedbackApplicationManifest", () => {
  it("未登録ならホスト側の定義を登録する", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new FeedbackTransportError(404, null, "Not Found"))
      .mockResolvedValueOnce({ value: manifest, etag: '"v1"' });

    await expect(syncFeedbackApplicationManifest(transport(request), manifest)).resolves.toBe("created");
    expect(request).toHaveBeenNthCalledWith(2, "/applications/web-gis/manifest", {
      method: "PUT",
      body: manifest
    });
  });

  it("JSONのプロパティ順だけが異なる場合は更新しない", async () => {
    const request = vi.fn().mockResolvedValue({
      value: { ...manifest, routes: [{ label: "区域一覧", template: "/zones", pageKey: "zones.list" }] },
      etag: '"v1"'
    });

    await expect(syncFeedbackApplicationManifest(transport(request), manifest)).resolves.toBe("unchanged");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("新しいmanifestVersionはETag付きで追加する", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ value: { ...manifest, manifestVersion: "1", routes: [] }, etag: '"v4"' })
      .mockResolvedValueOnce({ value: manifest, etag: '"v5"' });

    await expect(syncFeedbackApplicationManifest(transport(request), manifest)).resolves.toBe("updated");
    expect(request).toHaveBeenNthCalledWith(2, "/applications/web-gis/manifest", {
      method: "PUT",
      body: manifest,
      ifMatch: '"v4"'
    });
  });

  it("同じmanifestVersionの内容は上書きしない", async () => {
    const request = vi.fn().mockResolvedValue({
      value: { ...manifest, displayName: "変更前" },
      etag: '"v1"'
    });

    await expect(syncFeedbackApplicationManifest(transport(request), manifest))
      .rejects.toThrow("manifestVersion 2 を更新してください");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function transport(request: ReturnType<typeof vi.fn>): FeedbackTransport {
  return {
    request: request as FeedbackTransport["request"],
    requestBinary: vi.fn(),
    getCapabilities: vi.fn(),
    getReviewContext: vi.fn()
  };
}
