import type { AnalysisJob, Feature, ImportJob, Layer, Project } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
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
