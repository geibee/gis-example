import { defineFeedbackManifest } from "@feedback/core";

/** Web GIS と異なるURL・画面語彙を持つ consumer 2 の正本。 */
export const inventoryFeedbackManifest = defineFeedbackManifest({
  schemaVersion: "1",
  applicationKey: "inventory-approval-fixture",
  displayName: "在庫・承認 fixture",
  manifestVersion: "2026.08.1",
  routes: [
    {
      pageKey: "inventory.list",
      template: "/sites/{siteKey}/inventory",
      label: "在庫一覧",
      parameters: { siteKey: { persistence: "store" } },
      queryParameters: { view: { persistence: "store" }, access_token: { persistence: "discard" } }
    },
    {
      pageKey: "inventory.item",
      template: "/sites/{siteKey}/inventory/{sku}",
      label: "在庫詳細",
      parameters: {
        siteKey: { persistence: "store" },
        sku: { persistence: "store" }
      },
      queryParameters: { panel: { persistence: "store" }, access_token: { persistence: "discard" } }
    },
    {
      pageKey: "approval.request",
      template: "/sites/{siteKey}/approvals/{requestKey}",
      label: "承認依頼",
      parameters: {
        siteKey: { persistence: "store" },
        requestKey: { persistence: "store" }
      }
    }
  ]
});
