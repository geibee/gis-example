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
  layerRole: "generic" | "zone" | string;
  resultSetId?: string | null;
  resultSetName?: string | null;
  sourceLayerId?: string | null;
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
  layerRole: "generic" | "zone" | string;
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
  resultSetId?: string | null;
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

export type FeatureSearchResult = {
  layerId: string;
  layerName: string;
  featureId: string;
  properties: Record<string, unknown>;
  geometry?: unknown;
  matchSummary?: string | null;
  businessLinks: BusinessLinks;
  matchedBusinessLinks: BusinessLinks;
};

export type ConditionQuery = {
  projectId?: string;
  targetLayerIds: string[];
  keyword?: string;
  conditions: ConditionQueryCondition[];
  limit?: number;
};

export type ConditionQueryCondition =
  | {
      type: "attribute";
      layerId?: string;
      field: string;
      operator: string;
      value?: unknown;
      values?: string[];
    }
  | {
      type: "spatial";
      comparisonTarget: "layer" | "business";
      layerId?: string;
      spatialOperator: string;
      distanceMeters?: number;
    }
  | {
      type: "business";
      sourceTypes?: Array<"land" | "building">;
      businessQuery?: string;
      status?: string;
      landUse?: string;
      buildingUse?: string;
      partyQuery?: string;
      partyType?: string;
      relationType?: string;
    };

export type BusinessSpatialSearchRequest = {
  projectId?: string;
  targetLayerIds: string[];
  sourceTypes: Array<"land" | "building">;
  businessQuery?: string;
  status?: string;
  landUse?: string;
  buildingUse?: string;
  partyQuery?: string;
  partyType?: string;
  relationType?: string;
  spatialOperator?: string;
  distanceMeters?: number;
  limit?: number;
};

export type BusinessEntityLink = {
  id: string;
  label: string;
};

export type PartyRelationship = {
  id: string;
  projectId: string;
  partyId: string;
  partyName?: string | null;
  targetType: "land" | "building";
  targetId: string;
  targetLabel?: string | null;
  relationType: string;
  note?: string | null;
};

export type BusinessObjectFilters = {
  status?: string;
  zoneType?: string;
  landUse?: string;
  buildingUse?: string;
  partyType?: string;
  relationType?: string;
  linkedOnly?: boolean;
  zoneLayerId?: string;
  sourceLayerId?: string;
  bbox?: string;
  intersectsLayerId?: string;
  intersectsFeatureId?: string;
  distanceMeters?: string;
  targetType?: "land" | "building" | "";
  landId?: string;
};

export type Land = {
  id: string;
  projectId: string;
  lotNumber: string;
  address: string;
  landUse?: string | null;
  areaSqm?: number | null;
  registeredOwner?: string | null;
  rightType?: string | null;
  registrationCause?: string | null;
  registrationAcceptedOn?: string | null;
  status: string;
  memo?: string | null;
  sourceLayerId?: string | null;
  sourceFeatureId?: string | null;
  buildings: BusinessEntityLink[];
  relationships: PartyRelationship[];
};

export type Building = {
  id: string;
  projectId: string;
  landId?: string | null;
  landLabel?: string | null;
  name: string;
  buildingLocation?: string | null;
  houseNumber?: string | null;
  buildingUse?: string | null;
  floors?: number | null;
  totalFloorAreaSqm?: number | null;
  structure?: string | null;
  registeredOwner?: string | null;
  rightType?: string | null;
  registrationAcceptedOn?: string | null;
  status: string;
  memo?: string | null;
  sourceLayerId?: string | null;
  sourceFeatureId?: string | null;
  relationships: PartyRelationship[];
};

export type Party = {
  id: string;
  projectId: string;
  name: string;
  partyType: string;
  contact?: string | null;
  address?: string | null;
  memo?: string | null;
  tags: string[];
  relationships: PartyRelationship[];
};

export type ZonePartyBreakdown = {
  key: string;
  count: number;
};

export type ZonePartySummaryEntry = {
  id: string;
  name: string;
  partyType: string;
  tags: string[];
  zoneInvolvement: number;
  projectInvolvement: number;
  relationTypes: string[];
  coverageRatio: number;
};

export type ZonePartySummary = {
  zoneId: string;
  containedCount: number;
  partyCount: number;
  typeBreakdown: ZonePartyBreakdown[];
  tagBreakdown: ZonePartyBreakdown[];
  parties: ZonePartySummaryEntry[];
};

export type Zone = {
  id: string;
  projectId: string;
  name: string;
  zoneType?: string | null;
  status: string;
  memo?: string | null;
  zoneLayerId: string;
  zoneFeatureId: string;
  sourceLayerId: string;
  sourceFeatureId: string;
  landCount: number;
  buildingCount: number;
  lands: BusinessEntityLink[];
  buildings: BusinessEntityLink[];
};

export type ZoneLayerOperation = {
  layer: Layer;
  zonesCreated: number;
  zonesUpdated: number;
  zones: Zone[];
};

export type BusinessLinks = {
  lands: BusinessEntityLink[];
  buildings: BusinessEntityLink[];
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
  comparisonTarget: "layer" | "business";
  layerId: string;
  operator: string;
  distanceMeters: string;
};

// ---------------------------------------------------------------- 認証・管理

export type Membership = {
  projectId: string;
  role: "editor" | "viewer";
};

export type Me = {
  userId: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  systemRole: "admin" | "user";
  memberships: Membership[];
};

export type UserAccount = {
  id: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  systemRole: "admin" | "user";
  isActive: boolean;
  createdAt: string;
};

export type ProjectMember = {
  userId: string;
  projectId: string;
  role: "editor" | "viewer";
  email: string | null;
  displayName: string | null;
};
