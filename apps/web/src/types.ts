export type Project = {
  id: string;
  name: string;
  createdAt: string;
};

export type LayerAttribute = {
  name: string;
  dataType: string;
  ordinalPosition: number;
};

export type Layer = {
  id: string;
  projectId: string;
  name: string;
  schemaName: string;
  tableName: string;
  geometryColumn: string;
  geometryType: string;
  sourceSrid?: number | null;
  displaySrid: number;
  featureIdColumn: string;
  bbox4326?: [number, number, number, number] | null;
  rowCount: number;
  isResult: boolean;
  tileSourceId: string;
  attributes: LayerAttribute[];
  createdAt: string;
};

export type ImportJob = {
  id: string;
  projectId: string;
  filename: string;
  format: string;
  sourceSrid?: number | null;
  status: "pending" | "running" | "succeeded" | "failed";
  errorMessage?: string | null;
  layerId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type AnalysisJob = {
  id: string;
  projectId: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed";
  errorMessage?: string | null;
  resultLayerId?: string | null;
  resultCount?: number | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type Feature = {
  layerId: string;
  featureId: string;
  properties: Record<string, unknown>;
  geometry?: unknown;
};

export type AttributeConditionDraft = {
  id: string;
  layerId: string;
  field: string;
  operator: string;
  value: string;
};

export type SpatialConditionDraft = {
  id: string;
  layerId: string;
  operator: string;
  distanceMeters: string;
};
