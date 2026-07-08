// API クライアント。型は OpenAPI 生成物 (contracts/generated.ts) を正とし、
// openapi-fetch がパス・クエリ・ボディを契約どおりに型検査する。
// 共通ラッパの責務:
// - Bearer トークン付与 (ミドルウェア)
// - タイムアウト (REQUEST_TIMEOUT_MS)
// - 冪等な GET のみの限定リトライ (1 回。ネットワークエラー / タイムアウト / 5xx)
// - エラーレスポンス ({ error }) の Error への変換と 401 の再ログイン誘導
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./contracts/generated";
import type {
  AnalysisJob,
  AnalysisJobRequest,
  Building,
  BuildingWriteRequest,
  BusinessLinks,
  BusinessSpatialSearchRequest,
  ConditionQuery,
  Feature,
  FeatureSearchResult,
  FeatureUpdateRequest,
  ImportJob,
  Land,
  LandWriteRequest,
  Layer,
  Me,
  Party,
  PartyRelationship,
  PartyRelationshipWriteRequest,
  PartyWriteRequest,
  Project,
  ProjectMember,
  UserAccount,
  UserPatchRequest,
  Zone,
  ZoneLayerFromImportRequest,
  ZoneLayerOperation,
  ZonePartySummary,
  ZoneWriteRequest
} from "./contracts";
import type { BusinessObjectFilters } from "./appTypes";
import { getAccessToken, notifyUnauthorized } from "./auth";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

const REQUEST_TIMEOUT_MS = 30_000;

// 冪等 (GET) のみ 1 回だけ再試行する。POST/PATCH/DELETE は二重実行の危険があるため対象外
async function fetchWithResilience(request: Request): Promise<Response> {
  const retryable = request.method === "GET";
  const attempt = () =>
    fetch(request.clone(), {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    });
  try {
    const response = await attempt();
    if (retryable && response.status >= 500) {
      return await attempt();
    }
    return response;
  } catch (error) {
    // 呼び出し側による中断は再試行しない (ネットワークエラー・タイムアウトのみ)
    if (retryable && !request.signal.aborted) {
      return attempt();
    }
    throw error;
  }
}

const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = getAccessToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  }
};

const client = createClient<paths>({ baseUrl: API_BASE, fetch: fetchWithResilience });
client.use(authMiddleware);

function raiseApiError(response: Response, error: unknown): never {
  if (response.status === 401) {
    // トークン失効・ユーザー無効化。再ログインへ誘導する
    notifyUnauthorized();
    throw new Error("認証の有効期限が切れました。再ログインしてください");
  }
  const message =
    typeof error === "object" && error !== null && "error" in error && typeof (error as { error: unknown }).error === "string"
      ? (error as { error: string }).error
      : response.statusText;
  throw new Error(message);
}

// openapi-fetch の { data, error, response } を「成功データ or throw」へ変換する
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    raiseApiError(result.response, result.error);
  }
  return result.data as T;
}

function unwrapVoid(result: { error?: unknown; response: Response }): void {
  if (result.error !== undefined || !result.response.ok) {
    raiseApiError(result.response, result.error);
  }
}

// 空文字は「未指定」としてクエリから落とす (従来の queryString 挙動を踏襲)
function nonEmpty(value: string | undefined): string | undefined {
  return value || undefined;
}

