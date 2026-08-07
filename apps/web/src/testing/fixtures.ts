// OpenAPI 生成型 (contracts) と整合するモックデータのファクトリ。
// 戻り値の型注釈が契約型そのものなので、openapi.yaml の変更 (必須フィールド追加など) が
// あればここが型エラーになり、テストデータのドリフトを検知できる。
import type {
  Building,
  Land,
  Layer,
  Me,
  Party,
  Project,
  FeedbackThread,
  ProjectMember,
  ReviewSession,
  UserAccount,
  Zone,
  ZonePartySummary
} from "../contracts";

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "テストプロジェクト",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    userId: "u1",
    subject: "auth|u1",
    email: "user@example.com",
    displayName: "一般ユーザー",
    systemRole: "user",
    memberships: [{ projectId: "p1", role: "editor" }],
    ...overrides
  };
}

export function makeUserAccount(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: "u1",
    subject: "auth|u1",
    email: "user@example.com",
    displayName: "一般ユーザー",
    systemRole: "user",
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

export function makeProjectMember(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    userId: "u1",
    projectId: "p1",
    role: "viewer",
    email: "user@example.com",
    displayName: "一般ユーザー",
    ...overrides
  };
}

export function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "layer-1",
    projectId: "p1",
    name: "区域レイヤ",
    schemaName: "gis",
    tableName: "zones_1",
    geometryColumn: "geom",
    geometryType: "MULTIPOLYGON",
    displaySrid: 4326,
    featureIdColumn: "id",
    rowCount: 2,
    isResult: false,
    layerRole: "zone",
    tileSourceId: "ts-1",
    attributes: [{ name: "name", dataType: "text", ordinalPosition: 1 }],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

export function makeZone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: "Z-1",
    projectId: "p1",
    name: "大手町一丁目区域",
    zoneType: "市街化区域",
    status: "有効",
    memo: null,
    zoneLayerId: "layer-1",
    zoneFeatureId: "1",
    sourceLayerId: "layer-1",
    sourceFeatureId: "1",
    landCount: 0,
    buildingCount: 0,
    lands: [],
    buildings: [],
    ...overrides
  };
}

export function makeZonePartySummary(overrides: Partial<ZonePartySummary> = {}): ZonePartySummary {
  return {
    zoneId: "Z-1",
    containedCount: 0,
    partyCount: 0,
    typeBreakdown: [],
    tagBreakdown: [],
    parties: [],
    ...overrides
  };
}

export function makeLand(overrides: Partial<Land> = {}): Land {
  return {
    id: "L-1",
    projectId: "p1",
    lotNumber: "1-2-3",
    address: "東京都千代田区大手町一丁目",
    status: "調査中",
    buildings: [],
    relationships: [],
    ...overrides
  };
}

export function makeBuilding(overrides: Partial<Building> = {}): Building {
  return {
    id: "B-1",
    projectId: "p1",
    name: "大手町ビル",
    status: "調査中",
    relationships: [],
    ...overrides
  };
}

export function makeParty(overrides: Partial<Party> = {}): Party {
  return {
    id: "PT-1",
    projectId: "p1",
    name: "山田太郎",
    partyType: "個人",
    tags: [],
    relationships: [],
    ...overrides
  };
}

export function makeReviewSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: "rs-1",
    projectId: "p1",
    title: "第1回 業務フローレビュー",
    description: "案件検索から詳細確認までの流れを確認してください",
    status: "open",
    startAt: "2026-08-10T09:00:00+09:00",
    endAt: "2026-08-20T18:00:00+09:00",
    createdBy: "u1",
    createdAt: "2026-08-01T09:00:00+09:00",
    updatedAt: "2026-08-01T09:00:00+09:00",
    perspectives: [
      { code: "BUSINESS_FLOW", label: "業務フロー", description: null, displayOrder: 10, status: "ACTIVE", guidance: null },
      { code: "MAP_OPERATION", label: "地図操作", description: null, displayOrder: 40, status: "ACTIVE", guidance: null },
      {
        code: "UI_DESIGN",
        label: "デザイン・配色",
        description: null,
        displayOrder: 50,
        status: "FUTURE",
        guidance: "次回のデザインレビューで確認します"
      },
      {
        code: "PERFORMANCE",
        label: "性能",
        description: null,
        displayOrder: 60,
        status: "OUT_OF_SCOPE",
        guidance: "性能検証フェーズで確認します"
      }
    ],
    scopes: [
      { id: "sc-1", pageId: "/lands", description: "案件一覧", reviewable: true, displayOrder: 10 },
      { id: "sc-2", pageId: "/admin", description: "管理画面", reviewable: false, displayOrder: 20 }
    ],
    ...overrides
  };
}

export function makeFeedbackThread(overrides: Partial<FeedbackThread> = {}): FeedbackThread {
  return {
    id: "ft-1",
    projectId: "p1",
    reviewSessionId: "rs-1",
    reviewScopeId: null,
    pageId: "/zones",
    perspectiveCode: "BUSINESS_FLOW",
    perspectiveLabel: "業務フロー",
    targetType: "SCREEN_POSITION",
    targetMetadata: { type: "SCREEN_POSITION", relativeX: 0.4, relativeY: 0.6 },
    evidence: null,
    status: "OPEN",
    createdBy: "u1",
    createdByName: "顧客レビュアー",
    createdAt: "2026-08-12T10:15:00+09:00",
    updatedAt: "2026-08-12T10:15:00+09:00",
    messages: [
      {
        id: "fm-1",
        threadId: "ft-1",
        authorId: "u1",
        authorName: "顧客レビュアー",
        body: "検索後の流れが分かりにくい",
        createdAt: "2026-08-12T10:15:00+09:00",
        editedAt: null
      }
    ],
    ...overrides
  };
}
