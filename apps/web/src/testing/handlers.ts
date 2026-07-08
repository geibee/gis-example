// MSW の既定ハンドラ。App シェル (me / projects / layers) と各業務一覧の GET を
// 契約型 (contracts) のデータで返し、どの画面テストでもまず描画が成立する状態にする。
// テスト固有の応答は各テストで server.use(...) により上書きする。
//
// パスは "*/api/..." (ホスト非依存) で宣言する。実リクエストは vitest.config.ts の
// VITE_API_BASE (http://api.test) に向かう。
import { http, HttpResponse } from "msw";
import type {
  Building,
  FeatureSearchResult,
  Land,
  Layer,
  Me,
  Party,
  Project,
  ProjectMember,
  UserAccount,
  Zone,
  ZonePartySummary
} from "../contracts";
import {
  makeMe,
  makeProject,
  makeProjectMember,
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