function parseDistance(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// BusinessObjectFilters (UI の横断フィルタ状態) を各エンドポイントが宣言する
// クエリパラメータの部分集合へ写像する (契約にないパラメータは送らない)
function landsAndBuildingsFilterQuery(filters?: BusinessObjectFilters) {
  return {
    status: nonEmpty(filters?.status),
    partyType: nonEmpty(filters?.partyType),
    relationType: nonEmpty(filters?.relationType),
    linkedOnly: filters?.linkedOnly ? true : undefined,
    sourceLayerId: nonEmpty(filters?.sourceLayerId),
    bbox: nonEmpty(filters?.bbox),
    intersectsLayerId: nonEmpty(filters?.intersectsLayerId),
    intersectsFeatureId: nonEmpty(filters?.intersectsFeatureId),
    distanceMeters: parseDistance(filters?.distanceMeters)
  };
}

export async function getProjects(): Promise<Project[]> {
  return unwrap(await client.GET("/api/projects"));
}

export async function getLayers(projectId?: string): Promise<Layer[]> {
  return unwrap(await client.GET("/api/layers", { params: { query: { projectId: projectId ?? "" } } }));
}

export async function deleteLayer(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/layers/{id}", { params: { path: { id } } }));
}

export async function deleteResultSet(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/result-sets/{id}", { params: { path: { id } } }));
}

export async function getFeature(layerId: string, featureId: string): Promise<Feature> {
  return unwrap(
    await client.GET("/api/layers/{id}/features/{featureId}", {
      params: { path: { id: layerId, featureId } }
    })
  );
}

export async function getLayerAttributeValues(layerId: string, field: string, limit = 80): Promise<string[]> {
  return unwrap(
    await client.GET("/api/layers/{id}/attribute-values", {
      params: { path: { id: layerId }, query: { field, limit } }
    })
  );
}

export async function updateFeature(layerId: string, featureId: string, body: FeatureUpdateRequest): Promise<Feature> {
  return unwrap(
    await client.PATCH("/api/layers/{id}/features/{featureId}", {
      params: { path: { id: layerId, featureId } },
      body
    })
  );
}

export async function getBusinessLinks(layerId: string, featureId: string): Promise<BusinessLinks> {
  return unwrap(
    await client.GET("/api/features/{layerId}/{featureId}/business-links", {
      params: { path: { layerId, featureId } }
    })
  );
}

export async function searchFeatures(params: {
  projectId?: string;
  layerId?: string;
  q?: string;
  field?: string;
  operator?: string;
  value?: string;
  linkedOnly?: boolean;
  limit?: number;
}): Promise<FeatureSearchResult[]> {
  return unwrap(
    await client.GET("/api/features/search", {
      params: {
        query: {
          projectId: params.projectId ?? "",
          layerId: nonEmpty(params.layerId),
          q: nonEmpty(params.q),
          field: nonEmpty(params.field),
          operator: nonEmpty(params.operator),
          value: nonEmpty(params.value),
          linkedOnly: params.linkedOnly ? true : undefined,
          limit: params.limit
        }
      }
    })
  );
}

export async function searchBusinessSpatialFeatures(body: BusinessSpatialSearchRequest): Promise<FeatureSearchResult[]> {
  return unwrap(await client.POST("/api/features/business-spatial-search", { body }));
}

export async function conditionSearchFeatures(body: ConditionQuery): Promise<FeatureSearchResult[]> {
  return unwrap(await client.POST("/api/features/condition-search", { body }));
}

export async function getLands(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Land[]> {
  return unwrap(
    await client.GET("/api/lands", {
      params: {
        query: {
          projectId: projectId ?? "",
          q: nonEmpty(q),
          landUse: nonEmpty(filters?.landUse),
          ...landsAndBuildingsFilterQuery(filters)
        }
      }
    })
  );
}

export async function getLand(id: string): Promise<Land> {
  return unwrap(await client.GET("/api/lands/{id}", { params: { path: { id } } }));
}

export async function createLand(body: LandWriteRequest): Promise<Land> {
  return unwrap(await client.POST("/api/lands", { body }));
}

export async function updateLand(id: string, body: LandWriteRequest): Promise<Land> {
  return unwrap(await client.PATCH("/api/lands/{id}", { params: { path: { id } }, body }));
}

export async function deleteLand(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/lands/{id}", { params: { path: { id } } }));
}

export async function getBuildings(
  projectId?: string,
  q?: string,
  landId?: string,
  filters?: BusinessObjectFilters
): Promise<Building[]> {
  return unwrap(
    await client.GET("/api/buildings", {
      params: {
        query: {
          projectId: projectId ?? "",
          q: nonEmpty(q),
          landId: nonEmpty(filters?.landId) ?? nonEmpty(landId),
          buildingUse: nonEmpty(filters?.buildingUse),
          ...landsAndBuildingsFilterQuery(filters)
        }
      }
    })
  );
}

export async function getBuilding(id: string): Promise<Building> {
  return unwrap(await client.GET("/api/buildings/{id}", { params: { path: { id } } }));
}

export async function createBuilding(body: BuildingWriteRequest): Promise<Building> {
  return unwrap(await client.POST("/api/buildings", { body }));
}

export async function updateBuilding(id: string, body: BuildingWriteRequest): Promise<Building> {
  return unwrap(await client.PATCH("/api/buildings/{id}", { params: { path: { id } }, body }));
}

export async function deleteBuilding(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/buildings/{id}", { params: { path: { id } } }));
}

export async function getParties(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Party[]> {
  return unwrap(
    await client.GET("/api/parties", {
      params: {
        query: {
          projectId: projectId ?? "",
          q: nonEmpty(q),
          partyType: nonEmpty(filters?.partyType),
          relationType: nonEmpty(filters?.relationType),
          linkedOnly: filters?.linkedOnly ? true : undefined,
          targetType: filters?.targetType || undefined
        }
      }
    })
  );
}

export async function getParty(id: string): Promise<Party> {
  return unwrap(await client.GET("/api/parties/{id}", { params: { path: { id } } }));
}

export async function createParty(body: PartyWriteRequest): Promise<Party> {
  return unwrap(await client.POST("/api/parties", { body }));
}

export async function updateParty(id: string, body: PartyWriteRequest): Promise<Party> {
  return unwrap(await client.PATCH("/api/parties/{id}", { params: { path: { id } }, body }));
}

export async function deleteParty(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/parties/{id}", { params: { path: { id } } }));
}

export async function getZones(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Zone[]> {
  return unwrap(
    await client.GET("/api/zones", {
      params: {
        query: {
          projectId: projectId ?? "",
          q: nonEmpty(q),
          status: nonEmpty(filters?.status),
          zoneType: nonEmpty(filters?.zoneType),
          linkedOnly: filters?.linkedOnly ? true : undefined,
          zoneLayerId: nonEmpty(filters?.zoneLayerId),
          sourceLayerId: nonEmpty(filters?.sourceLayerId)
        }
      }
    })
  );
}

export async function getZone(id: string): Promise<Zone> {
  return unwrap(await client.GET("/api/zones/{id}", { params: { path: { id } } }));
}

export async function getZonePartySummary(id: string): Promise<ZonePartySummary> {
  return unwrap(await client.GET("/api/zones/{id}/party-summary", { params: { path: { id } } }));
}

export async function createZone(body: ZoneWriteRequest): Promise<Zone> {
  return unwrap(await client.POST("/api/zones", { body }));
}

export async function updateZone(id: string, body: ZoneWriteRequest): Promise<Zone> {
  return unwrap(await client.PATCH("/api/zones/{id}", { params: { path: { id } }, body }));
}

export async function deleteZone(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/zones/{id}", { params: { path: { id } } }));
}

export async function createZoneLayerFromImport(body: ZoneLayerFromImportRequest): Promise<ZoneLayerOperation> {
  return unwrap(await client.POST("/api/zone-layers/from-import", { body }));
}

export async function createPartyRelationship(body: PartyRelationshipWriteRequest): Promise<PartyRelationship> {
  return unwrap(await client.POST("/api/party-relationships", { body }));
}

export async function updatePartyRelationship(id: string, body: PartyRelationshipWriteRequest): Promise<PartyRelationship> {
  return unwrap(await client.PATCH("/api/party-relationships/{id}", { params: { path: { id } }, body }));
}

export async function deletePartyRelationship(id: string): Promise<void> {
  unwrapVoid(await client.DELETE("/api/party-relationships/{id}", { params: { path: { id } } }));
}

type ImportJobBody = paths["/api/import-jobs"]["post"]["requestBody"]["content"]["multipart/form-data"];

export async function createImportJob(formData: FormData): Promise<ImportJob> {
  return unwrap(
    await client.POST("/api/import-jobs", {
      // multipart は FormData をそのまま fetch へ渡す (boundary はブラウザが付与)
      body: formData as unknown as ImportJobBody,
      bodySerializer: (body) => body as unknown as FormData
    })
  );
}

export async function getImportJob(id: string): Promise<ImportJob> {
  return unwrap(await client.GET("/api/import-jobs/{id}", { params: { path: { id } } }));
}

export async function createAnalysisJob(body: AnalysisJobRequest): Promise<AnalysisJob> {
  return unwrap(await client.POST("/api/analysis-jobs", { body }));
}

export async function getAnalysisJob(id: string): Promise<AnalysisJob> {
  return unwrap(await client.GET("/api/analysis-jobs/{id}", { params: { path: { id } } }));
}

// ---------------------------------------------------------------- 認証・管理

export async function getMe(): Promise<Me> {
  return unwrap(await client.GET("/api/me"));
}

export async function getUsers(): Promise<UserAccount[]> {
  return unwrap(await client.GET("/api/users"));
}

export async function updateUser(id: string, patch: UserPatchRequest): Promise<UserAccount> {
  return unwrap(await client.PATCH("/api/users/{id}", { params: { path: { id } }, body: patch }));
}

export async function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  return unwrap(await client.GET("/api/projects/{id}/members", { params: { path: { id: projectId } } }));
}

export async function putProjectMember(
  projectId: string,
  userId: string,
  role: "editor" | "viewer"
): Promise<ProjectMember> {
  return unwrap(
    await client.PUT("/api/projects/{id}/members/{userId}", {
      params: { path: { id: projectId, userId } },
      body: { role }
    })
  );
}

export async function deleteProjectMember(projectId: string, userId: string): Promise<void> {
  unwrapVoid(
    await client.DELETE("/api/projects/{id}/members/{userId}", {
      params: { path: { id: projectId, userId } }
    })
  );
}
