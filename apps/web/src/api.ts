import type {
  AnalysisJob,
  Building,
  BusinessObjectFilters,
  BusinessSpatialSearchRequest,
  BusinessLinks,
  ConditionQuery,
  Feature,
  FeatureSearchResult,
  ImportJob,
  Land,
  Layer,
  Me,
  Party,
  PartyRelationship,
  Project,
  ProjectMember,
  UserAccount,
  Zone,
  ZoneLayerOperation,
  ZonePartySummary
} from "./types";

import { getAccessToken, notifyUnauthorized } from "./auth";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

function withAuthHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

async function raiseApiError(response: Response): Promise<never> {
  if (response.status === 401) {
    // トークン失効・ユーザー無効化。再ログインへ誘導する
    notifyUnauthorized();
    throw new Error("認証の有効期限が切れました。再ログインしてください");
  }
  const body = await response.json().catch(() => ({ error: response.statusText }));
  throw new Error(body.error ?? response.statusText);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, withAuthHeaders(init));
  if (!response.ok) {
    await raiseApiError(response);
  }
  return response.json() as Promise<T>;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, withAuthHeaders(init));
  if (!response.ok) {
    await raiseApiError(response);
  }
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

function businessFilterParams(filters?: BusinessObjectFilters): Record<string, string | undefined> {
  if (!filters) return {};
  return {
    status: filters.status,
    zoneType: filters.zoneType,
    landUse: filters.landUse,
    buildingUse: filters.buildingUse,
    partyType: filters.partyType,
    relationType: filters.relationType,
    linkedOnly: filters.linkedOnly ? "true" : undefined,
    zoneLayerId: filters.zoneLayerId,
    sourceLayerId: filters.sourceLayerId,
    bbox: filters.bbox,
    intersectsLayerId: filters.intersectsLayerId,
    intersectsFeatureId: filters.intersectsFeatureId,
    distanceMeters: filters.distanceMeters,
    targetType: filters.targetType || undefined,
    landId: filters.landId
  };
}

export function getProjects(): Promise<Project[]> {
  return requestJson<Project[]>("/api/projects");
}

export function getLayers(projectId?: string): Promise<Layer[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson<Layer[]>(`/api/layers${query}`);
}

