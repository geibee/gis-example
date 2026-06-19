import type {
  AnalysisJob,
  Building,
  BusinessSpatialSearchRequest,
  BusinessLinks,
  ConditionQuery,
  Feature,
  FeatureSearchResult,
  ImportJob,
  Land,
  Layer,
  Party,
  Project
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
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

export function getProjects(): Promise<Project[]> {
  return requestJson<Project[]>("/api/projects");
}

export function getLayers(projectId?: string): Promise<Layer[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return requestJson<Layer[]>(`/api/layers${query}`);
}

export function getFeature(layerId: string, featureId: string): Promise<Feature> {
  return requestJson<Feature>(`/api/layers/${layerId}/features/${encodeURIComponent(featureId)}`);
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

export function getLands(projectId?: string, q?: string): Promise<Land[]> {
  return requestJson<Land[]>(`/api/lands${queryString({ projectId, q })}`);
}

export function getLand(id: string): Promise<Land> {
  return requestJson<Land>(`/api/lands/${encodeURIComponent(id)}`);
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

export function getBuildings(projectId?: string, q?: string, landId?: string): Promise<Building[]> {
  return requestJson<Building[]>(`/api/buildings${queryString({ projectId, q, landId })}`);
}

export function getBuilding(id: string): Promise<Building> {
  return requestJson<Building>(`/api/buildings/${encodeURIComponent(id)}`);
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

export function getParties(projectId?: string, q?: string): Promise<Party[]> {
  return requestJson<Party[]>(`/api/parties${queryString({ projectId, q })}`);
}

export function getParty(id: string): Promise<Party> {
  return requestJson<Party>(`/api/parties/${encodeURIComponent(id)}`);
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
