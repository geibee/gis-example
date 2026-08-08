// MSW の既定ハンドラ。App シェル (me / projects / layers) と各業務一覧の GET を
// 契約型 (contracts) のデータで返し、どの画面テストでもまず描画が成立する状態にする。
// テスト固有の応答は各テストで server.use(...) により上書きする。
//
// パスは "*/api/..." (ホスト非依存) で宣言する。実リクエストは vitest.config.ts の
// VITE_API_BASE (http://api.test) に向かう。
import { http, HttpResponse } from "msw";
import type {
  Building,
  FeedbackThread,
  FeedbackSummary,
  Feature,
  FeatureSearchResult,
  Land,
  Layer,
  Me,
  Party,
  Project,
  ProjectMember,
  ReviewRetentionPolicy,
  ReviewNotificationSettings,
  ReviewPerspectiveDefinition,
  ReviewSession,
  UserAccount,
  Zone,
  ZonePartySummary
} from "../contracts";
import {
  makeMe,
  makeFeedbackThread,
  makeProject,
  makeProjectMember,
  makeReviewSession,
  makeUserAccount,
  makeZone,
  makeZonePartySummary
} from "./fixtures";

export const defaultZones: Zone[] = [
  makeZone(),
  makeZone({ id: "Z-2", name: "丸の内二丁目区域", zoneType: "防火地域", status: "検討中", zoneFeatureId: "2", sourceFeatureId: "2" })
];

export const defaultHandlers = [
  http.get("*/api/me", () => HttpResponse.json<Me>(makeMe())),
  http.get("*/api/projects", () => HttpResponse.json<Project[]>([makeProject()])),
  http.get("*/api/layers", () => HttpResponse.json<Layer[]>([])),
  http.get("*/api/review-perspectives", () =>
    HttpResponse.json<ReviewPerspectiveDefinition[]>([
      {
        code: "BUSINESS_FLOW",
        label: "業務フロー",
        description: "一連の業務が想定どおり進められるか",
        displayOrder: 10
      },
      {
        code: "MAP_OPERATION",
        label: "地図操作",
        description: "地図と業務情報の連動を確認する",
        displayOrder: 40
      },
      {
        code: "UI_DESIGN",
        label: "デザイン・配色",
        description: null,
        displayOrder: 50
      },
      {
        code: "PERFORMANCE",
        label: "性能",
        description: null,
        displayOrder: 60
      }
    ])
  ),
  http.get("*/api/review-sessions", () => HttpResponse.json<ReviewSession[]>([makeReviewSession()])),
  http.get("*/api/review-sessions/:id/threads", () => HttpResponse.json<FeedbackThread[]>([])),
  http.get("*/api/threads", () => HttpResponse.json<FeedbackThread[]>([], { headers: { "X-Total-Count": "0" } })),
  http.get("*/api/threads/summary", () =>
    HttpResponse.json<FeedbackSummary>({
      totalCount: 0,
      openCount: 0,
      resolvedCount: 0,
      withEvidenceCount: 0,
      sessions: [],
      perspectives: []
    })
  ),
  http.get("*/api/review-retention", ({ request }) =>
    HttpResponse.json<ReviewRetentionPolicy>({
      projectId: new URL(request.url).searchParams.get("projectId") ?? "p1",
      defaultEvidenceRetentionDays: null,
      expiredEvidenceCount: 0,
      expiredEvidenceBytes: 0
    })
  ),
  http.get("*/api/review-notifications", ({ request }) =>
    HttpResponse.json<ReviewNotificationSettings>({
      projectId: new URL(request.url).searchParams.get("projectId") ?? "p1",
      emailEnabled: false,
      teamsEnabled: false,
      issueEnabled: false,
      emailAvailable: false,
      teamsAvailable: false,
      issueAvailable: false,
      pendingDeliveryCount: 0,
      failedDeliveryCount: 0,
      updatedAt: null
    })
  ),
  http.get("*/api/threads/:threadId", ({ params }) =>
    HttpResponse.json<FeedbackThread>(makeFeedbackThread({ id: String(params.threadId) }))
  ),

  http.get("*/api/zones", () => HttpResponse.json<Zone[]>(defaultZones)),
  http.get("*/api/zones/:id", ({ params }) => {
    const zone = defaultZones.find((item) => item.id === params.id);
    return zone ? HttpResponse.json<Zone>(zone) : HttpResponse.json({ error: "区域が見つかりません" }, { status: 404 });
  }),
  http.get("*/api/zones/:id/party-summary", ({ params }) =>
    HttpResponse.json<ZonePartySummary>(makeZonePartySummary({ zoneId: String(params.id) }))
  ),

  http.get("*/api/lands", () => HttpResponse.json<Land[]>([])),
  http.get("*/api/buildings", () => HttpResponse.json<Building[]>([])),
  http.get("*/api/parties", () => HttpResponse.json<Party[]>([])),
  http.get("*/api/features/search", () => HttpResponse.json<FeatureSearchResult[]>([])),
  http.get("*/api/layers/:layerId/features/:featureId", ({ params }) =>
    HttpResponse.json<Feature>({
      layerId: String(params.layerId),
      featureId: String(params.featureId),
      properties: {}
    })
  ),

  // 管理画面 (system admin)
  http.get("*/api/users", () =>
    HttpResponse.json<UserAccount[]>([
      makeUserAccount({ id: "u1", displayName: "管理者", systemRole: "admin" }),
      makeUserAccount({ id: "u2", subject: "auth|u2", email: "member@example.com", displayName: "メンバー" })
    ])
  ),
  http.get("*/api/projects/:id/members", () =>
    HttpResponse.json<ProjectMember[]>([makeProjectMember({ userId: "u2", displayName: "メンバー" })])
  )
];