export function deleteLayer(id: string): Promise<void> {
  return requestVoid(`/api/layers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function deleteResultSet(id: string): Promise<void> {
  return requestVoid(`/api/result-sets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getFeature(layerId: string, featureId: string): Promise<Feature> {
  return requestJson<Feature>(`/api/layers/${layerId}/features/${encodeURIComponent(featureId)}`);
}

export function getLayerAttributeValues(layerId: string, field: string, limit = 80): Promise<string[]> {
  return requestJson<string[]>(
    `/api/layers/${encodeURIComponent(layerId)}/attribute-values${queryString({
      field,
      limit: String(limit)
    })}`
  );
}

export function updateFeature(layerId: string, featureId: string, body: unknown): Promise<Feature> {
  return requestJson<Feature>(`/api/layers/${layerId}/features/${encodeURIComponent(featureId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function getBusinessLinks(layerId: string, featureId: string): Promise<BusinessLinks> {
  return requestJson<BusinessLinks>(
    `/api/features/${encodeURIComponent(layerId)}/${encodeURIComponent(featureId)}/business-links`
  );
}

export function searchFeatures(params: {
  projectId?: string;
  layerId?: string;
  q?: string;
  field?: string;
  operator?: string;
  value?: string;
  linkedOnly?: boolean;
  limit?: number;
}): Promise<FeatureSearchResult[]> {
  return requestJson<FeatureSearchResult[]>(
    `/api/features/search${queryString({
      projectId: params.projectId,
      layerId: params.layerId,
      q: params.q,
      field: params.field,
      operator: params.operator,
      value: params.value,
      linkedOnly: params.linkedOnly ? "true" : undefined,
      limit: params.limit ? String(params.limit) : undefined
    })}`
  );
}

export function searchBusinessSpatialFeatures(body: BusinessSpatialSearchRequest): Promise<FeatureSearchResult[]> {
  return requestJson<FeatureSearchResult[]>("/api/features/business-spatial-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function conditionSearchFeatures(body: ConditionQuery): Promise<FeatureSearchResult[]> {
  return requestJson<FeatureSearchResult[]>("/api/features/condition-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function getLands(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Land[]> {
  return requestJson<Land[]>(`/api/lands${queryString({ projectId, q, ...businessFilterParams(filters) })}`);
}

export function getLand(id: string): Promise<Land> {
  return requestJson<Land>(`/api/lands/${encodeURIComponent(id)}`);
}

export function createLand(body: unknown): Promise<Land> {
  return requestJson<Land>("/api/lands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function updateLand(id: string, body: unknown): Promise<Land> {
  return requestJson<Land>(`/api/lands/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function deleteLand(id: string): Promise<void> {
  return requestVoid(`/api/lands/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getBuildings(
  projectId?: string,
  q?: string,
  landId?: string,
  filters?: BusinessObjectFilters
): Promise<Building[]> {
  return requestJson<Building[]>(`/api/buildings${queryString({ projectId, q, landId, ...businessFilterParams(filters) })}`);
}

export function getBuilding(id: string): Promise<Building> {
  return requestJson<Building>(`/api/buildings/${encodeURIComponent(id)}`);
}

export function createBuilding(body: unknown): Promise<Building> {
  return requestJson<Building>("/api/buildings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function updateBuilding(id: string, body: unknown): Promise<Building> {
  return requestJson<Building>(`/api/buildings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function deleteBuilding(id: string): Promise<void> {
  return requestVoid(`/api/buildings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getParties(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Party[]> {
  return requestJson<Party[]>(`/api/parties${queryString({ projectId, q, ...businessFilterParams(filters) })}`);
}

export function getParty(id: string): Promise<Party> {
  return requestJson<Party>(`/api/parties/${encodeURIComponent(id)}`);
}

export function createParty(body: unknown): Promise<Party> {
  return requestJson<Party>("/api/parties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function updateParty(id: string, body: unknown): Promise<Party> {
  return requestJson<Party>(`/api/parties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function deleteParty(id: string): Promise<void> {
  return requestVoid(`/api/parties/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getZones(projectId?: string, q?: string, filters?: BusinessObjectFilters): Promise<Zone[]> {
  return requestJson<Zone[]>(`/api/zones${queryString({ projectId, q, ...businessFilterParams(filters) })}`);
}

export function getZone(id: string): Promise<Zone> {
  return requestJson<Zone>(`/api/zones/${encodeURIComponent(id)}`);
}

export function getZonePartySummary(id: string): Promise<ZonePartySummary> {
  return requestJson<ZonePartySummary>(`/api/zones/${encodeURIComponent(id)}/party-summary`);
}

export function createZone(body: unknown): Promise<Zone> {
  return requestJson<Zone>("/api/zones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function updateZone(id: string, body: unknown): Promise<Zone> {
  return requestJson<Zone>(`/api/zones/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function deleteZone(id: string): Promise<void> {
  return requestVoid(`/api/zones/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createZoneLayerFromImport(body: {
  projectId?: string;
  layerId: string;
  name?: string | null;
  zoneType?: string | null;
  status?: string | null;
  nameField?: string | null;
}): Promise<ZoneLayerOperation> {
  return requestJson<ZoneLayerOperation>("/api/zone-layers/from-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function createPartyRelationship(body: unknown): Promise<PartyRelationship> {
  return requestJson<PartyRelationship>("/api/party-relationships", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function updatePartyRelationship(id: string, body: unknown): Promise<PartyRelationship> {
  return requestJson<PartyRelationship>(`/api/party-relationships/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function deletePartyRelationship(id: string): Promise<void> {
  return requestVoid(`/api/party-relationships/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createImportJob(formData: FormData): Promise<ImportJob> {
  return requestJson<ImportJob>("/api/import-jobs", {
    method: "POST",
    body: formData
  });
}

export function getImportJob(id: string): Promise<ImportJob> {
  return requestJson<ImportJob>(`/api/import-jobs/${id}`);
}

export function createAnalysisJob(body: unknown): Promise<AnalysisJob> {
  return requestJson<AnalysisJob>("/api/analysis-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function getAnalysisJob(id: string): Promise<AnalysisJob> {
  return requestJson<AnalysisJob>(`/api/analysis-jobs/${id}`);
}

// ---------------------------------------------------------------- 認証・管理

export function getMe(): Promise<Me> {
  return requestJson<Me>("/api/me");
}

export function getUsers(): Promise<UserAccount[]> {
  return requestJson<UserAccount[]>("/api/users");
}

export function updateUser(
  id: string,
  patch: { systemRole?: "admin" | "user"; isActive?: boolean }
): Promise<UserAccount> {
  return requestJson<UserAccount>(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
}

export function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  return requestJson<ProjectMember[]>(`/api/projects/${encodeURIComponent(projectId)}/members`);
}

export function putProjectMember(
  projectId: string,
  userId: string,
  role: "editor" | "viewer"
): Promise<ProjectMember> {
  return requestJson<ProjectMember>(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role })
    }
  );
}

export function deleteProjectMember(projectId: string, userId: string): Promise<void> {
  return requestVoid(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  );
}
