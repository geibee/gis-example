import { describe, expect, it } from "vitest";
import { defineFeedbackManifest, resolveFeedbackLocation, validateFeedbackLocation } from "./manifest";

const manifest = defineFeedbackManifest({
  schemaVersion: "1",
  applicationKey: "sample-app",
  displayName: "サンプル",
  manifestVersion: "2026.08.1",
  routes: [
    {
      pageKey: "orders.detail",
      template: "/orders/{orderId}",
      label: "注文詳細",
      parameters: { orderId: { persistence: "hash" } },
      queryParameters: { tab: { persistence: "store" }, token: { persistence: "discard" } }
    },
    {
      pageKey: "orders.new",
      template: "/orders/new",
      label: "注文登録"
    }
  ]
});

describe("application manifest", () => {
  it("静的routeを優先し、許可したqueryだけlocationへ載せる", () => {
    expect(resolveFeedbackLocation(manifest, "/orders/new", "?tab=main&token=secret")).toEqual({
      schemaVersion: "1",
      pageKey: "orders.new",
      routeTemplate: "/orders/new",
      pathParameters: {}
    });
    expect(resolveFeedbackLocation(manifest, "/orders/A%201", "?tab=history&token=secret")).toEqual({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "A 1" },
      queryParameters: { tab: "history" }
    });
  });

  it("未登録queryとroute不整合を拒否する", () => {
    expect(() => validateFeedbackLocation(manifest, {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "1" },
      queryParameters: { token: "secret" }
    })).toThrow("manifest未登録");
  });

  it("重複pageKeyとparameter policy漏れを拒否する", () => {
    expect(() => defineFeedbackManifest({ ...manifest, routes: [...manifest.routes, manifest.routes[0]] }))
      .toThrow("pageKeyが重複");
    expect(() => defineFeedbackManifest({
      ...manifest,
      routes: [{ ...manifest.routes[0], parameters: {} }]
    })).toThrow("parameter policy");
  });
});
