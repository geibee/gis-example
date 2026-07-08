import type { Building, BusinessLinks, FeatureSearchResult, Land, Layer, Party, Zone } from "./contracts";

// 業務オブジェクト一覧の横断フィルタ (UI 状態)。API へは各エンドポイントが
// 契約 (openapi.yaml) で宣言するクエリパラメータの部分集合として送信される。
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

// 条件検索フォームの編集中状態 (送信時に ConditionQueryCondition へ変換される)
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

export type LayerViewState = {
  baseMapVisible: boolean;
  visibleLayerIds: string[];
  layerOrder: string[];
};

export type LayerListItem =
  | { type: "layer"; layer: Layer }
  | { type: "resultSet"; id: string; name: string; layers: Layer[] };

export type BusinessTab = "zone" | "lands" | "buildings" | "parties" | "admin";
export type ZoneBusinessSourceType = "all" | "land" | "building";

// 地図チャンク (components/MapPane.tsx) が公開する命令的 API。
// App (メインチャンク) は maplibre を import せず、この API 経由で地図を操作する。
export type MapPaneApi = {
  resize: () => void;
  focusGeometry: (geometry: unknown) => void;
  focusFeatureResults: (results: FeatureSearchResult[]) => void;
  getBoundsBbox: () => string | null;
  reloadLayerSource: (layerId: string) => void;
};

export type ZoneLayerCreateMetadata = {
  name?: string | null;
  zoneType?: string | null;
  status?: string | null;
};

export type LandDraft = {
  id: string;
  lotNumber: string;
  address: string;
  landUse: string;
  areaSqm: string;
  registeredOwner: string;
  rightType: string;
  registrationCause: string;
  registrationAcceptedOn: string;
  status: string;
  memo: string;
  sourceLayerId: string;
  sourceFeatureId: string;
};

export type ZoneDraft = {
  id: string;
  name: string;
  zoneType: string;
  status: string;
  memo: string;
  zoneLayerId: string;
  zoneFeatureId: string;
};

export type BusinessMapTarget = {
  layerId: string;
  layerName: string;
  featureId: string;
  matchSummary: string;
  businessLinks: BusinessLinks;
  matchedBusinessLinks: BusinessLinks;
};

export type BusinessMapTargetContext = {
  tab: BusinessTab;
  zones: Zone[];
  lands: Land[];
  buildings: Building[];
  parties: Party[];
  layerById: Map<string, Layer>;
};

export type BusinessListSearchCriteria = {
  query: string;
  filters: BusinessObjectFilters;
};

export type BuildingDraft = {
  id: string;
  landId: string;
  name: string;
  buildingLocation: string;
  houseNumber: string;
  buildingUse: string;
  floors: string;
  totalFloorAreaSqm: string;
  structure: string;
  registeredOwner: string;
  rightType: string;
  registrationAcceptedOn: string;
  status: string;
  memo: string;
  sourceLayerId: string;
  sourceFeatureId: string;
};

export type PartyDraft = {
  id: string;
  name: string;
  partyType: string;
  contact: string;
  address: string;
  memo: string;
  tags: string;
};

export type RelationshipDraft = {
  partyId: string;
  targetType: "land" | "building";
  targetId: string;
  relationType: string;
  note: string;
};
