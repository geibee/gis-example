import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import maplibregl, { type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import {
  ArrowLeft,
  Building2,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  Layers,
  Loader2,
  Map as MapIcon,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  Upload,
  Users,
  X
} from "lucide-react";
import {
  createAnalysisJob,
  createBuilding,
  createImportJob,
  createLand,
  createParty,
  createPartyRelationship,
  createZone,
  createZoneLayerFromFacilities,
  createZoneLayerFromImport,
  conditionSearchFeatures,
  deleteBuilding,
  deleteLand,
  deleteLayer,
  deleteParty,
  deletePartyRelationship,
  deleteResultSet,
  deleteZone,
  getAnalysisJob,
  getBuilding,
  getBuildings,
  getBusinessLinks,
  getFeature,
  getImportJob,
  getLayerAttributeValues,
  getLand,
  getLands,
  getLayers,
  getParties,
  getParty,
  getProjects,
  getZone,
  getZonePartySummary,
  getZones,
  searchFeatures,
  updateBuilding,
  updateFeature,
  updateLand,
  updateParty,
  updatePartyRelationship,
  updateZone
} from "./api";
import type {
  AnalysisJob,
  AttributeConditionDraft,
  Building,
  BusinessObjectFilters,
  BusinessLinks,
  ConditionQuery,
  ConditionQueryCondition,
  Feature,
  FeatureSearchResult,
  ImportJob,
  Land,
  Layer,
  Party,
  PartyRelationship,
  Project,
  SpatialConditionDraft,
  Zone,
  ZonePartySummary as ZonePartySummaryData
} from "./types";

const baseStyle = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

const attributeOperators = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL"];
const conditionSpatialOperators = [
  { value: "intersects", label: "重なる" },
  { value: "contains", label: "区域が含む" },
  { value: "within", label: "区域が含まれる" },
  { value: "dwithin", label: "指定距離内" }
];
const layerColors = ["#0f766e", "#b45309", "#2563eb", "#be123c", "#7c3aed", "#15803d", "#c2410c"];
const imperialPalaceCenter: [number, number] = [139.7528, 35.6852];
const defaultMapZoom = 12.5;
const layerViewStateStoragePrefix = "gis-example.layer-view-state.";
const businessMapHighlightLimit = 80;
const businessStatusOptions = ["調査中", "現況確認中", "交渉中", "契約準備", "契約済", "稼働中", "保留", "除外"];
const zoneTypeOptions = ["重点調査", "商業調査", "再開発候補", "保全", "除外候補"];
const zoneStatusOptions = ["有効", "確認中", "見直し", "停止", "完了"];
const landUseOptions = ["商業地", "業務地", "住宅地", "工業地", "公共用地", "雑種地"];
const buildingUseOptions = ["事務所", "店舗", "住宅", "共同住宅", "倉庫", "工場", "ホテル", "駐車場", "複合用途"];
const partyTypeOptions = ["法人", "個人", "管理会社", "行政", "金融機関", "士業", "仲介会社"];
const rightTypeOptions = ["所有権", "借地権", "地上権", "賃借権", "区分所有権", "抵当権"];
const registrationCauseOptions = ["売買", "合併", "設定", "相続", "贈与", "新築", "保存", "移転", "変更"];
const buildingStructureOptions = ["S造", "RC造", "SRC造", "木造", "軽量鉄骨造", "CB造"];
const relationTypeOptions = ["所有者", "売買事業者", "管理者", "借地権者", "賃借人", "仲介", "登記名義人", "連絡先"];

type LayerViewState = {
  baseMapVisible: boolean;
  visibleLayerIds: string[];
  layerOrder: string[];
};

type LayerListItem =
  | { type: "layer"; layer: Layer }
  | { type: "resultSet"; id: string; name: string; layers: Layer[] };

type BusinessTab = "zone" | "lands" | "buildings" | "parties";
type ZoneBusinessSourceType = "all" | "land" | "building";

type RouteSelection = {
  tab: BusinessTab;
  id: string | null;
};

type LandDraft = {
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

type ZoneDraft = {
  id: string;
  name: string;
  zoneType: string;
  status: string;
  memo: string;
  zoneLayerId: string;
  zoneFeatureId: string;
};

type BusinessMapTarget = {
  layerId: string;
  layerName: string;
  featureId: string;
  matchSummary: string;
  businessLinks: BusinessLinks;
  matchedBusinessLinks: BusinessLinks;
};

type BusinessMapTargetContext = {
  tab: BusinessTab;
  zones: Zone[];
  lands: Land[];
  buildings: Building[];
  parties: Party[];
  layerById: Map<string, Layer>;
};

type BusinessListSearchCriteria = {
  query: string;
  filters: BusinessObjectFilters;
};

type BuildingDraft = {
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

type PartyDraft = {
  id: string;
  name: string;
  partyType: string;
  contact: string;
  address: string;
  memo: string;
  tags: string;
};

type RelationshipDraft = {
  partyId: string;
  targetType: "land" | "building";
  targetId: string;
  relationType: string;
  note: string;
};

const emptyBusinessLinks: BusinessLinks = { lands: [], buildings: [] };

function emptyBusinessListSearchCriteria(): BusinessListSearchCriteria {
  return { query: "", filters: {} };
}

function toBusinessListSearchCriteria(query: string, filters: BusinessObjectFilters): BusinessListSearchCriteria {
  return { query: query.trim(), filters: { ...filters } };
}

function normalizeZoneLayerFilter(filters: BusinessObjectFilters, zoneLayers: Layer[]): BusinessObjectFilters {
  const selectedLayerId = filters.zoneLayerId?.trim();
  if (selectedLayerId && zoneLayers.some((layer) => layer.id === selectedLayerId)) {
    return filters;
  }
  if (zoneLayers[0]) {
    if (filters.zoneLayerId === zoneLayers[0].id) return filters;
    return { ...filters, zoneLayerId: zoneLayers[0].id };
  }
  if (!selectedLayerId) return filters;
  const nextFilters = { ...filters };
  delete nextFilters.zoneLayerId;
  return nextFilters;
}

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLayersByLayerId = useRef<Record<string, string[]>>({});
  const appLayerByStyleLayer = useRef<Record<string, string>>({});
  const initializedLayerBounds = useRef(false);
  const seenLayerIds = useRef<Set<string>>(new Set());
  const loadedLayerProjectId = useRef<string | null>(null);
  const layersRef = useRef<Layer[]>([]);

  const [activeTab, setActiveTab] = useState<BusinessTab>(() => parseRoute(window.location.pathname).tab);
  const [routeSelection, setRouteSelection] = useState<RouteSelection>(() => parseRoute(window.location.pathname));
  const [mapReady, setMapReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [layers, setLayers] = useState<Layer[]>([]);
  const [baseMapVisible, setBaseMapVisible] = useState(true);
  const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(new Set());
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [deletingLayerIds, setDeletingLayerIds] = useState<Set<string>>(new Set());
  const [deletingResultSetIds, setDeletingResultSetIds] = useState<Set<string>>(new Set());
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
  const [selectedFeatureLayer, setSelectedFeatureLayer] = useState<Layer | null>(null);
  const [businessLinks, setBusinessLinks] = useState<BusinessLinks>(emptyBusinessLinks);
  const [loadingBusinessLinks, setLoadingBusinessLinks] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingLayers, setLoadingLayers] = useState(false);
  const [mapSupportOpen, setMapSupportOpen] = useState(true);

  const [zoneQuery, setZoneQuery] = useState("");
  const [zoneFilters, setZoneFilters] = useState<BusinessObjectFilters>({});
  const [zoneSearchCriteria, setZoneSearchCriteria] = useState<BusinessListSearchCriteria>(emptyBusinessListSearchCriteria);
  const [zoneFiltersOpen, setZoneFiltersOpen] = useState(true);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(() => {
    const route = parseRoute(window.location.pathname);
    return route.tab === "zone" ? route.id : null;
  });
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [zoneDraft, setZoneDraft] = useState<ZoneDraft>(emptyZoneDraft());
  const [creatingZone, setCreatingZone] = useState(false);
  const [loadingZones, setLoadingZones] = useState(false);
  const [savingZone, setSavingZone] = useState(false);
  const [deletingZone, setDeletingZone] = useState(false);

  const [zoneSearchQuery, setZoneSearchQuery] = useState("");
  const [zoneSearchLinkedOnly, setZoneSearchLinkedOnly] = useState(false);
  const [zoneSpatialLayerIds, setZoneSpatialLayerIds] = useState<string[]>([]);
  const [zoneBusinessSourceType, setZoneBusinessSourceType] = useState<ZoneBusinessSourceType>("all");
  const [zoneBusinessQuery, setZoneBusinessQuery] = useState("");
  const [zoneBusinessStatus, setZoneBusinessStatus] = useState("");
  const [zoneLandUse, setZoneLandUse] = useState("");
  const [zoneBuildingUse, setZoneBuildingUse] = useState("");
  const [zonePartyQuery, setZonePartyQuery] = useState("");
  const [zonePartyType, setZonePartyType] = useState("");
  const [zoneRelationType, setZoneRelationType] = useState("");
  const [zoneSearchResults, setZoneSearchResults] = useState<FeatureSearchResult[]>([]);
  const [listMapHighlightResults, setListMapHighlightResults] = useState<FeatureSearchResult[]>([]);
  const [manualMapHighlightResults, setManualMapHighlightResults] = useState<FeatureSearchResult[] | null>(null);
  const mapHighlightResults = manualMapHighlightResults ?? listMapHighlightResults;
  const [loadingZoneSearch, setLoadingZoneSearch] = useState(false);
  const [conditionBuilderOpen, setConditionBuilderOpen] = useState(false);
  const [savingConditionSearch, setSavingConditionSearch] = useState(false);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFormat, setUploadFormat] = useState("geojson");
  const [uploadSrid, setUploadSrid] = useState("4326");
  const [uploadAsZoneLayer, setUploadAsZoneLayer] = useState(false);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);

  const [analysisName, setAnalysisName] = useState("");
  const [targetLayerId, setTargetLayerId] = useState("");
  const [attributeConditions, setAttributeConditions] = useState<AttributeConditionDraft[]>([]);
  const [spatialConditions, setSpatialConditions] = useState<SpatialConditionDraft[]>([]);
  const [analysisJobs, setAnalysisJobs] = useState<AnalysisJob[]>([]);

  const [outerBoundaryName, setOuterBoundaryName] = useState("");
  const [outerTargetLayerId, setOuterTargetLayerId] = useState("");
  const [outerBoundaryLayerId, setOuterBoundaryLayerId] = useState("");
  const [outerBoundaryBufferMeters, setOuterBoundaryBufferMeters] = useState("1000");
  const [facilityZoneName, setFacilityZoneName] = useState("");
  const [facilityZoneLayerId, setFacilityZoneLayerId] = useState("");
  const [facilityZoneBufferMeters, setFacilityZoneBufferMeters] = useState("1000");
  const [facilityZoneDistanceMeters, setFacilityZoneDistanceMeters] = useState("");
  const [facilityZoneSourceType, setFacilityZoneSourceType] = useState<ZoneBusinessSourceType>("all");
  const [creatingFacilityZone, setCreatingFacilityZone] = useState(false);

  const [featureEditOpen, setFeatureEditOpen] = useState(false);
  const [featurePropertyDraft, setFeaturePropertyDraft] = useState<Record<string, string>>({});
  const [featureGeometryDraft, setFeatureGeometryDraft] = useState("");
  const [savingFeature, setSavingFeature] = useState(false);

  const [landQuery, setLandQuery] = useState("");
  const [landFilters, setLandFilters] = useState<BusinessObjectFilters>({});
  const [landSearchCriteria, setLandSearchCriteria] = useState<BusinessListSearchCriteria>(emptyBusinessListSearchCriteria);
  const [landFiltersOpen, setLandFiltersOpen] = useState(true);
  const [lands, setLands] = useState<Land[]>([]);
  const [selectedLandId, setSelectedLandId] = useState<string | null>(() => {
    const route = parseRoute(window.location.pathname);
    return route.tab === "lands" ? route.id : null;
  });
  const [selectedLand, setSelectedLand] = useState<Land | null>(null);
  const [landDraft, setLandDraft] = useState<LandDraft>(emptyLandDraft());
  const [creatingLand, setCreatingLand] = useState(false);
  const [loadingLands, setLoadingLands] = useState(false);
  const [savingLand, setSavingLand] = useState(false);
  const [deletingLand, setDeletingLand] = useState(false);

  const [buildingQuery, setBuildingQuery] = useState("");
  const [buildingFilters, setBuildingFilters] = useState<BusinessObjectFilters>({});
  const [buildingSearchCriteria, setBuildingSearchCriteria] = useState<BusinessListSearchCriteria>(emptyBusinessListSearchCriteria);
  const [buildingFiltersOpen, setBuildingFiltersOpen] = useState(true);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(() => {
    const route = parseRoute(window.location.pathname);
    return route.tab === "buildings" ? route.id : null;
  });
  const [selectedBuilding, setSelectedBuilding] = useState<Building | null>(null);
  const [buildingDraft, setBuildingDraft] = useState<BuildingDraft>(emptyBuildingDraft());
  const [creatingBuilding, setCreatingBuilding] = useState(false);
  const [loadingBuildings, setLoadingBuildings] = useState(false);
  const [savingBuilding, setSavingBuilding] = useState(false);
  const [deletingBuilding, setDeletingBuilding] = useState(false);

  const [partyQuery, setPartyQuery] = useState("");
  const [partyFilters, setPartyFilters] = useState<BusinessObjectFilters>({});
  const [partySearchCriteria, setPartySearchCriteria] = useState<BusinessListSearchCriteria>(emptyBusinessListSearchCriteria);
  const [partyFiltersOpen, setPartyFiltersOpen] = useState(true);
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(() => {
    const route = parseRoute(window.location.pathname);
    return route.tab === "parties" ? route.id : null;
  });
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [partyDraft, setPartyDraft] = useState<PartyDraft>(emptyPartyDraft());
  const [creatingParty, setCreatingParty] = useState(false);
  const [loadingParties, setLoadingParties] = useState(false);
  const [savingParty, setSavingParty] = useState(false);
  const [deletingParty, setDeletingParty] = useState(false);

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
  const layerListItems = useMemo(() => groupLayerListItems(layers), [layers]);
  const zoneLayers = useMemo(() => layers.filter(isZoneLayer), [layers]);
  const polygonLayers = useMemo(() => layers.filter(isPolygonLayer), [layers]);
  const pointLayers = useMemo(() => layers.filter(isPointLayer), [layers]);
  const boundaryCandidateLayers = useMemo(() => layers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer)), [layers]);

  useEffect(() => {
    setZoneFilters((current) => normalizeZoneLayerFilter(current, zoneLayers));
    setZoneSearchCriteria((current) => {
      const nextFilters = normalizeZoneLayerFilter(current.filters, zoneLayers);
      return nextFilters === current.filters ? current : { ...current, filters: nextFilters };
    });
  }, [zoneLayers]);

  useEffect(() => {
    setZoneSpatialLayerIds((current) => {
      const validLayerIds = current.filter((id) => layerById.has(id));
      if (validLayerIds.length) {
        return validLayerIds.length === current.length ? current : validLayerIds;
      }
      return defaultZoneSpatialLayerIds(layers);
    });
  }, [layerById, layers]);

  const navigateTab = useCallback((tab: BusinessTab) => {
    const path = tabPath(tab);
    window.history.pushState(null, "", path);
    const nextRoute = parseRoute(path);
    setActiveTab(nextRoute.tab);
    setRouteSelection(nextRoute);
    if (tab === "zone") {
      setCreatingZone(false);
      setSelectedZoneId(null);
      setSelectedZone(null);
    }
    if (tab === "lands") {
      setCreatingLand(false);
      setSelectedLandId(null);
      setSelectedLand(null);
    }
    if (tab === "buildings") {
      setCreatingBuilding(false);
      setSelectedBuildingId(null);
      setSelectedBuilding(null);
    }
    if (tab === "parties") {
      setCreatingParty(false);
      setSelectedPartyId(null);
      setSelectedParty(null);
    }
  }, []);

  const selectZone = useCallback((id: string) => {
    const path = `/zones/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("zone");
    setCreatingZone(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setRouteSelection({ tab: "zone", id });
    setSelectedZone(null);
    setSelectedZoneId(id);
  }, []);

  const selectLand = useCallback((id: string) => {
    const path = `/lands/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("lands");
    setCreatingLand(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setRouteSelection({ tab: "lands", id });
    setSelectedLand(null);
    setSelectedLandId(id);
  }, []);

  const selectBuilding = useCallback((id: string) => {
    const path = `/buildings/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("buildings");
    setCreatingBuilding(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setRouteSelection({ tab: "buildings", id });
    setSelectedBuilding(null);
    setSelectedBuildingId(id);
  }, []);

  const selectParty = useCallback((id: string) => {
    const path = `/parties/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("parties");
    setCreatingParty(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setRouteSelection({ tab: "parties", id });
    setSelectedParty(null);
    setSelectedPartyId(id);
  }, []);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = parseRoute(window.location.pathname);
      setActiveTab(nextRoute.tab);
      setRouteSelection(nextRoute);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (routeSelection.tab === "zone") {
      if (routeSelection.id) {
        setCreatingZone(false);
        setSelectedZoneId(routeSelection.id);
      } else if (!creatingZone) {
        setSelectedZoneId(null);
        setSelectedZone(null);
      }
    }
    if (routeSelection.tab === "lands") {
      if (routeSelection.id) {
        setCreatingLand(false);
        setSelectedLandId(routeSelection.id);
      } else if (!creatingLand) {
        setSelectedLandId(null);
        setSelectedLand(null);
      }
    }
    if (routeSelection.tab === "buildings") {
      if (routeSelection.id) {
        setCreatingBuilding(false);
        setSelectedBuildingId(routeSelection.id);
      } else if (!creatingBuilding) {
        setSelectedBuildingId(null);
        setSelectedBuilding(null);
      }
    }
    if (routeSelection.tab === "parties") {
      if (routeSelection.id) {
        setCreatingParty(false);
        setSelectedPartyId(routeSelection.id);
      } else if (!creatingParty) {
        setSelectedPartyId(null);
        setSelectedParty(null);
      }
    }
  }, [creatingBuilding, creatingLand, creatingParty, creatingZone, routeSelection]);

  useEffect(() => {
    window.setTimeout(() => mapRef.current?.resize(), 0);
  }, [activeTab, mapSupportOpen]);

  const refreshLayers = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingLayers(true);
    try {
      const nextLayers = await getLayers(selectedProject);
      const savedViewState = readLayerViewState(selectedProject);
      const previousLayers = loadedLayerProjectId.current === selectedProject ? layersRef.current : [];
      const previousLayerIds = new Set(previousLayers.map((layer) => layer.id));
      const orderedLayers = orderLayers(nextLayers, savedViewState?.layerOrder ?? previousLayers.map((layer) => layer.id));
      const nextPolygonLayers = nextLayers.filter(isPolygonLayer);
      const nextPointLayers = nextLayers.filter(isPointLayer);
      const nextBoundaryCandidateLayers = nextLayers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer));
      loadedLayerProjectId.current = selectedProject;
      if (typeof savedViewState?.baseMapVisible === "boolean") {
        setBaseMapVisible(savedViewState.baseMapVisible);
      }
      setLayers(orderedLayers);
      setVisibleLayerIds((current) => {
        return restoreVisibleLayerIds(orderedLayers, savedViewState, previousLayerIds, current);
      });
      if (!nextLayers.some((layer) => layer.id === targetLayerId)) {
        setTargetLayerId(nextLayers[0]?.id ?? "");
      }
      if (!nextPolygonLayers.some((layer) => layer.id === outerTargetLayerId)) {
        setOuterTargetLayerId(nextPolygonLayers[0]?.id ?? "");
      }
      if (!nextBoundaryCandidateLayers.some((layer) => layer.id === outerBoundaryLayerId)) {
        setOuterBoundaryLayerId(nextBoundaryCandidateLayers[0]?.id ?? "");
      }
      if (!nextPointLayers.some((layer) => layer.id === facilityZoneLayerId)) {
        setFacilityZoneLayerId(nextPointLayers[0]?.id ?? "");
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLayers(false);
    }
  }, [facilityZoneLayerId, outerBoundaryLayerId, outerTargetLayerId, selectedProject, targetLayerId]);

  const refreshZones = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingZones(true);
    try {
      const items = await getZones(selectedProject, zoneSearchCriteria.query, zoneSearchCriteria.filters);
      setZones(items);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingZones(false);
    }
  }, [selectedProject, zoneSearchCriteria]);

  const refreshLands = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingLands(true);
    try {
      const items = await getLands(selectedProject, landSearchCriteria.query, landSearchCriteria.filters);
      setLands(items);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLands(false);
    }
  }, [landSearchCriteria, selectedProject]);

  const refreshBuildings = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingBuildings(true);
    try {
      const items = await getBuildings(selectedProject, buildingSearchCriteria.query, undefined, buildingSearchCriteria.filters);
      setBuildings(items);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingBuildings(false);
    }
  }, [buildingSearchCriteria, selectedProject]);

  const refreshParties = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingParties(true);
    try {
      const items = await getParties(selectedProject, partySearchCriteria.query, partySearchCriteria.filters);
      setParties(items);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingParties(false);
    }
  }, [partySearchCriteria, selectedProject]);

  const submitZoneListSearch = useCallback(() => {
    setZoneSearchCriteria(toBusinessListSearchCriteria(zoneQuery, zoneFilters));
  }, [zoneFilters, zoneQuery]);

  const submitLandListSearch = useCallback(() => {
    setLandSearchCriteria(toBusinessListSearchCriteria(landQuery, landFilters));
  }, [landFilters, landQuery]);

  const submitBuildingListSearch = useCallback(() => {
    setBuildingSearchCriteria(toBusinessListSearchCriteria(buildingQuery, buildingFilters));
  }, [buildingFilters, buildingQuery]);

  const submitPartyListSearch = useCallback(() => {
    setPartySearchCriteria(toBusinessListSearchCriteria(partyQuery, partyFilters));
  }, [partyFilters, partyQuery]);

  useEffect(() => {
    if (!selectedProject || loadedLayerProjectId.current !== selectedProject) return;
    writeLayerViewState(selectedProject, {
      baseMapVisible,
      visibleLayerIds: layers.filter((layer) => visibleLayerIds.has(layer.id)).map((layer) => layer.id),
      layerOrder: layers.map((layer) => layer.id)
    });
  }, [baseMapVisible, layers, selectedProject, visibleLayerIds]);

  useEffect(() => {
    getProjects()
      .then((items) => {
        setProjects(items);
        if (items[0]) setSelectedProject(items[0].id);
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    void refreshLayers();
  }, [refreshLayers]);

  useEffect(() => {
    void refreshZones();
  }, [refreshZones]);

  useEffect(() => {
    void refreshLands();
  }, [refreshLands]);

  useEffect(() => {
    void refreshBuildings();
  }, [refreshBuildings]);

  useEffect(() => {
    void refreshParties();
  }, [refreshParties]);

  useEffect(() => {
    if (!selectedZoneId) {
      setSelectedZone(null);
      if (!creatingZone) setZoneDraft(emptyZoneDraft());
      return;
    }
    getZone(selectedZoneId)
      .then((item) => {
        setSelectedZone(item);
        setZoneDraft(toZoneDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [creatingZone, selectedZoneId]);

  useEffect(() => {
    if (!selectedLandId) {
      setSelectedLand(null);
      if (!creatingLand) setLandDraft(emptyLandDraft());
      return;
    }
    getLand(selectedLandId)
      .then((item) => {
        setSelectedLand(item);
        setLandDraft(toLandDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [creatingLand, selectedLandId]);

  useEffect(() => {
    if (!selectedBuildingId) {
      setSelectedBuilding(null);
      if (!creatingBuilding) setBuildingDraft(emptyBuildingDraft());
      return;
    }
    getBuilding(selectedBuildingId)
      .then((item) => {
        setSelectedBuilding(item);
        setBuildingDraft(toBuildingDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [creatingBuilding, selectedBuildingId]);

  useEffect(() => {
    if (!selectedPartyId) {
      setSelectedParty(null);
      if (!creatingParty) setPartyDraft(emptyPartyDraft());
      return;
    }
    getParty(selectedPartyId)
      .then((item) => {
        setSelectedParty(item);
        setPartyDraft(toPartyDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [creatingParty, selectedPartyId]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as maplibregl.StyleSpecification,
      center: imperialPalaceCenter,
      zoom: defaultMapZoom,
      attributionControl: { compact: true }
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.on("load", () => setMapReady(true));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    if (map.getLayer("osm")) {
      map.setLayoutProperty("osm", "visibility", baseMapVisible ? "visible" : "none");
    }
  }, [baseMapVisible, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const activeLayerIds = new Set(layers.map((layer) => layer.id));
    for (const [layerId, styleLayerIds] of Object.entries(styleLayersByLayerId.current)) {
      if (activeLayerIds.has(layerId)) continue;
      for (const styleLayerId of styleLayerIds) {
        if (map.getLayer(styleLayerId)) {
          map.removeLayer(styleLayerId);
        }
        delete appLayerByStyleLayer.current[styleLayerId];
      }
      if (map.getSource(layerId)) {
        map.removeSource(layerId);
      }
      delete styleLayersByLayerId.current[layerId];
      seenLayerIds.current.delete(layerId);
    }

    layers.forEach((layer, index) => {
      if (!map.getSource(layer.id)) {
        map.addSource(layer.id, {
          type: "vector",
          url: `/api/tilejson/${layer.id}`
        });
      }
      if (!styleLayersByLayerId.current[layer.id]) {
        const styleLayerIds = addMapLayers(map, layer, layerColors[index % layerColors.length]);
        styleLayersByLayerId.current[layer.id] = styleLayerIds;
        for (const styleLayerId of styleLayerIds) {
          appLayerByStyleLayer.current[styleLayerId] = layer.id;
        }
      }
      const visibility = visibleLayerIds.has(layer.id) ? "visible" : "none";
      for (const styleLayerId of styleLayersByLayerId.current[layer.id] ?? []) {
        if (map.getLayer(styleLayerId)) {
          map.setLayoutProperty(styleLayerId, "visibility", visibility);
        }
      }
    });
    syncMapLayerOrder(map, layers, styleLayersByLayerId.current);
    syncConditionSearchHighlight(map, mapHighlightResults);
  }, [layers, mapHighlightResults, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    syncConditionSearchHighlight(map, mapHighlightResults);
  }, [mapHighlightResults, mapReady]);

  useEffect(() => {
    setManualMapHighlightResults(null);
  }, [
    activeTab,
    selectedProject,
    zoneSearchCriteria,
    selectedZoneId,
    landSearchCriteria,
    selectedLandId,
    buildingSearchCriteria,
    selectedBuildingId,
    partySearchCriteria,
    selectedPartyId
  ]);

  useEffect(() => {
    if (!selectedProject) {
      setListMapHighlightResults([]);
      setManualMapHighlightResults(null);
      return;
    }
    let active = true;
    const syncBusinessListResults = async () => {
      const highlightZones =
        activeTab === "zone" ? (selectedZone && selectedZone.id === selectedZoneId ? [selectedZone] : selectedZoneId ? [] : zones) : zones;
      const highlightLands =
        activeTab === "lands" ? (selectedLand && selectedLand.id === selectedLandId ? [selectedLand] : selectedLandId ? [] : lands) : lands;
      const highlightBuildings =
        activeTab === "buildings"
          ? selectedBuilding && selectedBuilding.id === selectedBuildingId
            ? [selectedBuilding]
            : selectedBuildingId
              ? []
              : buildings
          : buildings;
      const highlightParties =
        activeTab === "parties" ? (selectedParty && selectedParty.id === selectedPartyId ? [selectedParty] : selectedPartyId ? [] : parties) : parties;
      const targets = uniqueBusinessMapTargets(
        await buildBusinessMapTargets({
          tab: activeTab,
          zones: highlightZones,
          lands: highlightLands,
          buildings: highlightBuildings,
          parties: highlightParties,
          layerById
        })
      ).slice(0, businessMapHighlightLimit);
      if (!active) return;
      if (!targets.length) {
        setListMapHighlightResults([]);
        return;
      }
      const settled = await Promise.allSettled(
        targets.map(async (target) => {
          const feature = await getFeature(target.layerId, target.featureId);
          return {
            layerId: feature.layerId,
            layerName: target.layerName,
            featureId: feature.featureId,
            properties: feature.properties,
            geometry: feature.geometry,
            matchSummary: target.matchSummary,
            businessLinks: target.businessLinks,
            matchedBusinessLinks: target.matchedBusinessLinks
          } satisfies FeatureSearchResult;
        })
      );
      if (!active) return;
      const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      setListMapHighlightResults(results);
      if (!results.length) return;
      setVisibleLayerIds((current) => new Set([...current, ...results.map((result) => result.layerId)]));
      if (mapReady) {
        window.setTimeout(() => {
          mapRef.current?.resize();
          focusFeatureResults(mapRef.current, results);
        }, 80);
      }
    };
    void syncBusinessListResults();
    return () => {
      active = false;
    };
  }, [
    activeTab,
    buildings,
    lands,
    layerById,
    mapReady,
    parties,
    selectedBuilding,
    selectedBuildingId,
    selectedLand,
    selectedLandId,
    selectedParty,
    selectedPartyId,
    selectedProject,
    selectedZone,
    selectedZoneId,
    zones
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const visibleLayersWithBounds = layers.filter((layer) => visibleLayerIds.has(layer.id) && layer.bbox4326);
    if (!visibleLayersWithBounds.length) return;

    if (!initializedLayerBounds.current) {
      for (const layer of layers) {
        seenLayerIds.current.add(layer.id);
      }
      initializedLayerBounds.current = true;
      return;
    }

    const layerToFit = visibleLayersWithBounds.find((layer) => !seenLayerIds.current.has(layer.id));

    if (layerToFit?.bbox4326) {
      map.fitBounds(
        [
          [layerToFit.bbox4326[0], layerToFit.bbox4326[1]],
          [layerToFit.bbox4326[2], layerToFit.bbox4326[3]]
        ],
        { padding: 48, duration: 600, maxZoom: 16 }
      );
    }

    for (const layer of layers) {
      seenLayerIds.current.add(layer.id);
    }
  }, [layers, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const handleClick = async (event: MapLayerMouseEvent) => {
      const queryLayerIds = Object.values(styleLayersByLayerId.current)
        .flat()
        .filter((id) => map.getLayer(id));
      if (!queryLayerIds.length) return;

      const features = map.queryRenderedFeatures(event.point, { layers: queryLayerIds });
      const rendered = features[0];
      if (!rendered) return;

      const layerId = appLayerByStyleLayer.current[rendered.layer.id];
      const layer = layerById.get(layerId);
      const featureId = rendered.properties?.[layer?.featureIdColumn ?? "fid"] ?? rendered.id;
      if (!layer || featureId === undefined || featureId === null || featureId === "") {
        setNotice("選択地物のIDを取得できませんでした");
        return;
      }
      try {
        const feature = await getFeature(layer.id, String(featureId));
        setSelectedFeature(feature);
        setSelectedFeatureLayer(layer);
      } catch (error) {
        setNotice(errorMessage(error));
      }
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [layerById, mapReady]);

  useEffect(() => {
    if (!selectedFeature || !selectedFeatureLayer) {
      setFeatureEditOpen(false);
      setFeaturePropertyDraft({});
      setFeatureGeometryDraft("");
      return;
    }

    const nextDraft: Record<string, string> = {};
    for (const attribute of editableFeatureAttributes(selectedFeatureLayer)) {
      nextDraft[attribute.name] = formatEditorValue(selectedFeature.properties[attribute.name]);
    }
    setFeatureEditOpen(false);
    setFeaturePropertyDraft(nextDraft);
    setFeatureGeometryDraft(selectedFeature.geometry ? JSON.stringify(selectedFeature.geometry, null, 2) : "");
  }, [selectedFeature, selectedFeatureLayer]);

  useEffect(() => {
    if (!selectedFeature || !selectedFeatureLayer) {
      setBusinessLinks(emptyBusinessLinks);
      setLoadingBusinessLinks(false);
      return;
    }
    setLoadingBusinessLinks(true);
    getBusinessLinks(selectedFeatureLayer.id, selectedFeature.featureId)
      .then(setBusinessLinks)
      .catch((error) => setNotice(errorMessage(error)))
      .finally(() => setLoadingBusinessLinks(false));
  }, [selectedFeature, selectedFeatureLayer]);

  const reloadLayerSource = (layerId: string) => {
    const source = mapRef.current?.getSource(layerId) as { reload?: () => void } | undefined;
    source?.reload?.();
  };

  const submitUpload = async () => {
    if (!selectedProject || !uploadFile) return;
    const formData = new FormData();
    formData.set("projectId", selectedProject);
    formData.set("format", uploadFormat);
    if (uploadSrid.trim()) formData.set("sourceSrid", uploadSrid.trim());
    if (uploadAsZoneLayer) formData.set("layerRole", "zone");
    formData.set("file", uploadFile);
    try {
      const job = await createImportJob(formData);
      setImportJobs((current) => upsertJob(current, job));
      pollImportJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const pollImportJob = (id: string) => {
    const timer = window.setInterval(async () => {
      try {
        const job = await getImportJob(id);
        setImportJobs((current) => upsertJob(current, job));
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          void refreshLayers();
          void refreshZones();
        }
      } catch (error) {
        window.clearInterval(timer);
        setNotice(errorMessage(error));
      }
    }, 1500);
  };

  const submitAnalysis = async () => {
    if (!selectedProject || !targetLayerId) return;
    const body = {
      projectId: selectedProject,
      name: analysisName.trim() || undefined,
      targetLayerId,
      attributeConditions: attributeConditions
        .filter((condition) => condition.layerId && condition.field)
        .map((condition) => toAttributePayload(condition)),
      spatialConditions: spatialConditions
        .filter((condition) => condition.layerId)
        .map((condition) => ({
          layerId: condition.layerId,
          operator: condition.operator,
          distanceMeters:
            condition.operator === "dwithin" ? Number(condition.distanceMeters || "0") : undefined
        }))
    };
    try {
      const job = await createAnalysisJob(body);
      setAnalysisJobs((current) => upsertJob(current, job));
      pollAnalysisJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const submitOuterBoundary = async () => {
    if (!selectedProject || !outerTargetLayerId || !outerBoundaryLayerId) return;
    const bufferMeters = Number(outerBoundaryBufferMeters || "1000");
    if (!Number.isFinite(bufferMeters) || bufferMeters <= 0) {
      setNotice("バッファ距離は正の数値で入力してください");
      return;
    }
    const body = {
      projectId: selectedProject,
      name: outerBoundaryName.trim() || undefined,
      targetLayerId: outerTargetLayerId,
      operation: "outer_boundary",
      boundaryLayerId: outerBoundaryLayerId,
      bufferMeters
    };
    try {
      const job = await createAnalysisJob(body);
      setAnalysisJobs((current) => upsertJob(current, job));
      pollAnalysisJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const convertLayerToZoneLayer = async (layer: Layer) => {
    if (!selectedProject) return;
    try {
      const result = await createZoneLayerFromImport({
        projectId: selectedProject,
        layerId: layer.id
      });
      await refreshLayers();
      await refreshZones();
      setZoneFilters((current) => ({ ...current, zoneLayerId: result.layer.id }));
      setVisibleLayerIds((current) => new Set([...current, result.layer.id]));
      setNotice(`区域レイヤ化しました（${result.zonesCreated.toLocaleString()}件作成）`);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const submitFacilityZoneLayer = async () => {
    if (!selectedProject || !facilityZoneLayerId) return;
    const bufferMeters = Number(facilityZoneBufferMeters || "1000");
    if (!Number.isFinite(bufferMeters) || bufferMeters <= 0) {
      setNotice("外縁距離は正の数値で入力してください");
      return;
    }
    const distanceMeters = facilityZoneDistanceMeters.trim() ? Number(facilityZoneDistanceMeters) : null;
    if (distanceMeters !== null && (!Number.isFinite(distanceMeters) || distanceMeters < 0)) {
      setNotice("施設抽出距離は0以上の数値で入力してください");
      return;
    }
    const sourceTypes: Array<"land" | "building"> =
      facilityZoneSourceType === "all" ? ["land", "building"] : [facilityZoneSourceType];
    try {
      setCreatingFacilityZone(true);
      const result = await createZoneLayerFromFacilities({
        projectId: selectedProject,
        facilityLayerId: facilityZoneLayerId,
        name: nullableString(facilityZoneName),
        bufferMeters,
        facilityDistanceMeters: distanceMeters,
        sourceTypes
      });
      await refreshLayers();
      await refreshZones();
      setZoneFilters((current) => ({ ...current, zoneLayerId: result.layer.id }));
      setVisibleLayerIds((current) => new Set([...current, result.layer.id]));
      setNotice(`施設起点区域を生成しました（${result.zonesCreated.toLocaleString()}件作成）`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCreatingFacilityZone(false);
    }
  };

  const submitZoneSearch = async () => {
    if (!selectedProject) return;
    setLoadingZoneSearch(true);
    try {
      const results = await conditionSearchFeatures(buildConditionQuery());
      setZoneSearchResults(results);
      setManualMapHighlightResults(results);
      if (!results.length) setNotice("検索結果はありません");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingZoneSearch(false);
    }
  };

  const saveConditionSearchResult = async () => {
    if (!selectedProject || !zoneSearchResults.length) return;
    setSavingConditionSearch(true);
    try {
      const query = buildConditionQuery();
      const job = await createAnalysisJob({
        projectId: selectedProject,
        name: conditionResultName(analysisName, query),
        operation: "condition_search",
        conditionQuery: query
      });
      setAnalysisJobs((current) => upsertJob(current, job));
      pollAnalysisJob(job.id);
      setNotice("条件検索結果の保存を開始しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingConditionSearch(false);
    }
  };

  const clearZoneSearchConditions = () => {
    setZoneSearchQuery("");
    setZoneSpatialLayerIds(defaultZoneSpatialLayerIds(layers));
    setAttributeConditions([]);
    setSpatialConditions([]);
    setZoneSearchLinkedOnly(false);
    setZoneBusinessSourceType("all");
    setZoneBusinessQuery("");
    setZoneBusinessStatus("");
    setZoneLandUse("");
    setZoneBuildingUse("");
    setZonePartyQuery("");
    setZonePartyType("");
    setZoneRelationType("");
    setZoneSearchResults([]);
    setManualMapHighlightResults(null);
    setAnalysisName("");
  };

  const buildConditionQuery = (): ConditionQuery => {
    const targetLayerIds = zoneSpatialLayerIds.filter((id) => layerById.has(id));
    if (!targetLayerIds.length) {
      throw new Error("対象レイヤを選択してください");
    }
    const conditions: ConditionQueryCondition[] = [];
    attributeConditions
      .filter((condition) => condition.layerId && condition.field)
      .forEach((condition) => {
        conditions.push(toConditionAttributePayload(condition));
      });
    spatialConditions
      .filter((condition) => condition.comparisonTarget === "business" || condition.layerId)
      .forEach((condition) => {
        conditions.push({
          type: "spatial",
          comparisonTarget: condition.comparisonTarget,
          layerId: condition.comparisonTarget === "layer" ? condition.layerId : undefined,
          spatialOperator: condition.operator,
          distanceMeters: condition.operator === "dwithin" ? readZoneDistance(condition.operator, condition.distanceMeters) : undefined
        });
      });
    const activeLandUse = zoneBusinessSourceType === "land" ? zoneLandUse.trim() : "";
    const activeBuildingUse = zoneBusinessSourceType === "building" ? zoneBuildingUse.trim() : "";
    if (
      zoneSearchLinkedOnly ||
      zoneBusinessSourceType !== "all" ||
      zoneBusinessQuery.trim() ||
      zoneBusinessStatus.trim() ||
      activeLandUse ||
      activeBuildingUse ||
      zonePartyQuery.trim() ||
      zonePartyType.trim() ||
      zoneRelationType.trim()
    ) {
      conditions.push({
        type: "business",
        sourceTypes: zoneBusinessSourceType === "all" ? ["land", "building"] : [zoneBusinessSourceType],
        businessQuery: zoneBusinessQuery.trim() || undefined,
        status: zoneBusinessStatus.trim() || undefined,
        landUse: activeLandUse || undefined,
        buildingUse: activeBuildingUse || undefined,
        partyQuery: zonePartyQuery.trim() || undefined,
        partyType: zonePartyType.trim() || undefined,
        relationType: zoneRelationType.trim() || undefined
      });
    }
    return {
      projectId: selectedProject,
      targetLayerIds,
      keyword: zoneSearchQuery.trim() || undefined,
      conditions,
      limit: 100
    };
  };

  const openZoneSearchResult = async (result: FeatureSearchResult) => {
    const layer = layerById.get(result.layerId);
    if (!layer) {
      setNotice("検索結果のレイヤを取得できませんでした");
      return;
    }
    try {
      setVisibleLayerIds((current) => {
        const next = new Set(current);
        next.add(result.layerId);
        return next;
      });
      const feature = await getFeature(result.layerId, result.featureId);
      setSelectedFeature(feature);
      setSelectedFeatureLayer(layer);
      focusGeometry(mapRef.current, feature.geometry);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const saveSelectedFeature = async () => {
    if (!selectedFeature || !selectedFeatureLayer) return;
    let geometry: unknown = null;
    try {
      if (featureGeometryDraft.trim()) {
        geometry = JSON.parse(featureGeometryDraft);
      }
      const properties = Object.fromEntries(
        editableFeatureAttributes(selectedFeatureLayer).map((attribute) => [
          attribute.name,
          parseEditedProperty(
            featurePropertyDraft[attribute.name] ?? "",
            selectedFeature.properties[attribute.name],
            attribute.name
          )
        ])
      );
      setSavingFeature(true);
      const feature = await updateFeature(selectedFeatureLayer.id, selectedFeature.featureId, {
        properties,
        geometry
      });
      setSelectedFeature(feature);
      reloadLayerSource(selectedFeatureLayer.id);
      void refreshLayers();
      setNotice("地物を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingFeature(false);
    }
  };

  const pollAnalysisJob = (id: string) => {
    const timer = window.setInterval(async () => {
      try {
        const job = await getAnalysisJob(id);
        setAnalysisJobs((current) => upsertJob(current, job));
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          void refreshLayers();
        }
      } catch (error) {
        window.clearInterval(timer);
        setNotice(errorMessage(error));
      }
    }, 1500);
  };

  const toggleLayer = (layerId: string) => {
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const toggleLayerGroup = (layerIds: string[]) => {
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      const allVisible = layerIds.every((layerId) => next.has(layerId));
      for (const layerId of layerIds) {
        if (allVisible) next.delete(layerId);
        else next.add(layerId);
      }
      return next;
    });
  };

  const removeLayersFromState = (layerIds: string[]) => {
    const deletedLayerIds = new Set(layerIds);
    const remainingLayers = layersRef.current.filter((layer) => !deletedLayerIds.has(layer.id));
    layersRef.current = remainingLayers;
    setLayers(remainingLayers);
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      deletedLayerIds.forEach((layerId) => next.delete(layerId));
      return next;
    });
    setZoneSpatialLayerIds((current) => {
      const remaining = current.filter((id) => !deletedLayerIds.has(id));
      return remaining.length ? remaining : defaultZoneSpatialLayerIds(remainingLayers);
    });
    setAttributeConditions((current) => current.filter((condition) => !deletedLayerIds.has(condition.layerId)));
    setSpatialConditions((current) => current.filter((condition) => !deletedLayerIds.has(condition.layerId)));
    setZoneSearchResults((current) => current.filter((result) => !deletedLayerIds.has(result.layerId)));
    setListMapHighlightResults((current) => current.filter((result) => !deletedLayerIds.has(result.layerId)));
    setManualMapHighlightResults((current) =>
      current ? current.filter((result) => !deletedLayerIds.has(result.layerId)) : current
    );
    setSelectedFeature((current) => (current && deletedLayerIds.has(current.layerId) ? null : current));
    setSelectedFeatureLayer((current) => (current && deletedLayerIds.has(current.id) ? null : current));
    setTargetLayerId((current) => (deletedLayerIds.has(current) ? remainingLayers[0]?.id ?? "" : current));
    setOuterTargetLayerId((current) => (deletedLayerIds.has(current) ? remainingLayers.filter(isPolygonLayer)[0]?.id ?? "" : current));
    setOuterBoundaryLayerId((current) =>
      deletedLayerIds.has(current) ? remainingLayers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer))[0]?.id ?? "" : current
    );
  };

  const removeLayerFromState = (layerId: string) => {
    removeLayersFromState([layerId]);
  };

  const requestLayerDelete = async (layer: Layer) => {
    if (!window.confirm(`レイヤ「${layer.name}」を削除します。実体テーブルも削除されます。よろしいですか？`)) {
      return;
    }
    setDeletingLayerIds((current) => new Set([...current, layer.id]));
    try {
      await deleteLayer(layer.id);
      removeLayerFromState(layer.id);
      await refreshLayers();
      setNotice("レイヤを削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingLayerIds((current) => {
        const next = new Set(current);
        next.delete(layer.id);
        return next;
      });
    }
  };

  const requestResultSetDelete = async (resultSet: Extract<LayerListItem, { type: "resultSet" }>) => {
    if (
      !window.confirm(
        `条件検索結果「${resultSet.name}」を削除します。配下の${resultSet.layers.length.toLocaleString()}レイヤと実体テーブルも削除されます。よろしいですか？`
      )
    ) {
      return;
    }
    setDeletingResultSetIds((current) => new Set([...current, resultSet.id]));
    try {
      await deleteResultSet(resultSet.id);
      removeLayersFromState(resultSet.layers.map((layer) => layer.id));
      await refreshLayers();
      setNotice("条件検索結果を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingResultSetIds((current) => {
        const next = new Set(current);
        next.delete(resultSet.id);
        return next;
      });
    }
  };

  const startLayerDrag = (event: DragEvent<HTMLDivElement>, layerId: string) => {
    setDraggingLayerId(layerId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
  };

  const dragLayerOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const dropLayer = (event: DragEvent<HTMLDivElement>, targetLayerId: string) => {
    event.preventDefault();
    const sourceLayerId = event.dataTransfer.getData("text/plain") || draggingLayerId;
    setDraggingLayerId(null);
    if (!sourceLayerId || sourceLayerId === targetLayerId) return;
    setLayers((current) => moveLayerBefore(current, sourceLayerId, targetLayerId));
  };

  const addAttributeCondition = () => {
    const layer = layerById.get(zoneSpatialLayerIds[0] ?? targetLayerId) ?? layers[0];
    setAttributeConditions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        layerId: layer?.id ?? "",
        field: layer?.attributes[0]?.name ?? "",
        operator: "=",
        value: ""
      }
    ]);
  };

  const addSpatialCondition = () => {
    const targetIds = new Set(zoneSpatialLayerIds);
    const layer = layers.find((item) => !targetIds.has(item.id)) ?? layers[0];
    setSpatialConditions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        comparisonTarget: "layer",
        layerId: layer?.id ?? "",
        operator: "intersects",
        distanceMeters: "50"
      }
    ]);
  };

  const beginCreateZone = () => {
    setCreatingZone(true);
    setSelectedZoneId(null);
    setSelectedZone(null);
    setZoneDraft(newZoneDraft(selectedFeature, selectedFeatureLayer, zoneLayers[0]));
    window.history.pushState(null, "", "/zones");
    setRouteSelection({ tab: "zone", id: null });
  };

  const beginCreateLand = () => {
    setCreatingLand(true);
    setSelectedLandId(null);
    setSelectedLand(null);
    setLandDraft(newLandDraft());
    window.history.pushState(null, "", "/lands");
    setRouteSelection({ tab: "lands", id: null });
  };

  const beginCreateBuilding = () => {
    setCreatingBuilding(true);
    setSelectedBuildingId(null);
    setSelectedBuilding(null);
    setBuildingDraft(newBuildingDraft());
    window.history.pushState(null, "", "/buildings");
    setRouteSelection({ tab: "buildings", id: null });
  };

  const beginCreateParty = () => {
    setCreatingParty(true);
    setSelectedPartyId(null);
    setSelectedParty(null);
    setPartyDraft(newPartyDraft());
    window.history.pushState(null, "", "/parties");
    setRouteSelection({ tab: "parties", id: null });
  };

  const cancelCreateZone = () => {
    setCreatingZone(false);
    setSelectedZoneId(null);
    setSelectedZone(null);
    setZoneDraft(emptyZoneDraft());
    window.history.pushState(null, "", "/zones");
    setRouteSelection({ tab: "zone", id: null });
  };

  const cancelCreateLand = () => {
    setCreatingLand(false);
    setSelectedLandId(null);
    setSelectedLand(null);
    setLandDraft(emptyLandDraft());
    window.history.pushState(null, "", "/lands");
    setRouteSelection({ tab: "lands", id: null });
  };

  const cancelCreateBuilding = () => {
    setCreatingBuilding(false);
    setSelectedBuildingId(null);
    setSelectedBuilding(null);
    setBuildingDraft(emptyBuildingDraft());
    window.history.pushState(null, "", "/buildings");
    setRouteSelection({ tab: "buildings", id: null });
  };

  const cancelCreateParty = () => {
    setCreatingParty(false);
    setSelectedPartyId(null);
    setSelectedParty(null);
    setPartyDraft(emptyPartyDraft());
    window.history.pushState(null, "", "/parties");
    setRouteSelection({ tab: "parties", id: null });
  };

  const saveZone = async () => {
    if (!zoneDraft.name.trim() || !zoneDraft.status.trim()) {
      setNotice("区域名、ステータスは必須です");
      return;
    }
    if (creatingZone && !zoneDraft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    if (!(zoneDraft.zoneLayerId ?? "").trim() || !(zoneDraft.zoneFeatureId ?? "").trim()) {
      setNotice("区域レイヤと地物IDは必須です");
      return;
    }
    try {
      setSavingZone(true);
      const payload = {
        ...(creatingZone ? { id: zoneDraft.id.trim(), projectId: selectedProject } : {}),
        name: zoneDraft.name,
        zoneType: nullableString(zoneDraft.zoneType),
        status: zoneDraft.status,
        memo: nullableString(zoneDraft.memo),
        zoneLayerId: zoneDraft.zoneLayerId ?? "",
        zoneFeatureId: zoneDraft.zoneFeatureId ?? "",
        sourceLayerId: zoneDraft.zoneLayerId ?? "",
        sourceFeatureId: zoneDraft.zoneFeatureId ?? ""
      };
      const item = creatingZone ? await createZone(payload) : selectedZone ? await updateZone(selectedZone.id, payload) : null;
      if (!item) return;
      if (creatingZone) {
        window.history.pushState(null, "", `/zones/${encodeURIComponent(item.id)}`);
        setRouteSelection({ tab: "zone", id: item.id });
      }
      setCreatingZone(false);
      setSelectedZoneId(item.id);
      setSelectedZone(item);
      setZoneDraft(toZoneDraft(item));
      void refreshZones();
      setNotice(creatingZone ? "区域を作成しました" : "区域を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingZone(false);
    }
  };

  const removeZone = async () => {
    if (!selectedZone || !window.confirm(`${selectedZone.id} を削除しますか`)) return;
    try {
      setDeletingZone(true);
      await deleteZone(selectedZone.id);
      setSelectedZoneId(null);
      setSelectedZone(null);
      window.history.pushState(null, "", "/zones");
      setRouteSelection({ tab: "zone", id: null });
      await refreshZones();
      setNotice("区域を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingZone(false);
    }
  };

  const saveLand = async () => {
    if (!landDraft.lotNumber.trim() || !landDraft.address.trim() || !landDraft.status.trim()) {
      setNotice("地番、所在地、ステータスは必須です");
      return;
    }
    if (creatingLand && !landDraft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    try {
      setSavingLand(true);
      const payload = {
        ...(creatingLand ? { id: landDraft.id.trim(), projectId: selectedProject } : {}),
        lotNumber: landDraft.lotNumber,
        address: landDraft.address,
        landUse: nullableString(landDraft.landUse),
        areaSqm: nullableNumber(landDraft.areaSqm, "面積"),
        registeredOwner: nullableString(landDraft.registeredOwner),
        rightType: nullableString(landDraft.rightType),
        registrationCause: nullableString(landDraft.registrationCause),
        registrationAcceptedOn: nullableString(landDraft.registrationAcceptedOn),
        status: landDraft.status,
        memo: nullableString(landDraft.memo),
        sourceLayerId: nullableString(landDraft.sourceLayerId),
        sourceFeatureId: nullableString(landDraft.sourceFeatureId)
      };
      const item = creatingLand ? await createLand(payload) : selectedLand ? await updateLand(selectedLand.id, payload) : null;
      if (!item) return;
      if (creatingLand) {
        window.history.pushState(null, "", `/lands/${encodeURIComponent(item.id)}`);
        setRouteSelection({ tab: "lands", id: item.id });
      }
      setCreatingLand(false);
      setSelectedLandId(item.id);
      setSelectedLand(item);
      setLandDraft(toLandDraft(item));
      void refreshLands();
      void refreshBuildings();
      void refreshZones();
      setNotice(creatingLand ? "土地を作成しました" : "土地を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingLand(false);
    }
  };

  const removeLand = async () => {
    if (!selectedLand || !window.confirm(`${selectedLand.id} を削除しますか`)) return;
    try {
      setDeletingLand(true);
      await deleteLand(selectedLand.id);
      setSelectedLandId(null);
      setSelectedLand(null);
      window.history.pushState(null, "", "/lands");
      setRouteSelection({ tab: "lands", id: null });
      await refreshLands();
      await refreshBuildings();
      await refreshZones();
      setNotice("土地を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingLand(false);
    }
  };

  const saveBuilding = async () => {
    if (!buildingDraft.name.trim() || !buildingDraft.status.trim()) {
      setNotice("建物名、ステータスは必須です");
      return;
    }
    if (creatingBuilding && !buildingDraft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    try {
      setSavingBuilding(true);
      const payload = {
        ...(creatingBuilding ? { id: buildingDraft.id.trim(), projectId: selectedProject } : {}),
        landId: nullableString(buildingDraft.landId),
        name: buildingDraft.name,
        buildingLocation: nullableString(buildingDraft.buildingLocation),
        houseNumber: nullableString(buildingDraft.houseNumber),
        buildingUse: nullableString(buildingDraft.buildingUse),
        floors: nullableInteger(buildingDraft.floors, "階数"),
        totalFloorAreaSqm: nullableNumber(buildingDraft.totalFloorAreaSqm, "延床面積"),
        structure: nullableString(buildingDraft.structure),
        registeredOwner: nullableString(buildingDraft.registeredOwner),
        rightType: nullableString(buildingDraft.rightType),
        registrationAcceptedOn: nullableString(buildingDraft.registrationAcceptedOn),
        status: buildingDraft.status,
        memo: nullableString(buildingDraft.memo),
        sourceLayerId: nullableString(buildingDraft.sourceLayerId),
        sourceFeatureId: nullableString(buildingDraft.sourceFeatureId)
      };
      const item = creatingBuilding
        ? await createBuilding(payload)
        : selectedBuilding
          ? await updateBuilding(selectedBuilding.id, payload)
          : null;
      if (!item) return;
      if (creatingBuilding) {
        window.history.pushState(null, "", `/buildings/${encodeURIComponent(item.id)}`);
        setRouteSelection({ tab: "buildings", id: item.id });
      }
      setCreatingBuilding(false);
      setSelectedBuildingId(item.id);
      setSelectedBuilding(item);
      setBuildingDraft(toBuildingDraft(item));
      void refreshBuildings();
      void refreshZones();
      if (selectedLandId) void getLand(selectedLandId).then(setSelectedLand).catch((error) => setNotice(errorMessage(error)));
      setNotice(creatingBuilding ? "建物を作成しました" : "建物を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingBuilding(false);
    }
  };

  const removeBuilding = async () => {
    if (!selectedBuilding || !window.confirm(`${selectedBuilding.id} を削除しますか`)) return;
    try {
      setDeletingBuilding(true);
      await deleteBuilding(selectedBuilding.id);
      setSelectedBuildingId(null);
      setSelectedBuilding(null);
      window.history.pushState(null, "", "/buildings");
      setRouteSelection({ tab: "buildings", id: null });
      await refreshBuildings();
      await refreshZones();
      if (selectedLandId) await getLand(selectedLandId).then(setSelectedLand);
      setNotice("建物を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingBuilding(false);
    }
  };

  const saveParty = async () => {
    if (!partyDraft.name.trim() || !partyDraft.partyType.trim()) {
      setNotice("名称、種別は必須です");
      return;
    }
    if (creatingParty && !partyDraft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    try {
      setSavingParty(true);
      const payload = {
        ...(creatingParty ? { id: partyDraft.id.trim(), projectId: selectedProject } : {}),
        name: partyDraft.name,
        partyType: partyDraft.partyType,
        contact: nullableString(partyDraft.contact),
        address: nullableString(partyDraft.address),
        memo: nullableString(partyDraft.memo),
        tags: parsePartyTags(partyDraft.tags)
      };
      const item = creatingParty ? await createParty(payload) : selectedParty ? await updateParty(selectedParty.id, payload) : null;
      if (!item) return;
      if (creatingParty) {
        window.history.pushState(null, "", `/parties/${encodeURIComponent(item.id)}`);
        setRouteSelection({ tab: "parties", id: item.id });
      }
      setCreatingParty(false);
      setSelectedPartyId(item.id);
      setSelectedParty(item);
      setPartyDraft(toPartyDraft(item));
      void refreshParties();
      setNotice(creatingParty ? "関係者を作成しました" : "関係者を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingParty(false);
    }
  };

  const removeParty = async () => {
    if (!selectedParty || !window.confirm(`${selectedParty.id} を削除しますか`)) return;
    try {
      setDeletingParty(true);
      await deleteParty(selectedParty.id);
      setSelectedPartyId(null);
      setSelectedParty(null);
      window.history.pushState(null, "", "/parties");
      setRouteSelection({ tab: "parties", id: null });
      await refreshParties();
      setNotice("関係者を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingParty(false);
    }
  };

  const refreshSelectedObjects = async () => {
    await Promise.all([
      selectedZoneId ? getZone(selectedZoneId).then(setSelectedZone) : Promise.resolve(),
      selectedLandId ? getLand(selectedLandId).then(setSelectedLand) : Promise.resolve(),
      selectedBuildingId ? getBuilding(selectedBuildingId).then(setSelectedBuilding) : Promise.resolve(),
      selectedPartyId ? getParty(selectedPartyId).then(setSelectedParty) : Promise.resolve()
    ]);
    void refreshZones();
    void refreshLands();
    void refreshBuildings();
    void refreshParties();
  };

  const saveRelationship = async (relationshipId: string | null, draft: RelationshipDraft) => {
    if (!draft.partyId || !draft.targetId || !draft.relationType.trim()) {
      setNotice("関係者、対象、関係種別は必須です");
      return;
    }
    try {
      const payload = {
        projectId: selectedProject,
        partyId: draft.partyId,
        targetType: draft.targetType,
        targetId: draft.targetId,
        relationType: draft.relationType,
        note: nullableString(draft.note)
      };
      if (relationshipId) {
        await updatePartyRelationship(relationshipId, payload);
      } else {
        await createPartyRelationship(payload);
      }
      await refreshSelectedObjects();
      setNotice(relationshipId ? "関係を更新しました" : "関係を追加しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const removeRelationship = async (relationshipId: string) => {
    if (!window.confirm("この関係を削除しますか")) return;
    try {
      await deletePartyRelationship(relationshipId);
      await refreshSelectedObjects();
      setNotice("関係を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const useMapBoundsFilter = (setter: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>) => {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) {
      setNotice("地図がまだ準備できていません");
      return;
    }
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
      .map((value) => value.toFixed(6))
      .join(",");
    setter((current) => ({ ...current, bbox }));
  };

  const useSelectedFeatureFilter = (setter: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>) => {
    if (!selectedFeature || !selectedFeatureLayer) {
      setNotice("先に地図上の地物を選択してください");
      return;
    }
    setter((current) => ({
      ...current,
      intersectsLayerId: selectedFeature.layerId,
      intersectsFeatureId: selectedFeature.featureId
    }));
  };

  const openSourceFeature = async (sourceLayerId?: string | null, sourceFeatureId?: string | null) => {
    if (!sourceLayerId || !sourceFeatureId) {
      setNotice("GISリンクがありません");
      return;
    }
    try {
      const feature = await getFeature(sourceLayerId, sourceFeatureId);
      const layer = layerById.get(sourceLayerId) ?? (await getLayers(selectedProject)).find((item) => item.id === sourceLayerId) ?? null;
      setSelectedFeature(feature);
      setSelectedFeatureLayer(layer);
      setMapSupportOpen(true);
      if (layer) {
        setVisibleLayerIds((current) => new Set([...current, layer.id]));
        setZoneSpatialLayerIds([layer.id]);
        setManualMapHighlightResults([
          {
            layerId: feature.layerId,
            layerName: layer.name,
            featureId: feature.featureId,
            properties: feature.properties,
            geometry: feature.geometry,
            businessLinks: emptyBusinessLinks,
            matchedBusinessLinks: emptyBusinessLinks,
            matchSummary: "GISリンク"
          }
        ]);
      }
      window.setTimeout(() => {
        mapRef.current?.resize();
        focusGeometry(mapRef.current, feature.geometry);
      }, 80);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const openZoneOnMap = async (zone: Zone) => {
    try {
      setMapSupportOpen(true);
      const zoneLayerId = zone.zoneLayerId ?? zone.sourceLayerId;
      const zoneFeatureId = zone.zoneFeatureId ?? zone.sourceFeatureId;
      const layer = layerById.get(zoneLayerId) ?? (await getLayers(selectedProject)).find((item) => item.id === zoneLayerId) ?? null;
      const zoneFeature = await getFeature(zoneLayerId, zoneFeatureId);
      setSelectedFeature(zoneFeature);
      setSelectedFeatureLayer(layer);
      if (layer) {
        setVisibleLayerIds((current) => new Set([...current, layer.id]));
        setZoneSpatialLayerIds([layer.id]);
      }

      const zoneDetail = (zone.lands?.length || zone.buildings?.length) ? zone : await getZone(zone.id);
      const containedLands = zoneDetail.lands ?? [];
      const containedBuildings = zoneDetail.buildings ?? [];
      const linkedResults: Array<FeatureSearchResult | null> = await Promise.all([
        ...containedLands.map(async (link) => {
          const land = await getLand(link.id);
          if (!land.sourceLayerId || !land.sourceFeatureId) return null;
          const landLayer = layerById.get(land.sourceLayerId);
          const feature = await getFeature(land.sourceLayerId, land.sourceFeatureId);
          return {
            layerId: feature.layerId,
            layerName: landLayer?.name ?? "土地",
            featureId: feature.featureId,
            properties: feature.properties,
            geometry: feature.geometry,
            businessLinks: { lands: [link], buildings: [] },
            matchedBusinessLinks: emptyBusinessLinks,
            matchSummary: "区域内の土地"
          } satisfies FeatureSearchResult;
        }),
        ...containedBuildings.map(async (link) => {
          const building = await getBuilding(link.id);
          if (!building.sourceLayerId || !building.sourceFeatureId) return null;
          const buildingLayer = layerById.get(building.sourceLayerId);
          const feature = await getFeature(building.sourceLayerId, building.sourceFeatureId);
          return {
            layerId: feature.layerId,
            layerName: buildingLayer?.name ?? "建物",
            featureId: feature.featureId,
            properties: feature.properties,
            geometry: feature.geometry,
            businessLinks: { lands: [], buildings: [link] },
            matchedBusinessLinks: emptyBusinessLinks,
            matchSummary: "区域内の建物"
          } satisfies FeatureSearchResult;
        })
      ]);
      setManualMapHighlightResults([
        {
          layerId: zoneFeature.layerId,
          layerName: layer?.name ?? "区域",
          featureId: zoneFeature.featureId,
          properties: zoneFeature.properties,
          geometry: zoneFeature.geometry,
          businessLinks: {
            lands: containedLands,
            buildings: containedBuildings
          },
          matchedBusinessLinks: emptyBusinessLinks,
          matchSummary: "選択区域"
        },
        ...linkedResults.filter((result): result is FeatureSearchResult => Boolean(result))
      ]);
      window.setTimeout(() => {
        mapRef.current?.resize();
        focusGeometry(mapRef.current, zoneFeature.geometry);
      }, 80);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  return (
    <div className="business-app">
      <header className="top-shell">
        <div className="product-mark">
          <FileText size={20} />
          <div>
            <strong>不動産業務管理</strong>
            <span>{projects.find((project) => project.id === selectedProject)?.name ?? "Project"}</span>
          </div>
        </div>
        <nav className="top-tabs" aria-label="業務タブ">
          <button className={activeTab === "zone" ? "active" : ""} type="button" onClick={() => navigateTab("zone")}>
            <MapIcon size={17} />
            区域
          </button>
          <button className={activeTab === "lands" ? "active" : ""} type="button" onClick={() => navigateTab("lands")}>
            <MapIcon size={17} />
            土地
          </button>
          <button className={activeTab === "buildings" ? "active" : ""} type="button" onClick={() => navigateTab("buildings")}>
            <Building2 size={17} />
            建物
          </button>
          <button className={activeTab === "parties" ? "active" : ""} type="button" onClick={() => navigateTab("parties")}>
            <Users size={17} />
            関係者
          </button>
        </nav>
        <button className="subtle-button top-map-toggle" type="button" onClick={() => setMapSupportOpen((open) => !open)}>
          {mapSupportOpen ? <EyeOff size={16} /> : <MapIcon size={16} />}
          {mapSupportOpen ? "地図を隠す" : "地図を表示"}
        </button>
      </header>

      <main className={`business-workspace${mapSupportOpen ? " map-open" : " map-closed"}`}>
        <div className="workspace-tabs">
        <section className={`tab-pane zone-tab${activeTab === "zone" ? " active" : ""}`} aria-hidden={activeTab !== "zone"}>
          <ZoneWorkspace
            query={zoneQuery}
            setQuery={setZoneQuery}
            filters={zoneFilters}
            setFilters={setZoneFilters}
            filtersOpen={zoneFiltersOpen}
            setFiltersOpen={setZoneFiltersOpen}
            items={zones}
            selectedId={selectedZoneId}
            selected={selectedZone}
            draft={zoneDraft}
            setDraft={setZoneDraft}
            creating={creatingZone}
            loading={loadingZones}
            saving={savingZone}
            deleting={deletingZone}
            onRefresh={() => void refreshZones()}
            onSearch={submitZoneListSearch}
            onSelect={selectZone}
            onCreate={beginCreateZone}
            onCancelCreate={cancelCreateZone}
            onBackToList={() => navigateTab("zone")}
            onSave={() => void saveZone()}
            onDelete={() => void removeZone()}
            onOpenLand={selectLand}
            onOpenBuilding={selectBuilding}
            onOpenParty={selectParty}
            onShowOnMap={(zone) => void openZoneOnMap(zone)}
            onOpenSourceFeature={(layerId, featureId) => void openSourceFeature(layerId, featureId)}
            onUseSelectedFeature={() => {
              if (!selectedFeature || !selectedFeatureLayer || !canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)) {
                setNotice("先に地図上の区域レイヤ地物を選択してください");
                return;
              }
              setZoneDraft((current) => ({
                ...current,
                zoneLayerId: selectedFeature.layerId,
                zoneFeatureId: selectedFeature.featureId
              }));
            }}
            layers={layers}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
            gisTools={
              <ZoneSearchPanel
                layers={layers}
                layerById={layerById}
                lands={lands}
                buildings={buildings}
                parties={parties}
                resultName={analysisName}
                setResultName={setAnalysisName}
                query={zoneSearchQuery}
                setQuery={setZoneSearchQuery}
                builderOpen={conditionBuilderOpen}
                setBuilderOpen={setConditionBuilderOpen}
                attributeConditions={attributeConditions}
                setAttributeConditions={setAttributeConditions}
                spatialConditions={spatialConditions}
                setSpatialConditions={setSpatialConditions}
                onAddAttribute={addAttributeCondition}
                onAddSpatial={addSpatialCondition}
                linkedOnly={zoneSearchLinkedOnly}
                setLinkedOnly={setZoneSearchLinkedOnly}
                spatialLayerIds={zoneSpatialLayerIds}
                setSpatialLayerIds={setZoneSpatialLayerIds}
                businessSourceType={zoneBusinessSourceType}
                setBusinessSourceType={setZoneBusinessSourceType}
                businessQuery={zoneBusinessQuery}
                setBusinessQuery={setZoneBusinessQuery}
                businessStatus={zoneBusinessStatus}
                setBusinessStatus={setZoneBusinessStatus}
                landUse={zoneLandUse}
                setLandUse={setZoneLandUse}
                buildingUse={zoneBuildingUse}
                setBuildingUse={setZoneBuildingUse}
                partyQuery={zonePartyQuery}
                setPartyQuery={setZonePartyQuery}
                partyType={zonePartyType}
                setPartyType={setZonePartyType}
                relationType={zoneRelationType}
                setRelationType={setZoneRelationType}
                loading={loadingZoneSearch}
                saving={savingConditionSearch}
                results={zoneSearchResults}
                selectedFeature={selectedFeature}
                onSearch={() => void submitZoneSearch()}
                onSave={() => void saveConditionSearchResult()}
                onClear={clearZoneSearchConditions}
                onSelect={(result) => void openZoneSearchResult(result)}
              />
            }
          />
        </section>

        <section className={`tab-pane${activeTab === "lands" ? " active" : ""}`} aria-hidden={activeTab !== "lands"}>
          <LandWorkspace
            query={landQuery}
            setQuery={setLandQuery}
            filters={landFilters}
            setFilters={setLandFilters}
            filtersOpen={landFiltersOpen}
            setFiltersOpen={setLandFiltersOpen}
            items={lands}
            selectedId={selectedLandId}
            selected={selectedLand}
            draft={landDraft}
            setDraft={setLandDraft}
            creating={creatingLand}
            loading={loadingLands}
            saving={savingLand}
            deleting={deletingLand}
            onRefresh={() => void refreshLands()}
            onSearch={submitLandListSearch}
            onSelect={selectLand}
            onCreate={beginCreateLand}
            onCancelCreate={cancelCreateLand}
            onBackToList={() => navigateTab("lands")}
            onSave={() => void saveLand()}
            onDelete={() => void removeLand()}
            onOpenBuilding={selectBuilding}
            onOpenParty={selectParty}
            onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
            onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
            onUseMapBounds={() => useMapBoundsFilter(setLandFilters)}
            onUseSelectedFeature={() => useSelectedFeatureFilter(setLandFilters)}
            onOpenSourceFeature={(layerId, featureId) => void openSourceFeature(layerId, featureId)}
            layers={layers}
            parties={parties}
            buildings={buildings}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>

        <section className={`tab-pane${activeTab === "buildings" ? " active" : ""}`} aria-hidden={activeTab !== "buildings"}>
          <BuildingWorkspace
            query={buildingQuery}
            setQuery={setBuildingQuery}
            filters={buildingFilters}
            setFilters={setBuildingFilters}
            filtersOpen={buildingFiltersOpen}
            setFiltersOpen={setBuildingFiltersOpen}
            items={buildings}
            lands={lands}
            selectedId={selectedBuildingId}
            selected={selectedBuilding}
            draft={buildingDraft}
            setDraft={setBuildingDraft}
            creating={creatingBuilding}
            loading={loadingBuildings}
            saving={savingBuilding}
            deleting={deletingBuilding}
            onRefresh={() => void refreshBuildings()}
            onSearch={submitBuildingListSearch}
            onSelect={selectBuilding}
            onCreate={beginCreateBuilding}
            onCancelCreate={cancelCreateBuilding}
            onBackToList={() => navigateTab("buildings")}
            onSave={() => void saveBuilding()}
            onDelete={() => void removeBuilding()}
            onOpenLand={selectLand}
            onOpenParty={selectParty}
            onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
            onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
            onUseMapBounds={() => useMapBoundsFilter(setBuildingFilters)}
            onUseSelectedFeature={() => useSelectedFeatureFilter(setBuildingFilters)}
            onOpenSourceFeature={(layerId, featureId) => void openSourceFeature(layerId, featureId)}
            layers={layers}
            parties={parties}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>

        <section className={`tab-pane${activeTab === "parties" ? " active" : ""}`} aria-hidden={activeTab !== "parties"}>
          <PartyWorkspace
            query={partyQuery}
            setQuery={setPartyQuery}
            filters={partyFilters}
            setFilters={setPartyFilters}
            filtersOpen={partyFiltersOpen}
            setFiltersOpen={setPartyFiltersOpen}
            items={parties}
            lands={lands}
            buildings={buildings}
            selectedId={selectedPartyId}
            selected={selectedParty}
            draft={partyDraft}
            setDraft={setPartyDraft}
            creating={creatingParty}
            loading={loadingParties}
            saving={savingParty}
            deleting={deletingParty}
            onRefresh={() => void refreshParties()}
            onSearch={submitPartyListSearch}
            onSelect={selectParty}
            onCreate={beginCreateParty}
            onCancelCreate={cancelCreateParty}
            onBackToList={() => navigateTab("parties")}
            onSave={() => void saveParty()}
            onDelete={() => void removeParty()}
            onOpenLand={selectLand}
            onOpenBuilding={selectBuilding}
            onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
            onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>
        </div>

        <MapSupportPane
          open={mapSupportOpen}
          onToggle={() => setMapSupportOpen((open) => !open)}
          mapContainerRef={mapContainerRef}
          baseMapVisible={baseMapVisible}
          setBaseMapVisible={setBaseMapVisible}
          layerListItems={layerListItems}
          visibleLayerIds={visibleLayerIds}
          loadingLayers={loadingLayers}
          deletingLayerIds={deletingLayerIds}
          deletingResultSetIds={deletingResultSetIds}
          draggingLayerId={draggingLayerId}
          onRefreshLayers={() => void refreshLayers()}
          onToggleLayer={toggleLayer}
          onToggleLayerGroup={toggleLayerGroup}
          onRequestLayerDelete={(layer) => void requestLayerDelete(layer)}
          onConvertLayerToZone={(layer) => void convertLayerToZoneLayer(layer)}
          onRequestResultSetDelete={(resultSet) => void requestResultSetDelete(resultSet)}
          onDragLayerStart={startLayerDrag}
          onDragLayerOver={dragLayerOver}
          onDropLayer={dropLayer}
          onDragLayerEnd={() => setDraggingLayerId(null)}
          selectedFeature={selectedFeature}
          selectedFeatureLayer={selectedFeatureLayer}
          businessLinks={businessLinks}
          loadingBusinessLinks={loadingBusinessLinks}
          featureEditOpen={featureEditOpen}
          setFeatureEditOpen={setFeatureEditOpen}
          featurePropertyDraft={featurePropertyDraft}
          setFeaturePropertyDraft={setFeaturePropertyDraft}
          featureGeometryDraft={featureGeometryDraft}
          setFeatureGeometryDraft={setFeatureGeometryDraft}
          savingFeature={savingFeature}
          onSaveFeature={() => void saveSelectedFeature()}
          uploadFile={uploadFile}
          setUploadFile={setUploadFile}
          uploadFormat={uploadFormat}
          setUploadFormat={setUploadFormat}
          uploadSrid={uploadSrid}
          setUploadSrid={setUploadSrid}
          uploadAsZoneLayer={uploadAsZoneLayer}
          setUploadAsZoneLayer={setUploadAsZoneLayer}
          onSubmitUpload={() => void submitUpload()}
          outerBoundaryName={outerBoundaryName}
          setOuterBoundaryName={setOuterBoundaryName}
          outerTargetLayerId={outerTargetLayerId}
          setOuterTargetLayerId={setOuterTargetLayerId}
          outerBoundaryLayerId={outerBoundaryLayerId}
          setOuterBoundaryLayerId={setOuterBoundaryLayerId}
          outerBoundaryBufferMeters={outerBoundaryBufferMeters}
          setOuterBoundaryBufferMeters={setOuterBoundaryBufferMeters}
          polygonLayers={polygonLayers}
          boundaryCandidateLayers={boundaryCandidateLayers}
          onSubmitOuterBoundary={() => void submitOuterBoundary()}
          facilityZoneName={facilityZoneName}
          setFacilityZoneName={setFacilityZoneName}
          facilityZoneLayerId={facilityZoneLayerId}
          setFacilityZoneLayerId={setFacilityZoneLayerId}
          facilityZoneBufferMeters={facilityZoneBufferMeters}
          setFacilityZoneBufferMeters={setFacilityZoneBufferMeters}
          facilityZoneDistanceMeters={facilityZoneDistanceMeters}
          setFacilityZoneDistanceMeters={setFacilityZoneDistanceMeters}
          facilityZoneSourceType={facilityZoneSourceType}
          setFacilityZoneSourceType={setFacilityZoneSourceType}
          pointLayers={pointLayers}
          creatingFacilityZone={creatingFacilityZone}
          onSubmitFacilityZone={() => void submitFacilityZoneLayer()}
          importJobs={importJobs}
          analysisJobs={analysisJobs}
        />
      </main>

      {notice ? (
        <div className="notice business-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConditionEditor({
  layers,
  layerById,
  attributeConditions,
  setAttributeConditions,
  spatialConditions,
  setSpatialConditions
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
  attributeConditions: AttributeConditionDraft[];
  setAttributeConditions: React.Dispatch<React.SetStateAction<AttributeConditionDraft[]>>;
  spatialConditions: SpatialConditionDraft[];
  setSpatialConditions: React.Dispatch<React.SetStateAction<SpatialConditionDraft[]>>;
}) {
  const [attributeValueOptions, setAttributeValueOptions] = useState<Record<string, string[]>>({});
  const attributeValueLookups = useMemo(
    () =>
      Array.from(
        new Map(
          attributeConditions
            .filter((condition) => condition.layerId && condition.field && condition.operator !== "IS NULL")
            .map((condition) => [
              attributeValueOptionKey(condition.layerId, condition.field),
              { key: attributeValueOptionKey(condition.layerId, condition.field), layerId: condition.layerId, field: condition.field }
            ])
        ).values()
      ),
    [attributeConditions]
  );

  useEffect(() => {
    const pendingLookups = attributeValueLookups.filter((lookup) => !(lookup.key in attributeValueOptions));
    if (!pendingLookups.length) return;
    let cancelled = false;
    pendingLookups.forEach((lookup) => {
      void getLayerAttributeValues(lookup.layerId, lookup.field)
        .then((values) => {
          if (cancelled) return;
          setAttributeValueOptions((current) => (lookup.key in current ? current : { ...current, [lookup.key]: values }));
        })
        .catch(() => {
          if (cancelled) return;
          setAttributeValueOptions((current) => (lookup.key in current ? current : { ...current, [lookup.key]: [] }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [attributeValueLookups, attributeValueOptions]);

  const updateAttribute = (id: string, patch: Partial<AttributeConditionDraft>) => {
    setAttributeConditions((current) =>
      current.map((condition) => {
        if (condition.id !== id) return condition;
        const next = { ...condition, ...patch };
        if (patch.layerId !== undefined) {
          next.field = layerById.get(patch.layerId)?.attributes[0]?.name ?? "";
          next.value = "";
        }
        if (patch.field !== undefined) {
          next.value = "";
        }
        if (patch.operator === "IS NULL") {
          next.value = "";
        }
        return next;
      })
    );
  };

  return (
    <div className="conditions">
      {attributeConditions.map((condition) => {
        const fields = layerById.get(condition.layerId)?.attributes ?? [];
        const valueOptions = attributeValueOptions[attributeValueOptionKey(condition.layerId, condition.field)] ?? [];
        const exactValueOperator = condition.operator === "=" || condition.operator === "!=";
        const listId = `attribute-values-${condition.id}`;
        return (
          <div className="condition-row" key={condition.id}>
            <select value={condition.layerId} onChange={(event) => updateAttribute(condition.id, { layerId: event.target.value })}>
              {layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
            <select value={condition.field} onChange={(event) => updateAttribute(condition.id, { field: event.target.value })}>
              {fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
            <select value={condition.operator} onChange={(event) => updateAttribute(condition.id, { operator: event.target.value })}>
              {attributeOperators.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </select>
            {condition.operator === "IS NULL" ? (
              <input value="" disabled placeholder="値なし" />
            ) : exactValueOperator && valueOptions.length ? (
              <ChoiceSelect value={condition.value} onChange={(value) => updateAttribute(condition.id, { value })} options={valueOptions} emptyLabel="値を選択" />
            ) : (
              <>
                <input
                  value={condition.value}
                  onChange={(event) => updateAttribute(condition.id, { value: event.target.value })}
                  list={listId}
                  placeholder={condition.operator === "IN" ? "候補をカンマ区切り" : undefined}
                />
                <datalist id={listId}>
                  {valueOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </>
            )}
            <button
              className="icon-button"
              type="button"
              onClick={() => setAttributeConditions((current) => current.filter((item) => item.id !== condition.id))}
              title="条件削除"
            >
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}

      {spatialConditions.map((condition) => (
        <div className="condition-row spatial" key={condition.id}>
          <select
            value={condition.comparisonTarget}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) =>
                  item.id === condition.id
                    ? { ...item, comparisonTarget: event.target.value as SpatialConditionDraft["comparisonTarget"] }
                    : item
                )
              )
            }
            aria-label="空間比較対象"
          >
            <option value="layer">レイヤ</option>
            <option value="business">業務データ</option>
          </select>
          <select
            value={condition.layerId}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, layerId: event.target.value } : item))
              )
            }
            disabled={condition.comparisonTarget === "business"}
          >
            {condition.comparisonTarget === "business" ? (
              <option value="">業務条件に一致する土地/建物</option>
            ) : (
              layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))
            )}
          </select>
          <select
            value={condition.operator}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, operator: event.target.value } : item))
              )
            }
          >
            {conditionSpatialOperators.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
          <input
            value={condition.operator === "dwithin" ? condition.distanceMeters : ""}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, distanceMeters: event.target.value } : item))
              )
            }
            disabled={condition.operator !== "dwithin"}
            placeholder={condition.operator === "dwithin" ? "m" : "距離なし"}
            inputMode="decimal"
            aria-label="dwithin距離メートル"
          />
          <button
            className="icon-button"
            type="button"
            onClick={() => setSpatialConditions((current) => current.filter((item) => item.id !== condition.id))}
            title="条件削除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ZoneSearchPanel({
  layers,
  layerById,
  lands,
  buildings,
  parties,
  resultName,
  setResultName,
  query,
  setQuery,
  builderOpen,
  setBuilderOpen,
  attributeConditions,
  setAttributeConditions,
  spatialConditions,
  setSpatialConditions,
  onAddAttribute,
  onAddSpatial,
  linkedOnly,
  setLinkedOnly,
  spatialLayerIds,
  setSpatialLayerIds,
  businessSourceType,
  setBusinessSourceType,
  businessQuery,
  setBusinessQuery,
  businessStatus,
  setBusinessStatus,
  landUse,
  setLandUse,
  buildingUse,
  setBuildingUse,
  partyQuery,
  setPartyQuery,
  partyType,
  setPartyType,
  relationType,
  setRelationType,
  loading,
  saving,
  results,
  selectedFeature,
  onSearch,
  onSave,
  onClear,
  onSelect
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
  lands: Land[];
  buildings: Building[];
  parties: Party[];
  resultName: string;
  setResultName: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  builderOpen: boolean;
  setBuilderOpen: (value: boolean) => void;
  attributeConditions: AttributeConditionDraft[];
  setAttributeConditions: React.Dispatch<React.SetStateAction<AttributeConditionDraft[]>>;
  spatialConditions: SpatialConditionDraft[];
  setSpatialConditions: React.Dispatch<React.SetStateAction<SpatialConditionDraft[]>>;
  onAddAttribute: () => void;
  onAddSpatial: () => void;
  linkedOnly: boolean;
  setLinkedOnly: (value: boolean) => void;
  spatialLayerIds: string[];
  setSpatialLayerIds: React.Dispatch<React.SetStateAction<string[]>>;
  businessSourceType: ZoneBusinessSourceType;
  setBusinessSourceType: (value: ZoneBusinessSourceType) => void;
  businessQuery: string;
  setBusinessQuery: (value: string) => void;
  businessStatus: string;
  setBusinessStatus: (value: string) => void;
  landUse: string;
  setLandUse: (value: string) => void;
  buildingUse: string;
  setBuildingUse: (value: string) => void;
  partyQuery: string;
  setPartyQuery: (value: string) => void;
  partyType: string;
  setPartyType: (value: string) => void;
  relationType: string;
  setRelationType: (value: string) => void;
  loading: boolean;
  saving: boolean;
  results: FeatureSearchResult[];
  selectedFeature: Feature | null;
  onSearch: () => void;
  onSave: () => void;
  onClear: () => void;
  onSelect: (result: FeatureSearchResult) => void;
}) {
  const groupedResults = groupFeatureResults(results);
  const toggleSpatialLayer = (id: string, checked: boolean) => {
    setSpatialLayerIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((item) => item !== id);
    });
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch();
  };
  const searchDisabled = loading || !spatialLayerIds.length;
  const statusChoices = useMemo(
    () => mergeChoiceOptions(businessStatusOptions, lands.map((land) => land.status), buildings.map((building) => building.status), businessStatus),
    [buildings, businessStatus, lands]
  );
  const landUseChoices = useMemo(
    () => mergeChoiceOptions(landUseOptions, lands.map((land) => land.landUse), landUse),
    [landUse, lands]
  );
  const buildingUseChoices = useMemo(
    () => mergeChoiceOptions(buildingUseOptions, buildings.map((building) => building.buildingUse), buildingUse),
    [buildingUse, buildings]
  );
  const partyNameChoices = useMemo(
    () => mergeChoiceOptions([], parties.map((party) => party.name), partyQuery),
    [parties, partyQuery]
  );
  const partyTypeChoices = useMemo(
    () => mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType), partyType),
    [parties, partyType]
  );
  const relationTypeChoices = useMemo(
    () => relationshipTypeChoices(lands, buildings, parties),
    [buildings, lands, parties]
  );
  const businessKeywordChoices = useMemo(() => {
    const landChoices =
      businessSourceType === "building"
        ? []
        : lands.flatMap((land) => [land.id, land.lotNumber, land.address, land.landUse, land.status]);
    const buildingChoices =
      businessSourceType === "land"
        ? []
        : buildings.flatMap((building) => [
            building.id,
            building.name,
            building.landLabel,
            building.buildingLocation,
            building.buildingUse,
            building.structure,
            building.status
          ]);
    return mergeChoiceOptions([], landChoices, buildingChoices, businessQuery).slice(0, 120);
  }, [buildings, businessQuery, businessSourceType, lands]);
  const handleBusinessSourceTypeChange = (value: ZoneBusinessSourceType) => {
    setBusinessSourceType(value);
    if (value !== "land") setLandUse("");
    if (value !== "building") setBuildingUse("");
  };

  return (
    <section className="panel-section zone-search-section">
      <div className="section-title">
        <Search size={16} />
        <h2>条件検索</h2>
        {loading ? <Loader2 className="spin muted-icon" size={15} /> : null}
      </div>
      <form className="zone-search-form" onSubmit={handleSubmit}>
        <label className="search-field">
          キーワード
          <span>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
        </label>

        <div className="mini-heading">
          <span>対象レイヤ</span>
          <small>{spatialLayerIds.length.toLocaleString()}件選択</small>
        </div>
        <div className="zone-layer-checks compact-layer-checks" aria-label="対象レイヤ">
          {layers.map((layer) => (
            <label className="checkbox-field layer-check" key={layer.id}>
              <input
                type="checkbox"
                checked={spatialLayerIds.includes(layer.id)}
                onChange={(event) => toggleSpatialLayer(layer.id, event.target.checked)}
              />
              <span>{layer.name}</span>
            </label>
          ))}
          {!layers.length ? <p className="empty-state compact">対象レイヤはありません</p> : null}
        </div>

        <div className="button-row">
          <button className="subtle-button" type="button" onClick={() => setBuilderOpen(!builderOpen)}>
            <Plus size={15} />
            条件を追加
          </button>
          <button className="subtle-button" type="button" onClick={onClear}>
            <X size={15} />
            条件クリア
          </button>
          <button className="command-button" type="submit" disabled={searchDisabled}>
            {loading ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            検索
          </button>
        </div>

        {builderOpen ? (
          <div className="condition-builder">
            <div className="condition-builder-heading">
              <span>属性条件</span>
              <button className="subtle-button" type="button" onClick={onAddAttribute}>
                <Plus size={14} />
                属性
              </button>
            </div>
            <div className="condition-builder-heading">
              <span>空間条件</span>
              <button className="subtle-button" type="button" onClick={onAddSpatial}>
                <Plus size={14} />
                空間
              </button>
            </div>
            <ConditionEditor
              layers={layers}
              layerById={layerById}
              attributeConditions={attributeConditions}
              setAttributeConditions={setAttributeConditions}
              spatialConditions={spatialConditions}
              setSpatialConditions={setSpatialConditions}
            />

            <div className="condition-builder-heading">
              <span>業務条件</span>
              <label className="checkbox-field">
                <input type="checkbox" checked={linkedOnly} onChange={(event) => setLinkedOnly(event.target.checked)} />
                <span>使用</span>
              </label>
            </div>
            <div className="zone-condition-grid business-filter-grid">
              <label>
                業務対象
                <select
                  value={businessSourceType}
                  onChange={(event) => handleBusinessSourceTypeChange(event.target.value as ZoneBusinessSourceType)}
                >
                  <option value="all">土地または建物</option>
                  <option value="land">土地</option>
                  <option value="building">建物</option>
                </select>
              </label>
              <label>
                ステータス
                <ChoiceSelect value={businessStatus} onChange={setBusinessStatus} options={statusChoices} />
              </label>
              {businessSourceType === "land" ? (
                <label>
                  土地用途
                  <ChoiceSelect value={landUse} onChange={setLandUse} options={landUseChoices} />
                </label>
              ) : null}
              {businessSourceType === "building" ? (
                <label>
                  建物用途
                  <ChoiceSelect value={buildingUse} onChange={setBuildingUse} options={buildingUseChoices} />
                </label>
              ) : null}
              <label className="search-field">
                業務キーワード
                <span>
                  <Search size={15} />
                  <input
                    value={businessQuery}
                    onChange={(event) => setBusinessQuery(event.target.value)}
                    list="zone-business-keyword-options"
                  />
                </span>
                <datalist id="zone-business-keyword-options">
                  {businessKeywordChoices.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="zone-condition-grid business-party-grid">
              <label>
                事業者
                <ChoiceSelect value={partyQuery} onChange={setPartyQuery} options={partyNameChoices} />
              </label>
              <label>
                種別
                <ChoiceSelect value={partyType} onChange={setPartyType} options={partyTypeChoices} />
              </label>
              <label>
                関係
                <ChoiceSelect value={relationType} onChange={setRelationType} options={relationTypeChoices} />
              </label>
            </div>
          </div>
        ) : null}
      </form>

      <div className="zone-search-results" aria-live="polite">
        {results.length ? <div className="zone-result-summary">検索結果 {results.length.toLocaleString()}件</div> : null}
        {groupedResults.map((group) => (
          <div className="zone-result-group" key={group.layerId}>
            <div className="zone-result-group-heading">
              <strong>{group.layerName}</strong>
              <span>{group.results.length.toLocaleString()}件</span>
            </div>
            {group.results.map((result) => {
              const active = selectedFeature?.layerId === result.layerId && selectedFeature.featureId === result.featureId;
              return (
                <button
                  className={`zone-result-row${active ? " active" : ""}`}
                  key={`${result.layerId}:${result.featureId}`}
                  type="button"
                  onClick={() => onSelect(result)}
                >
                  <strong>ID {result.featureId}</strong>
                  <span>{result.matchSummary ?? "一致"}</span>
                  <em>{featureResultSummary(result)}</em>
                  <small>{featureResultBusinessSummary(result)}</small>
                </button>
              );
            })}
          </div>
        ))}
        {!results.length ? <p className="empty-state compact">検索結果はありません</p> : null}
      </div>

      {results.length ? (
        <div className="save-search-result">
          <label>
            結果名
            <input
              value={resultName}
              onChange={(event) => setResultName(event.target.value)}
              placeholder="条件検索結果名"
            />
          </label>
          <button className="command-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            結果として保存
          </button>
        </div>
      ) : null}
    </section>
  );
}

function FeatureEditor({
  layer,
  propertyDraft,
  setPropertyDraft,
  geometryDraft,
  setGeometryDraft,
  saving,
  onCancel,
  onSave
}: {
  layer: Layer;
  propertyDraft: Record<string, string>;
  setPropertyDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  geometryDraft: string;
  setGeometryDraft: React.Dispatch<React.SetStateAction<string>>;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editableAttributes = editableFeatureAttributes(layer);
  return (
    <div className="feature-editor">
      {editableAttributes.length ? (
        <div className="feature-editor-fields">
          {editableAttributes.map((attribute) => (
            <label key={attribute.name}>
              {attribute.name}
              <input
                value={propertyDraft[attribute.name] ?? ""}
                onChange={(event) =>
                  setPropertyDraft((current) => ({
                    ...current,
                    [attribute.name]: event.target.value
                  }))
                }
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="empty-state compact">編集可能な属性はありません</p>
      )}
      <label>
        GeoJSON
        <textarea value={geometryDraft} onChange={(event) => setGeometryDraft(event.target.value)} spellCheck={false} />
      </label>
      <div className="button-row">
        <button className="subtle-button" type="button" onClick={onCancel}>
          <X size={15} />
          閉じる
        </button>
        <button className="command-button" type="button" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
    </div>
  );
}

function JobList({ title, jobs }: { title: string; jobs: Array<ImportJob | AnalysisJob> }) {
  return (
    <div className="job-group">
      <h3>{title}</h3>
      {jobs.slice(0, 5).map((job) => (
        <div className="job-row" key={job.id}>
          <span className={`status-dot ${job.status}`} />
          <div>
            <strong>{"filename" in job ? job.filename : job.name}</strong>
            <span>
              {job.status}
              {"resultCount" in job && job.resultCount !== null && job.resultCount !== undefined
                ? ` · ${job.resultCount.toLocaleString()}件`
                : ""}
            </span>
            {job.errorMessage ? <em>{job.errorMessage}</em> : null}
          </div>
        </div>
      ))}
      {!jobs.length ? <p className="empty-state compact">ジョブはありません</p> : null}
    </div>
  );
}

function BusinessLinksPanel({ links, loading }: { links: BusinessLinks; loading: boolean }) {
  const hasLinks = links.lands.length > 0 || links.buildings.length > 0;
  return (
    <div className="business-links-panel">
      <div className="mini-heading">
        <span>業務リンク</span>
        {loading ? <Loader2 className="spin muted-icon" size={14} /> : null}
      </div>
      {hasLinks ? (
        <div className="business-link-groups">
          {links.lands.length ? (
            <div>
              <strong>関連する土地</strong>
              {links.lands.map((link) => (
                <a key={link.id} href={`/lands/${encodeURIComponent(link.id)}`} target="_blank" rel="noreferrer">
                  {link.id}
                  <span>{link.label}</span>
                  <ExternalLink size={13} />
                </a>
              ))}
            </div>
          ) : null}
          {links.buildings.length ? (
            <div>
              <strong>関連する建物</strong>
              {links.buildings.map((link) => (
                <a key={link.id} href={`/buildings/${encodeURIComponent(link.id)}`} target="_blank" rel="noreferrer">
                  {link.id}
                  <span>{link.label}</span>
                  <ExternalLink size={13} />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="empty-state compact">{loading ? "取得中" : "紐づく業務データはありません"}</p>
      )}
    </div>
  );
}

function ChoiceSelect({
  value,
  onChange,
  options,
  emptyLabel = "すべて"
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  emptyLabel?: string | null;
}) {
  const normalizedOptions = mergeChoiceOptions(options, value);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {emptyLabel !== null ? <option value="">{emptyLabel}</option> : null}
      {normalizedOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function ZonePartySummary({
  zoneId,
  onOpenParty
}: {
  zoneId: string;
  onOpenParty: (id: string) => void;
}) {
  const [summary, setSummary] = useState<ZonePartySummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setActiveTag(null);
    getZonePartySummary(zoneId)
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((err) => {
        if (active) {
          setSummary(null);
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zoneId]);

  if (loading) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">
          <Loader2 size={14} className="spin" /> 集計中…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">集計を取得できませんでした（{error}）</p>
      </div>
    );
  }

  if (!summary || summary.partyCount === 0) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">区域内に関係者は登録されていません</p>
      </div>
    );
  }

  const topCoverage = summary.parties.length ? Math.round(summary.parties[0].coverageRatio * 100) : 0;
  const visibleParties = activeTag
    ? summary.parties.filter((party) => party.tags.includes(activeTag))
    : summary.parties;

  return (
    <div className="object-related zone-party-summary">
      <h3>
        <Users size={15} /> 関係者
      </h3>

      <div className="zps-chips">
        <span className="zps-chip strong">関係者 {summary.partyCount}名</span>
        {summary.typeBreakdown.map((entry) => (
          <span key={`type-${entry.key}`} className="zps-chip">
            {entry.key} {entry.count}
          </span>
        ))}
        {summary.parties.length ? <span className="zps-chip">最上位カバー率 {topCoverage}%</span> : null}
      </div>

      {summary.tagBreakdown.length ? (
        <div className="zps-chips zps-tags">
          {summary.tagBreakdown.map((entry) => {
            const selected = activeTag === entry.key;
            return (
              <button
                key={`tag-${entry.key}`}
                type="button"
                className={`zps-tag-chip${selected ? " selected" : ""}`}
                onClick={() => setActiveTag(selected ? null : entry.key)}
                aria-pressed={selected}
              >
                {entry.key} {entry.count}
              </button>
            );
          })}
        </div>
      ) : null}

      <ul className="zps-list">
        {visibleParties.map((party) => {
          const coverage = Math.round(party.coverageRatio * 100);
          return (
            <li key={party.id}>
              <button type="button" className="zps-party" onClick={() => onOpenParty(party.id)}>
                <span className="zps-party-head">
                  <strong>{party.name}</strong>
                  <span className="zps-type-badge">{party.partyType}</span>
                  {party.tags.map((tag) => (
                    <span key={tag} className="zps-tag-badge">
                      {tag}
                    </span>
                  ))}
                </span>
                <span className="zps-party-meta">
                  区域内 {party.zoneInvolvement}件 / 全体 {party.projectInvolvement}件
                  {party.relationTypes.length ? ` · ${party.relationTypes.join("、")}` : ""}
                </span>
                <span className="zps-bar" title={`カバー率 ${coverage}%`}>
                  <span className="zps-bar-fill" style={{ width: `${coverage}%` }} />
                </span>
              </button>
            </li>
          );
        })}
        {!visibleParties.length ? (
          <li>
            <p className="empty-state compact">該当する関係者はいません</p>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function ZoneWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  selectedId,
  selected,
  draft,
  setDraft,
  creating,
  loading,
  saving,
  deleting,
  onRefresh,
  onSearch,
  onSelect,
  onCreate,
  onCancelCreate,
  onBackToList,
  onSave,
  onDelete,
  onOpenLand,
  onOpenBuilding,
  onOpenParty,
  onShowOnMap,
  onOpenSourceFeature,
  onUseSelectedFeature,
  layers,
  selectedFeature,
  selectedFeatureLayer,
  selectedProject,
  projects,
  onProjectChange,
  gisTools
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Zone[];
  selectedId: string | null;
  selected: Zone | null;
  draft: ZoneDraft;
  setDraft: React.Dispatch<React.SetStateAction<ZoneDraft>>;
  creating: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onBackToList: () => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onOpenParty: (id: string) => void;
  onShowOnMap: (zone: Zone) => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  onUseSelectedFeature: () => void;
  layers: Layer[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
  gisTools: React.ReactNode;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(zoneStatusOptions, items.map((zone) => zone.status), draft.status);
  const typeChoices = mergeChoiceOptions(zoneTypeOptions, items.map((zone) => zone.zoneType), draft.zoneType);
  const sourceLayers = useMemo(() => zoneLayerOptions(layers), [layers]);
  const selectedFeatureUsable = Boolean(
    selectedFeature && selectedFeatureLayer && canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)
  );
  const [featureOptions, setFeatureOptions] = useState<FeatureSearchResult[]>([]);
  const [loadingFeatureOptions, setLoadingFeatureOptions] = useState(false);
  const [featureOptionsError, setFeatureOptionsError] = useState<string | null>(null);

  useEffect(() => {
    const sourceLayerId = draft.zoneLayerId?.trim() ?? "";
    if (!sourceLayerId) {
      setFeatureOptions([]);
      setFeatureOptionsError(null);
      setLoadingFeatureOptions(false);
      return;
    }
    let active = true;
    setLoadingFeatureOptions(true);
    setFeatureOptionsError(null);
    searchFeatures({ projectId: selectedProject, layerId: sourceLayerId, limit: 80 })
      .then((results) => {
        if (active) setFeatureOptions(results.filter((result) => isPolygonGeometry(result.geometry)));
      })
      .catch((error) => {
        if (active) {
          setFeatureOptions([]);
          setFeatureOptionsError(errorMessage(error));
        }
      })
      .finally(() => {
        if (active) setLoadingFeatureOptions(false);
      });
    return () => {
      active = false;
    };
  }, [draft.zoneLayerId, selectedProject]);

  const featureOptionIds = new Set(featureOptions.map((option) => option.featureId));
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
        <ObjectSidebar
          title="区域"
          query={query}
          setQuery={setQuery}
          loading={loading}
          onRefresh={onRefresh}
          onSearch={onSearch}
          onCreate={onCreate}
          filterContent={
            <ZoneFilterPanel
              filters={filters}
              setFilters={setFilters}
              open={filtersOpen}
              setOpen={setFiltersOpen}
              layers={layers}
              statusOptions={statusChoices}
              typeOptions={typeChoices}
            />
          }
          selectedProject={selectedProject}
          projects={projects}
          onProjectChange={onProjectChange}
        >
          <div className="business-table-scroll">
            <table className="business-table zone-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>区域名</th>
                  <th>種別</th>
                  <th>ステータス</th>
                  <th>土地</th>
                  <th>建物</th>
                  <th>区域レイヤ</th>
                </tr>
              </thead>
              <tbody>
                {items.map((zone) => (
                  <tr className={selectedId === zone.id ? "active" : ""} key={zone.id} onClick={() => onSelect(zone.id)}>
                    <td>{zone.id}</td>
                    <td>
                      <strong>{zone.name}</strong>
                      <span>{zone.memo ?? ""}</span>
                    </td>
                    <td>{zone.zoneType ?? ""}</td>
                    <td>{zone.status}</td>
                    <td>{(zone.landCount ?? 0).toLocaleString()}</td>
                    <td>{(zone.buildingCount ?? 0).toLocaleString()}</td>
                    <td>{zoneLayerSummary(layers, zoneLayerIdOf(zone), zoneFeatureIdOf(zone))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!items.length ? <p className="empty-state">区域はありません</p> : null}
          <details className="advanced-gis-tools">
            <summary>
              <Layers size={15} />
              GIS検索
            </summary>
            {gisTools}
          </details>
        </ObjectSidebar>
      ) : null}

      {detailOpen ? (
        <section className="object-detail">
          {hasDetailContent ? (
            <>
              <ObjectDetailHeader
                id={creating ? draft.id || "新規区域" : selected?.id ?? ""}
                title={draft.name || "区域"}
                subtitle={draft.zoneType}
                status={draft.status}
                href={selected ? `/zones/${encodeURIComponent(selected.id)}` : undefined}
                onBack={creating ? onCancelCreate : onBackToList}
              />
              <div className="object-form">
                <label>
                  ID
                  <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
                </label>
                <label>
                  区域名
                  <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label>
                  種別
                  <ChoiceSelect
                    value={draft.zoneType}
                    onChange={(value) => setDraft((current) => ({ ...current, zoneType: value }))}
                    options={typeChoices}
                    emptyLabel="選択"
                  />
                </label>
                <label>
                  ステータス
                  <ChoiceSelect
                    value={draft.status}
                    onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
                    options={statusChoices}
                    emptyLabel="選択"
                  />
                </label>
                <label>
                  区域レイヤ
                  <select
                    value={draft.zoneLayerId ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        zoneLayerId: event.target.value,
                        zoneFeatureId: ""
                      }))
                    }
                  >
                    <option value="">選択</option>
                    {sourceLayers.map((layer) => (
                      <option key={layer.id} value={layer.id}>
                        {layer.name} ({layer.geometryType})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  区域地物
                  <select
                    value={draft.zoneFeatureId ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, zoneFeatureId: event.target.value }))}
                    disabled={!draft.zoneLayerId || loadingFeatureOptions || Boolean(featureOptionsError)}
                  >
                    <option value="">{loadingFeatureOptions ? "取得中" : "選択"}</option>
                    {draft.zoneFeatureId && !featureOptionIds.has(draft.zoneFeatureId) ? (
                      <option value={draft.zoneFeatureId}>ID {draft.zoneFeatureId}</option>
                    ) : null}
                    {featureOptions.map((result) => (
                      <option key={`${result.layerId}:${result.featureId}`} value={result.featureId}>
                        ID {result.featureId} · {featureResultSummary(result)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wide-field">
                  メモ
                  <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
                </label>
              </div>

              <div className="button-row compact-actions">
                <button className="subtle-button" type="button" onClick={onUseSelectedFeature} disabled={!selectedFeatureUsable}>
                  <Layers size={15} />
                  選択中の地物を設定
                </button>
                {selected ? (
                  <button className="subtle-button" type="button" onClick={() => onShowOnMap(selected)}>
                    <MapIcon size={15} />
                    地図で表示
                  </button>
                ) : null}
              </div>

              <SourceLinkPanel layers={layers} layerId={draft.zoneLayerId} featureId={draft.zoneFeatureId} onOpen={onOpenSourceFeature} />

              {selected ? <ZonePartySummary zoneId={selected.id} onOpenParty={onOpenParty} /> : null}

              {selected ? (
                <div className="object-related zone-contained-links">
                  <h3>含まれる土地</h3>
                  {(selected.lands ?? []).map((land) => (
                    <button key={land.id} type="button" onClick={() => onOpenLand(land.id)}>
                      <MapIcon size={15} />
                      <strong>{land.id}</strong>
                      <span>{land.label}</span>
                    </button>
                  ))}
                  {!(selected.lands ?? []).length ? <p className="empty-state compact">区域内の土地はありません</p> : null}
                  <h3>含まれる建物</h3>
                  {(selected.buildings ?? []).map((building) => (
                    <button key={building.id} type="button" onClick={() => onOpenBuilding(building.id)}>
                      <Building2 size={15} />
                      <strong>{building.id}</strong>
                      <span>{building.label}</span>
                    </button>
                  ))}
                  {!(selected.buildings ?? []).length ? <p className="empty-state compact">区域内の建物はありません</p> : null}
                </div>
              ) : null}

              <ObjectActions
                saving={saving}
                deleting={deleting}
                onSave={onSave}
                onDelete={onDelete}
                onCancel={onCancelCreate}
                creating={creating}
              />
            </>
          ) : (
            <p className="empty-state">区域を読み込み中です</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function ZoneFilterPanel({
  filters,
  setFilters,
  open,
  setOpen,
  layers,
  statusOptions,
  typeOptions
}: {
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  open: boolean;
  setOpen: (value: boolean) => void;
  layers: Layer[];
  statusOptions: string[];
  typeOptions: string[];
}) {
  const update = (key: keyof BusinessObjectFilters, value: string | boolean | undefined) => {
    setFilters((current) => ({ ...current, [key]: value === "" ? undefined : value }));
  };
  const sourceLayers = zoneLayerOptions(layers);
  return (
    <div className="business-filter-panel">
      <button className="subtle-button" type="button" onClick={() => setOpen(!open)}>
        <Search size={14} />
        {open ? "詳細条件を閉じる" : "詳細条件を表示"}
      </button>
      {open ? (
        <div className="business-filter-fields">
          <label>
            ステータス
            <ChoiceSelect value={filters.status ?? ""} onChange={(value) => update("status", value)} options={statusOptions} />
          </label>
          <label>
            種別
            <ChoiceSelect value={filters.zoneType ?? ""} onChange={(value) => update("zoneType", value)} options={typeOptions} />
          </label>
          <label>
            区域レイヤ
            <select value={filters.zoneLayerId ?? ""} onChange={(event) => update("zoneLayerId", event.target.value)}>
              <option value="">すべて</option>
              {sourceLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name} ({layer.geometryType})
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field filter-checkbox">
            <input type="checkbox" checked={filters.linkedOnly ?? false} onChange={(event) => update("linkedOnly", event.target.checked)} />
            <span>区域地物ありのみ</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function MapSupportPane({
  open,
  onToggle,
  mapContainerRef,
  baseMapVisible,
  setBaseMapVisible,
  layerListItems,
  visibleLayerIds,
  loadingLayers,
  deletingLayerIds,
  deletingResultSetIds,
  draggingLayerId,
  onRefreshLayers,
  onToggleLayer,
  onToggleLayerGroup,
  onRequestLayerDelete,
  onConvertLayerToZone,
  onRequestResultSetDelete,
  onDragLayerStart,
  onDragLayerOver,
  onDropLayer,
  onDragLayerEnd,
  selectedFeature,
  selectedFeatureLayer,
  businessLinks,
  loadingBusinessLinks,
  featureEditOpen,
  setFeatureEditOpen,
  featurePropertyDraft,
  setFeaturePropertyDraft,
  featureGeometryDraft,
  setFeatureGeometryDraft,
  savingFeature,
  onSaveFeature,
  uploadFile,
  setUploadFile,
  uploadFormat,
  setUploadFormat,
  uploadSrid,
  setUploadSrid,
  uploadAsZoneLayer,
  setUploadAsZoneLayer,
  onSubmitUpload,
  outerBoundaryName,
  setOuterBoundaryName,
  outerTargetLayerId,
  setOuterTargetLayerId,
  outerBoundaryLayerId,
  setOuterBoundaryLayerId,
  outerBoundaryBufferMeters,
  setOuterBoundaryBufferMeters,
  polygonLayers,
  boundaryCandidateLayers,
  onSubmitOuterBoundary,
  facilityZoneName,
  setFacilityZoneName,
  facilityZoneLayerId,
  setFacilityZoneLayerId,
  facilityZoneBufferMeters,
  setFacilityZoneBufferMeters,
  facilityZoneDistanceMeters,
  setFacilityZoneDistanceMeters,
  facilityZoneSourceType,
  setFacilityZoneSourceType,
  pointLayers,
  creatingFacilityZone,
  onSubmitFacilityZone,
  importJobs,
  analysisJobs
}: {
  open: boolean;
  onToggle: () => void;
  mapContainerRef: React.RefObject<HTMLDivElement>;
  baseMapVisible: boolean;
  setBaseMapVisible: React.Dispatch<React.SetStateAction<boolean>>;
  layerListItems: LayerListItem[];
  visibleLayerIds: Set<string>;
  loadingLayers: boolean;
  deletingLayerIds: Set<string>;
  deletingResultSetIds: Set<string>;
  draggingLayerId: string | null;
  onRefreshLayers: () => void;
  onToggleLayer: (layerId: string) => void;
  onToggleLayerGroup: (layerIds: string[]) => void;
  onRequestLayerDelete: (layer: Layer) => void;
  onConvertLayerToZone: (layer: Layer) => void;
  onRequestResultSetDelete: (resultSet: Extract<LayerListItem, { type: "resultSet" }>) => void;
  onDragLayerStart: (event: DragEvent<HTMLDivElement>, layerId: string) => void;
  onDragLayerOver: (event: DragEvent<HTMLDivElement>) => void;
  onDropLayer: (event: DragEvent<HTMLDivElement>, targetLayerId: string) => void;
  onDragLayerEnd: () => void;
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  businessLinks: BusinessLinks;
  loadingBusinessLinks: boolean;
  featureEditOpen: boolean;
  setFeatureEditOpen: React.Dispatch<React.SetStateAction<boolean>>;
  featurePropertyDraft: Record<string, string>;
  setFeaturePropertyDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  featureGeometryDraft: string;
  setFeatureGeometryDraft: React.Dispatch<React.SetStateAction<string>>;
  savingFeature: boolean;
  onSaveFeature: () => void;
  uploadFile: File | null;
  setUploadFile: (file: File | null) => void;
  uploadFormat: string;
  setUploadFormat: (value: string) => void;
  uploadSrid: string;
  setUploadSrid: (value: string) => void;
  uploadAsZoneLayer: boolean;
  setUploadAsZoneLayer: (value: boolean) => void;
  onSubmitUpload: () => void;
  outerBoundaryName: string;
  setOuterBoundaryName: (value: string) => void;
  outerTargetLayerId: string;
  setOuterTargetLayerId: (value: string) => void;
  outerBoundaryLayerId: string;
  setOuterBoundaryLayerId: (value: string) => void;
  outerBoundaryBufferMeters: string;
  setOuterBoundaryBufferMeters: (value: string) => void;
  polygonLayers: Layer[];
  boundaryCandidateLayers: Layer[];
  onSubmitOuterBoundary: () => void;
  facilityZoneName: string;
  setFacilityZoneName: (value: string) => void;
  facilityZoneLayerId: string;
  setFacilityZoneLayerId: (value: string) => void;
  facilityZoneBufferMeters: string;
  setFacilityZoneBufferMeters: (value: string) => void;
  facilityZoneDistanceMeters: string;
  setFacilityZoneDistanceMeters: (value: string) => void;
  facilityZoneSourceType: ZoneBusinessSourceType;
  setFacilityZoneSourceType: (value: ZoneBusinessSourceType) => void;
  pointLayers: Layer[];
  creatingFacilityZone: boolean;
  onSubmitFacilityZone: () => void;
  importJobs: ImportJob[];
  analysisJobs: AnalysisJob[];
}) {
  return (
    <aside className={`map-support-pane${open ? "" : " closed"}`}>
      <header className="map-support-header">
        <div>
          <p className="eyebrow">Map Support</p>
          <h2>地図</h2>
        </div>
        <button className="icon-button" type="button" onClick={onToggle} title="地図ペインを閉じる">
          <EyeOff size={16} />
        </button>
      </header>

      <div className="support-map-panel">
        <div ref={mapContainerRef} className="map-container" />
      </div>

      <div className="map-support-scroll">
        <section className="panel-section layer-list-section">
          <div className="section-title">
            <Layers size={16} />
            <h2>レイヤ</h2>
            {loadingLayers ? <Loader2 className="spin muted-icon" size={15} /> : null}
            <button className="icon-button inline-icon-button" type="button" onClick={onRefreshLayers} title="レイヤ更新">
              <RefreshCcw size={15} />
            </button>
          </div>
          <div className="layer-list">
            <div className="layer-row base-layer">
              <span className="drag-handle disabled" aria-hidden="true" />
              <button className="icon-button" type="button" onClick={() => setBaseMapVisible((visible) => !visible)} title="ベース地図表示切替">
                {baseMapVisible ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
              <div className="layer-meta">
                <strong>
                  <MapIcon size={14} />
                  OpenStreetMap
                </strong>
                <span>ベース地図</span>
              </div>
              <span className="layer-action-spacer" aria-hidden="true" />
            </div>
            {layerListItems.map((item) => {
              if (item.type === "resultSet") {
                const childIds = item.layers.map((layer) => layer.id);
                const allVisible = childIds.every((layerId) => visibleLayerIds.has(layerId));
                const deletingResultSet = deletingResultSetIds.has(item.id);
                return (
                  <div className="layer-result-group" key={item.id}>
                    <div className="layer-row layer-group-row">
                      <span className="drag-handle disabled" aria-hidden="true" />
                      <button className="icon-button" type="button" onClick={() => onToggleLayerGroup(childIds)} title="まとめて表示切替">
                        {allVisible ? <Eye size={17} /> : <EyeOff size={17} />}
                      </button>
                      <div className="layer-meta">
                        <strong>{item.name}</strong>
                        <span>条件検索結果 · {item.layers.length.toLocaleString()}レイヤ</span>
                      </div>
                      <button
                        className="icon-button danger-icon-button"
                        type="button"
                        onClick={() => onRequestResultSetDelete(item)}
                        disabled={deletingResultSet}
                        title="条件検索結果を削除"
                      >
                        {deletingResultSet ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                      </button>
                    </div>
                    {item.layers.map((layer) => (
                      <div className="layer-row child-layer-row" key={layer.id}>
                        <span className="drag-handle disabled" aria-hidden="true" />
                        <button className="icon-button" type="button" onClick={() => onToggleLayer(layer.id)} title="表示切替">
                          {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                        </button>
                        <div className="layer-meta">
                          <strong>{layer.name}</strong>
                          <span>
                            {layer.geometryType} · {layer.rowCount.toLocaleString()}件
                          </span>
                        </div>
                        <button
                          className="icon-button danger-icon-button"
                          type="button"
                          onClick={() => onRequestLayerDelete(layer)}
                          disabled={deletingResultSet || deletingLayerIds.has(layer.id)}
                          title="レイヤ削除"
                        >
                          {deletingResultSet || deletingLayerIds.has(layer.id) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    ))}
                  </div>
                );
              }
              const layer = item.layer;
              return (
                <div
                  className={`layer-row${draggingLayerId === layer.id ? " dragging" : ""}`}
                  key={layer.id}
                  draggable
                  onDragEnd={onDragLayerEnd}
                  onDragOver={onDragLayerOver}
                  onDragStart={(event) => onDragLayerStart(event, layer.id)}
                  onDrop={(event) => onDropLayer(event, layer.id)}
                >
                  <span className="drag-handle" title="ドラッグして並べ替え" aria-label="ドラッグして並べ替え">
                    <GripVertical size={16} />
                  </span>
                  <button className="icon-button" type="button" onClick={() => onToggleLayer(layer.id)} title="表示切替">
                    {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                  </button>
                  <div className="layer-meta">
                    <strong>{layer.name}</strong>
                    <span>
                      {layer.geometryType} · {layer.rowCount.toLocaleString()}件{layer.isResult ? " · 結果" : ""}{layer.layerRole === "zone" ? " · 区域" : ""}
                    </span>
                  </div>
                  {isPolygonLayer(layer) && layer.layerRole !== "zone" && !layer.isResult ? (
                    <button className="icon-button" type="button" onClick={() => onConvertLayerToZone(layer)} title="区域レイヤ化">
                      <MapIcon size={16} />
                    </button>
                  ) : null}
                  <button
                    className="icon-button danger-icon-button"
                    type="button"
                    onClick={() => onRequestLayerDelete(layer)}
                    disabled={deletingLayerIds.has(layer.id)}
                    title="レイヤ削除"
                  >
                    {deletingLayerIds.has(layer.id) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  </button>
                </div>
              );
            })}
            {!layerListItems.length ? <p className="empty-state">取込済みレイヤはありません</p> : null}
          </div>
        </section>

        <section className="panel-section">
          <h2>選択地物</h2>
          {selectedFeature && selectedFeatureLayer ? (
            <div className="feature-view">
              <div className="feature-heading">
                <div>
                  <strong>{selectedFeatureLayer.name}</strong>
                  <span>ID {selectedFeature.featureId}</span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setFeatureEditOpen((editing) => !editing)}
                  title={featureEditOpen ? "編集を閉じる" : "地物編集"}
                >
                  {featureEditOpen ? <X size={16} /> : <Pencil size={16} />}
                </button>
              </div>
              <BusinessLinksPanel links={businessLinks} loading={loadingBusinessLinks} />
              {featureEditOpen ? (
                <FeatureEditor
                  layer={selectedFeatureLayer}
                  propertyDraft={featurePropertyDraft}
                  setPropertyDraft={setFeaturePropertyDraft}
                  geometryDraft={featureGeometryDraft}
                  setGeometryDraft={setFeatureGeometryDraft}
                  saving={savingFeature}
                  onCancel={() => setFeatureEditOpen(false)}
                  onSave={onSaveFeature}
                />
              ) : (
                <div className="property-table">
                  {Object.entries(selectedFeature.properties).map(([key, value]) => (
                    <div className="property-row" key={key}>
                      <span>{key}</span>
                      <strong>{formatValue(value)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="empty-state">地図上の地物を選択してください</p>
          )}
        </section>

        <details className="map-tool-details">
          <summary>
            <Upload size={15} />
            取込
          </summary>
          <section className="panel-section">
            <input type="file" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
            <div className="inline-fields">
              <label>
                形式
                <select value={uploadFormat} onChange={(event) => setUploadFormat(event.target.value)}>
                  <option value="geojson">GeoJSON</option>
                  <option value="shapefile">Shapefile zip</option>
                  <option value="gml">GML</option>
                  <option value="kml">KML</option>
                  <option value="gpx">GPX</option>
                </select>
              </label>
              <label>
                SRID
                <input value={uploadSrid} onChange={(event) => setUploadSrid(event.target.value)} inputMode="numeric" />
              </label>
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={uploadAsZoneLayer} onChange={(event) => setUploadAsZoneLayer(event.target.checked)} />
              <span>区域レイヤとして取り込む</span>
            </label>
            <button className="command-button" type="button" onClick={onSubmitUpload} disabled={!uploadFile}>
              <Upload size={16} />
              取込開始
            </button>
          </section>
        </details>

        <details className="map-tool-details">
          <summary>
            <MapIcon size={15} />
            施設起点区域
          </summary>
          <section className="panel-section">
            <label>
              結果名
              <input value={facilityZoneName} onChange={(event) => setFacilityZoneName(event.target.value)} />
            </label>
            <label>
              施設ポイントレイヤ
              <select value={facilityZoneLayerId} onChange={(event) => setFacilityZoneLayerId(event.target.value)}>
                <option value="">選択</option>
                {pointLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-fields">
              <label>
                外縁距離(m)
                <input value={facilityZoneBufferMeters} onChange={(event) => setFacilityZoneBufferMeters(event.target.value)} inputMode="decimal" />
              </label>
              <label>
                抽出距離(m)
                <input value={facilityZoneDistanceMeters} onChange={(event) => setFacilityZoneDistanceMeters(event.target.value)} inputMode="decimal" />
              </label>
            </div>
            <label>
              対象
              <select value={facilityZoneSourceType} onChange={(event) => setFacilityZoneSourceType(event.target.value as ZoneBusinessSourceType)}>
                <option value="all">土地・建物</option>
                <option value="land">土地</option>
                <option value="building">建物</option>
              </select>
            </label>
            <button className="command-button" type="button" onClick={onSubmitFacilityZone} disabled={!facilityZoneLayerId || creatingFacilityZone}>
              {creatingFacilityZone ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              生成開始
            </button>
          </section>
        </details>

        <details className="map-tool-details">
          <summary>
            <MapIcon size={15} />
            外縁生成
          </summary>
          <section className="panel-section">
            <label>
              結果名
              <input value={outerBoundaryName} onChange={(event) => setOuterBoundaryName(event.target.value)} />
            </label>
            <label>
              ポリゴン1
              <select value={outerTargetLayerId} onChange={(event) => setOuterTargetLayerId(event.target.value)}>
                {polygonLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              区域指定レイヤ
              <select value={outerBoundaryLayerId} onChange={(event) => setOuterBoundaryLayerId(event.target.value)}>
                {boundaryCandidateLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              バッファ(m)
              <input value={outerBoundaryBufferMeters} onChange={(event) => setOuterBoundaryBufferMeters(event.target.value)} inputMode="decimal" />
            </label>
            <button className="command-button" type="button" onClick={onSubmitOuterBoundary} disabled={!outerTargetLayerId || !outerBoundaryLayerId}>
              <Play size={16} />
              外縁生成開始
            </button>
          </section>
        </details>

        <section className="panel-section">
          <h2>ジョブ</h2>
          <JobList title="取込" jobs={importJobs} />
          <JobList title="解析" jobs={analysisJobs} />
        </section>
      </div>
    </aside>
  );
}

function LandWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  selectedId,
  selected,
  draft,
  setDraft,
  creating,
  loading,
  saving,
  deleting,
  onRefresh,
  onSearch,
  onSelect,
  onCreate,
  onCancelCreate,
  onBackToList,
  onSave,
  onDelete,
  onOpenBuilding,
  onOpenParty,
  onSaveRelationship,
  onDeleteRelationship,
  onUseMapBounds,
  onUseSelectedFeature,
  onOpenSourceFeature,
  layers,
  parties,
  buildings,
  selectedFeature,
  selectedFeatureLayer,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Land[];
  selectedId: string | null;
  selected: Land | null;
  draft: LandDraft;
  setDraft: React.Dispatch<React.SetStateAction<LandDraft>>;
  creating: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onBackToList: () => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenBuilding: (id: string) => void;
  onOpenParty: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  onUseMapBounds: () => void;
  onUseSelectedFeature: () => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  layers: Layer[];
  parties: Party[];
  buildings: Building[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(businessStatusOptions, items.map((land) => land.status), draft.status);
  const landUseChoices = mergeChoiceOptions(landUseOptions, items.map((land) => land.landUse), draft.landUse);
  const rightTypeChoices = mergeChoiceOptions(rightTypeOptions, items.map((land) => land.rightType), draft.rightType);
  const registrationCauseChoices = mergeChoiceOptions(
    registrationCauseOptions,
    items.map((land) => land.registrationCause),
    draft.registrationCause
  );
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType));
  const relationChoices = relationshipTypeChoices(items, buildings, parties);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="土地"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="land"
            filters={filters}
            setFilters={setFilters}
            open={filtersOpen}
            setOpen={setFiltersOpen}
            layers={layers}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            onUseMapBounds={onUseMapBounds}
            onUseSelectedFeature={onUseSelectedFeature}
            statusOptions={statusChoices}
            useOptions={landUseChoices}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <div className="business-table-scroll">
          <table className="business-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>所在地 / 地番</th>
                <th>用途</th>
                <th>地積</th>
                <th>ステータス</th>
                <th>関係者</th>
                <th>GIS</th>
              </tr>
            </thead>
            <tbody>
              {items.map((land) => (
                <tr key={land.id} onClick={() => onSelect(land.id)}>
                  <td>{land.id}</td>
                  <td>
                    <strong>{land.address}</strong>
                    <span>{land.lotNumber}</span>
                  </td>
                  <td>{land.landUse ?? ""}</td>
                  <td>{formatArea(land.areaSqm)}</td>
                  <td>{land.status}</td>
                  <td>{relationshipSummary(land.relationships)}</td>
                  <td>{gisLinkSummary(land.sourceLayerId, land.sourceFeatureId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length ? <p className="empty-state">土地はありません</p> : null}
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規土地" : selected?.id ?? ""}
              title={draft.lotNumber || "土地"}
              subtitle={draft.address}
              status={draft.status}
              href={selected ? `/lands/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                地番
                <input value={draft.lotNumber} onChange={(event) => setDraft((current) => ({ ...current, lotNumber: event.target.value }))} />
              </label>
              <label className="wide-field">
                所在地
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label>
                地目/用途
                <ChoiceSelect
                  value={draft.landUse}
                  onChange={(value) => setDraft((current) => ({ ...current, landUse: value }))}
                  options={landUseChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                地積(m2)
                <input value={draft.areaSqm} onChange={(event) => setDraft((current) => ({ ...current, areaSqm: event.target.value }))} inputMode="decimal" />
              </label>
              <label>
                登記名義人
                <input value={draft.registeredOwner} onChange={(event) => setDraft((current) => ({ ...current, registeredOwner: event.target.value }))} />
              </label>
              <label>
                権利種別
                <ChoiceSelect
                  value={draft.rightType}
                  onChange={(value) => setDraft((current) => ({ ...current, rightType: value }))}
                  options={rightTypeChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                登記原因
                <ChoiceSelect
                  value={draft.registrationCause}
                  onChange={(value) => setDraft((current) => ({ ...current, registrationCause: value }))}
                  options={registrationCauseChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                受付日
                <input type="date" value={draft.registrationAcceptedOn} onChange={(event) => setDraft((current) => ({ ...current, registrationAcceptedOn: event.target.value }))} />
              </label>
              <label>
                ステータス
                <ChoiceSelect
                  value={draft.status}
                  onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
                  options={statusChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                GISレイヤ
                <select value={draft.sourceLayerId} onChange={(event) => setDraft((current) => ({ ...current, sourceLayerId: event.target.value }))}>
                  <option value="">未設定</option>
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                GIS地物ID
                <input value={draft.sourceFeatureId} onChange={(event) => setDraft((current) => ({ ...current, sourceFeatureId: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>

            <SourceLinkPanel layers={layers} layerId={draft.sourceLayerId} featureId={draft.sourceFeatureId} onOpen={onOpenSourceFeature} />

            {selected ? (
              <div className="object-related">
                <h3>建物</h3>
                {selected.buildings.map((building) => (
                  <button key={building.id} type="button" onClick={() => onOpenBuilding(building.id)}>
                    <Building2 size={15} />
                    <strong>{building.id}</strong>
                    <span>{building.label}</span>
                  </button>
                ))}
                {!selected.buildings.length ? <p className="empty-state compact">紐づく建物はありません</p> : null}
              </div>
            ) : null}

            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={parties}
                lands={items}
                buildings={buildings}
                fixedTarget={{ targetType: "land", targetId: selected.id }}
                onOpenParty={onOpenParty}
                onOpenLand={() => undefined}
                onOpenBuilding={onOpenBuilding}
                onSave={onSaveRelationship}
                onDelete={onDeleteRelationship}
                relationOptions={relationChoices}
              />
            ) : null}
            <ObjectActions
              saving={saving}
              deleting={deleting}
              onSave={onSave}
              onDelete={onDelete}
              onCancel={onCancelCreate}
              creating={creating}
            />
          </>
        ) : (
          <p className="empty-state">土地を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}

function BuildingWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  lands,
  selectedId,
  selected,
  draft,
  setDraft,
  creating,
  loading,
  saving,
  deleting,
  onRefresh,
  onSearch,
  onSelect,
  onCreate,
  onCancelCreate,
  onBackToList,
  onSave,
  onDelete,
  onOpenLand,
  onOpenParty,
  onSaveRelationship,
  onDeleteRelationship,
  onUseMapBounds,
  onUseSelectedFeature,
  onOpenSourceFeature,
  layers,
  parties,
  selectedFeature,
  selectedFeatureLayer,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Building[];
  lands: Land[];
  selectedId: string | null;
  selected: Building | null;
  draft: BuildingDraft;
  setDraft: React.Dispatch<React.SetStateAction<BuildingDraft>>;
  creating: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onBackToList: () => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  onOpenParty: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  onUseMapBounds: () => void;
  onUseSelectedFeature: () => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  layers: Layer[];
  parties: Party[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(businessStatusOptions, items.map((building) => building.status), draft.status);
  const buildingUseChoices = mergeChoiceOptions(buildingUseOptions, items.map((building) => building.buildingUse), draft.buildingUse);
  const structureChoices = mergeChoiceOptions(buildingStructureOptions, items.map((building) => building.structure), draft.structure);
  const rightTypeChoices = mergeChoiceOptions(rightTypeOptions, items.map((building) => building.rightType), draft.rightType);
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType));
  const relationChoices = relationshipTypeChoices(items, lands, parties);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="建物"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="building"
            filters={filters}
            setFilters={setFilters}
            open={filtersOpen}
            setOpen={setFiltersOpen}
            layers={layers}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            onUseMapBounds={onUseMapBounds}
            onUseSelectedFeature={onUseSelectedFeature}
            statusOptions={statusChoices}
            useOptions={buildingUseChoices}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <div className="business-table-scroll">
          <table className="business-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>土地</th>
                <th>用途/構造</th>
                <th>階数</th>
                <th>延床</th>
                <th>関係者</th>
                <th>GIS</th>
              </tr>
            </thead>
            <tbody>
              {items.map((building) => (
                <tr key={building.id} onClick={() => onSelect(building.id)}>
                  <td>{building.id}</td>
                  <td>
                    <strong>{building.name}</strong>
                    <span>{building.houseNumber ?? building.buildingLocation ?? ""}</span>
                  </td>
                  <td>{building.landLabel ?? "未設定"}</td>
                  <td>{[building.buildingUse, building.structure].filter(Boolean).join(" / ")}</td>
                  <td>{building.floors ?? ""}</td>
                  <td>{formatArea(building.totalFloorAreaSqm)}</td>
                  <td>{relationshipSummary(building.relationships)}</td>
                  <td>{gisLinkSummary(building.sourceLayerId, building.sourceFeatureId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length ? <p className="empty-state">建物はありません</p> : null}
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規建物" : selected?.id ?? ""}
              title={draft.name || "建物"}
              subtitle={selected?.landLabel ?? draft.buildingLocation}
              status={draft.status}
              href={selected ? `/buildings/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                土地ID
                <select value={draft.landId} onChange={(event) => setDraft((current) => ({ ...current, landId: event.target.value }))}>
                  <option value="">未設定</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.id} {land.lotNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                建物名
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                所在
                <input value={draft.buildingLocation} onChange={(event) => setDraft((current) => ({ ...current, buildingLocation: event.target.value }))} />
              </label>
              <label>
                家屋番号相当
                <input value={draft.houseNumber} onChange={(event) => setDraft((current) => ({ ...current, houseNumber: event.target.value }))} />
              </label>
              <label>
                用途
                <ChoiceSelect
                  value={draft.buildingUse}
                  onChange={(value) => setDraft((current) => ({ ...current, buildingUse: value }))}
                  options={buildingUseChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                構造
                <ChoiceSelect
                  value={draft.structure}
                  onChange={(value) => setDraft((current) => ({ ...current, structure: value }))}
                  options={structureChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                階数
                <input value={draft.floors} onChange={(event) => setDraft((current) => ({ ...current, floors: event.target.value }))} inputMode="numeric" />
              </label>
              <label>
                延床面積(m2)
                <input value={draft.totalFloorAreaSqm} onChange={(event) => setDraft((current) => ({ ...current, totalFloorAreaSqm: event.target.value }))} inputMode="decimal" />
              </label>
              <label>
                登記名義人
                <input value={draft.registeredOwner} onChange={(event) => setDraft((current) => ({ ...current, registeredOwner: event.target.value }))} />
              </label>
              <label>
                権利種別
                <ChoiceSelect
                  value={draft.rightType}
                  onChange={(value) => setDraft((current) => ({ ...current, rightType: value }))}
                  options={rightTypeChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                受付日
                <input type="date" value={draft.registrationAcceptedOn} onChange={(event) => setDraft((current) => ({ ...current, registrationAcceptedOn: event.target.value }))} />
              </label>
              <label>
                ステータス
                <ChoiceSelect
                  value={draft.status}
                  onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
                  options={statusChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                GISレイヤ
                <select value={draft.sourceLayerId} onChange={(event) => setDraft((current) => ({ ...current, sourceLayerId: event.target.value }))}>
                  <option value="">未設定</option>
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                GIS地物ID
                <input value={draft.sourceFeatureId} onChange={(event) => setDraft((current) => ({ ...current, sourceFeatureId: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
            <SourceLinkPanel layers={layers} layerId={draft.sourceLayerId} featureId={draft.sourceFeatureId} onOpen={onOpenSourceFeature} />
            {selected?.landId ? (
              <div className="object-related">
                <h3>土地</h3>
                <button type="button" onClick={() => selected.landId && onOpenLand(selected.landId)}>
                  <MapIcon size={15} />
                  <strong>{selected.landId}</strong>
                  <span>{selected.landLabel}</span>
                </button>
              </div>
            ) : null}
            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={parties}
                lands={lands}
                buildings={items}
                fixedTarget={{ targetType: "building", targetId: selected.id }}
                onOpenParty={onOpenParty}
                onOpenLand={onOpenLand}
                onOpenBuilding={() => undefined}
                onSave={onSaveRelationship}
                onDelete={onDeleteRelationship}
                relationOptions={relationChoices}
              />
            ) : null}
            <ObjectActions
              saving={saving}
              deleting={deleting}
              onSave={onSave}
              onDelete={onDelete}
              onCancel={onCancelCreate}
              creating={creating}
            />
          </>
        ) : (
          <p className="empty-state">建物を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}

function PartyWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  lands,
  buildings,
  selectedId,
  selected,
  draft,
  setDraft,
  creating,
  loading,
  saving,
  deleting,
  onRefresh,
  onSearch,
  onSelect,
  onCreate,
  onCancelCreate,
  onBackToList,
  onSave,
  onDelete,
  onOpenLand,
  onOpenBuilding,
  onSaveRelationship,
  onDeleteRelationship,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Party[];
  lands: Land[];
  buildings: Building[];
  selectedId: string | null;
  selected: Party | null;
  draft: PartyDraft;
  setDraft: React.Dispatch<React.SetStateAction<PartyDraft>>;
  creating: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onBackToList: () => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, items.map((party) => party.partyType), draft.partyType);
  const relationChoices = relationshipTypeChoices(items, lands, buildings);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="関係者"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="party"
            filters={filters}
            setFilters={setFilters}
            open={filtersOpen}
            setOpen={setFiltersOpen}
            layers={[]}
            selectedFeature={null}
            selectedFeatureLayer={null}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <div className="business-table-scroll">
          <table className="business-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>種別</th>
                <th>住所/連絡先</th>
                <th>関係数</th>
              </tr>
            </thead>
            <tbody>
              {items.map((party) => (
                <tr key={party.id} onClick={() => onSelect(party.id)}>
                  <td>{party.id}</td>
                  <td>{party.name}</td>
                  <td>{party.partyType}</td>
                  <td>
                    <strong>{party.address ?? ""}</strong>
                    <span>{party.contact ?? ""}</span>
                  </td>
                  <td>{party.relationships.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length ? <p className="empty-state">関係者はありません</p> : null}
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規関係者" : selected?.id ?? ""}
              title={draft.name || "関係者"}
              subtitle={draft.partyType}
              href={selected ? `/parties/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                名称
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                種別
                <ChoiceSelect
                  value={draft.partyType}
                  onChange={(value) => setDraft((current) => ({ ...current, partyType: value }))}
                  options={partyTypeChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                連絡先
                <input value={draft.contact} onChange={(event) => setDraft((current) => ({ ...current, contact: event.target.value }))} />
              </label>
              <label className="wide-field">
                住所
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label className="wide-field">
                タグ
                <input
                  value={draft.tags}
                  placeholder="例: 外国人、競合（読点またはカンマ区切り）"
                  onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={items}
                lands={lands}
                buildings={buildings}
                fixedPartyId={selected.id}
                onOpenParty={onSelect}
                onOpenLand={onOpenLand}
                onOpenBuilding={onOpenBuilding}
                onSave={onSaveRelationship}
                onDelete={onDeleteRelationship}
                relationOptions={relationChoices}
              />
            ) : null}
            <ObjectActions
              saving={saving}
              deleting={deleting}
              onSave={onSave}
              onDelete={onDelete}
              onCancel={onCancelCreate}
              creating={creating}
            />
          </>
        ) : (
          <p className="empty-state">関係者を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}

function ObjectSidebar({
  title,
  query,
  setQuery,
  loading,
  onRefresh,
  onSearch,
  onCreate,
  filterContent,
  selectedProject,
  projects,
  onProjectChange,
  children
}: {
  title: string;
  query: string;
  setQuery: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onCreate: () => void;
  filterContent?: React.ReactNode;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <aside className="object-sidebar">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Business Object</p>
          <h1>{title}</h1>
        </div>
        <div className="sidebar-actions">
          <button className="icon-button" type="button" onClick={onCreate} title="新規作成">
            <Plus size={18} />
          </button>
          <button className="icon-button" type="button" onClick={onRefresh} title="更新">
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
          </button>
        </div>
      </header>
      <label>
        プロジェクト
        <select value={selectedProject} onChange={(event) => onProjectChange(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="sidebar-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <label className="search-field">
          キーワード検索
          <span>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ID、所在地、地番、名称、関係者名"
            />
          </span>
        </label>
        <button className="command-button sidebar-search-button" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
          検索
        </button>
      </form>
      {filterContent}
      <div className="object-list">{children}</div>
    </aside>
  );
}

function BusinessFilterPanel({
  kind,
  filters,
  setFilters,
  open,
  setOpen,
  layers,
  selectedFeature,
  selectedFeatureLayer,
  onUseMapBounds,
  onUseSelectedFeature,
  statusOptions = businessStatusOptions,
  useOptions = [],
  partyTypeOptions: partyTypeChoices = partyTypeOptions,
  relationTypeOptions: relationChoices = relationTypeOptions
}: {
  kind: "land" | "building" | "party";
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  open: boolean;
  setOpen: (value: boolean) => void;
  layers: Layer[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  onUseMapBounds?: () => void;
  onUseSelectedFeature?: () => void;
  statusOptions?: string[];
  useOptions?: string[];
  partyTypeOptions?: string[];
  relationTypeOptions?: string[];
}) {
  const update = (key: keyof BusinessObjectFilters, value: string | boolean | undefined) => {
    setFilters((current) => ({ ...current, [key]: value === "" ? undefined : value }));
  };
  const resetSpatial = () => {
    setFilters((current) => ({
      ...current,
      bbox: undefined,
      intersectsLayerId: undefined,
      intersectsFeatureId: undefined,
      distanceMeters: undefined
    }));
  };
  const hasSpatialFilter = Boolean(filters.bbox || filters.intersectsLayerId || filters.intersectsFeatureId);
  return (
    <div className="business-filter-panel">
      <button className="subtle-button" type="button" onClick={() => setOpen(!open)}>
        <Search size={14} />
        {open ? "詳細条件を閉じる" : "詳細条件を表示"}
      </button>
      {open ? (
        <div className="business-filter-fields">
          {kind !== "party" ? (
            <>
              <label>
                ステータス
                <ChoiceSelect
                  value={filters.status ?? ""}
                  onChange={(value) => update("status", value)}
                  options={statusOptions}
                />
              </label>
              <label>
                {kind === "land" ? "地目/用途" : "用途"}
                <ChoiceSelect
                  value={kind === "land" ? filters.landUse ?? "" : filters.buildingUse ?? ""}
                  onChange={(value) => update(kind === "land" ? "landUse" : "buildingUse", value)}
                  options={useOptions}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                種別
                <ChoiceSelect
                  value={filters.partyType ?? ""}
                  onChange={(value) => update("partyType", value)}
                  options={partyTypeChoices}
                />
              </label>
              <label>
                対象
                <select value={filters.targetType ?? ""} onChange={(event) => update("targetType", event.target.value as BusinessObjectFilters["targetType"])}>
                  <option value="">土地/建物</option>
                  <option value="land">土地</option>
                  <option value="building">建物</option>
                </select>
              </label>
            </>
          )}
          {kind !== "party" ? (
            <label>
              関係者種別
              <ChoiceSelect
                value={filters.partyType ?? ""}
                onChange={(value) => update("partyType", value)}
                options={partyTypeChoices}
              />
            </label>
          ) : null}
          <label>
            関係種別
            <ChoiceSelect
              value={filters.relationType ?? ""}
              onChange={(value) => update("relationType", value)}
              options={relationChoices}
            />
          </label>
          <label className="checkbox-field filter-checkbox">
            <input
              type="checkbox"
              checked={filters.linkedOnly ?? false}
              onChange={(event) => update("linkedOnly", event.target.checked)}
            />
            <span>{kind === "party" ? "関係ありのみ" : "GISリンクありのみ"}</span>
          </label>
          {kind !== "party" ? (
            <>
              <label>
                GISレイヤ
                <select value={filters.sourceLayerId ?? ""} onChange={(event) => update("sourceLayerId", event.target.value)}>
                  <option value="">すべて</option>
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="filter-command-row">
                <button className="subtle-button" type="button" onClick={onUseMapBounds}>
                  <MapIcon size={14} />
                  表示範囲
                </button>
                <button className="subtle-button" type="button" onClick={onUseSelectedFeature}>
                  <Layers size={14} />
                  選択地物
                </button>
                {hasSpatialFilter ? (
                  <button className="icon-button" type="button" onClick={resetSpatial} title="空間条件を解除">
                    <X size={14} />
                  </button>
                ) : null}
              </div>
              <label>
                近接距離(m)
                <input
                  value={filters.distanceMeters ?? ""}
                  onChange={(event) => update("distanceMeters", event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <p className="filter-summary">
                {filters.bbox ? "表示範囲指定中" : "表示範囲なし"}
                {filters.intersectsFeatureId
                  ? ` / ${selectedFeatureLayer?.name ?? filters.intersectsLayerId} #${selectedFeature?.featureId ?? filters.intersectsFeatureId}`
                  : " / 選択地物なし"}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceLinkPanel({
  layers,
  layerId,
  featureId,
  onOpen
}: {
  layers: Layer[];
  layerId: string;
  featureId: string;
  onOpen: (layerId?: string | null, featureId?: string | null) => void;
}) {
  const layerName = layers.find((layer) => layer.id === layerId)?.name ?? layerId;
  const linked = Boolean(layerId && featureId);
  return (
    <div className="source-link-panel">
      <div>
        <h3>GISリンク</h3>
        <p>{linked ? `${layerName} #${featureId}` : "GIS地物は未設定です"}</p>
      </div>
      <button className="subtle-button" type="button" onClick={() => onOpen(layerId, featureId)} disabled={!linked}>
        <MapIcon size={15} />
        地図で表示
      </button>
    </div>
  );
}

function RelationshipEditor({
  relationships,
  parties,
  lands,
  buildings,
  fixedTarget,
  fixedPartyId,
  onOpenParty,
  onOpenLand,
  onOpenBuilding,
  onSave,
  onDelete,
  relationOptions = relationTypeOptions
}: {
  relationships: PartyRelationship[];
  parties: Party[];
  lands: Land[];
  buildings: Building[];
  fixedTarget?: { targetType: "land" | "building"; targetId: string };
  fixedPartyId?: string;
  onOpenParty: (id: string) => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onSave: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDelete: (relationshipId: string) => void;
  relationOptions?: string[];
}) {
  const fixedTargetType = fixedTarget?.targetType;
  const fixedTargetId = fixedTarget?.targetId;
  const defaultTargetType = fixedTargetType ?? "land";
  const defaultTargetId = fixedTargetId ?? lands[0]?.id ?? buildings[0]?.id ?? "";
  const defaultPartyId = fixedPartyId ?? parties[0]?.id ?? "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RelationshipDraft>({
    partyId: defaultPartyId,
    targetType: defaultTargetType,
    targetId: defaultTargetId,
    relationType: "",
    note: ""
  });

  useEffect(() => {
    if (editingId) return;
    setDraft((current) => ({
      ...current,
      partyId: fixedPartyId ?? (current.partyId || parties[0]?.id || ""),
      targetType: fixedTargetType ?? current.targetType,
      targetId: fixedTargetId ?? (current.targetId || lands[0]?.id || buildings[0]?.id || "")
    }));
  }, [buildings, editingId, fixedPartyId, fixedTargetId, fixedTargetType, lands, parties]);

  const targetOptions = draft.targetType === "land" ? lands : buildings;
  const startEdit = (relationship: PartyRelationship) => {
    setEditingId(relationship.id);
    setDraft({
      partyId: relationship.partyId,
      targetType: relationship.targetType,
      targetId: relationship.targetId,
      relationType: relationship.relationType,
      note: relationship.note ?? ""
    });
  };
  const resetDraft = () => {
    setEditingId(null);
    setDraft({
      partyId: defaultPartyId,
      targetType: defaultTargetType,
      targetId: defaultTargetId,
      relationType: "",
      note: ""
    });
  };
  const submit = () => {
    onSave(editingId, draft);
    resetDraft();
  };

  return (
    <div className="relationship-list">
      <div className="relationship-heading">
        <h3>関係</h3>
        {editingId ? (
          <button className="subtle-button" type="button" onClick={resetDraft}>
            <X size={14} />
            編集解除
          </button>
        ) : null}
      </div>
      <div className="relationship-edit-form">
        {!fixedPartyId ? (
          <label>
            関係者
            <select value={draft.partyId} onChange={(event) => setDraft((current) => ({ ...current, partyId: event.target.value }))}>
              <option value="">選択</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.id} {party.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {!fixedTarget ? (
          <>
            <label>
              対象
              <select
                value={draft.targetType}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    targetType: event.target.value as "land" | "building",
                    targetId: event.target.value === "land" ? lands[0]?.id ?? "" : buildings[0]?.id ?? ""
                  }))
                }
              >
                <option value="land">土地</option>
                <option value="building">建物</option>
              </select>
            </label>
            <label>
              対象ID
              <select value={draft.targetId} onChange={(event) => setDraft((current) => ({ ...current, targetId: event.target.value }))}>
                <option value="">選択</option>
                {targetOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} {"lotNumber" in item ? item.lotNumber : item.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label>
          関係種別
          <ChoiceSelect
            value={draft.relationType}
            onChange={(value) => setDraft((current) => ({ ...current, relationType: value }))}
            options={mergeChoiceOptions(relationOptions, relationships.map((relationship) => relationship.relationType))}
            emptyLabel="選択"
          />
        </label>
        <label>
          備考
          <input value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
        </label>
        <button className="command-button" type="button" onClick={submit}>
          <Save size={14} />
          {editingId ? "更新" : "追加"}
        </button>
      </div>
      {relationships.map((relationship) => {
        return (
          <div className="relationship-row editable" key={relationship.id}>
            <span>{relationship.relationType}</span>
            <button type="button" onClick={() => onOpenParty(relationship.partyId)}>
              {relationship.partyName ?? relationship.partyId}
            </button>
            <button
              type="button"
              onClick={() =>
                relationship.targetType === "land" ? onOpenLand(relationship.targetId) : onOpenBuilding(relationship.targetId)
              }
            >
              {relationship.targetId}
              {relationship.targetLabel ? ` · ${relationship.targetLabel}` : ""}
            </button>
            {relationship.note ? <em>{relationship.note}</em> : null}
            <div className="relationship-actions">
              <button className="icon-button" type="button" onClick={() => startEdit(relationship)} title="編集">
                <Pencil size={14} />
              </button>
              <button className="icon-button" type="button" onClick={() => onDelete(relationship.id)} title="削除">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
      {!relationships.length ? <p className="empty-state compact">関係はありません</p> : null}
    </div>
  );
}

function ObjectDetailHeader({
  id,
  title,
  subtitle,
  status,
  href,
  onBack
}: {
  id: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  href?: string;
  onBack?: () => void;
}) {
  return (
    <header className="object-detail-header">
      <div className="object-title-group">
        {onBack ? (
          <button className="subtle-button object-back-button" type="button" onClick={onBack}>
            <ArrowLeft size={15} />
            一覧へ戻る
          </button>
        ) : null}
        <div>
          <p className="eyebrow">{id}</p>
          <h1>{title}</h1>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
      </div>
      <div className="object-header-actions">
        {status ? <strong>{status}</strong> : null}
        {href ? (
          <a className="icon-button" href={href} target="_blank" rel="noreferrer" title="別タブで開く">
            <ExternalLink size={16} />
          </a>
        ) : null}
      </div>
    </header>
  );
}

function RelationshipList({ relationships }: { relationships: PartyRelationship[] }) {
  return (
    <div className="relationship-list">
      <h3>関係</h3>
      {relationships.map((relationship) => {
        const targetHref =
          relationship.targetType === "land"
            ? `/lands/${encodeURIComponent(relationship.targetId)}`
            : `/buildings/${encodeURIComponent(relationship.targetId)}`;
        return (
          <div className="relationship-row" key={relationship.id}>
            <span>{relationship.relationType}</span>
            <a href={`/parties/${encodeURIComponent(relationship.partyId)}`} target="_blank" rel="noreferrer">
              {relationship.partyName ?? relationship.partyId}
            </a>
            <a href={targetHref} target="_blank" rel="noreferrer">
              {relationship.targetId}
              {relationship.targetLabel ? ` · ${relationship.targetLabel}` : ""}
            </a>
            {relationship.note ? <em>{relationship.note}</em> : null}
          </div>
        );
      })}
      {!relationships.length ? <p className="empty-state compact">関係はありません</p> : null}
    </div>
  );
}

function ObjectActions({
  saving,
  deleting,
  onSave,
  onDelete,
  onCancel,
  creating = false
}: {
  saving: boolean;
  deleting: boolean;
  onSave: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
  creating?: boolean;
}) {
  return (
    <div className="object-actions">
      {creating && onCancel ? (
        <button className="subtle-button" type="button" onClick={onCancel} disabled={saving}>
          <X size={15} />
          キャンセル
        </button>
      ) : null}
      {!creating && onDelete ? (
        <button className="danger-button" type="button" onClick={onDelete} disabled={deleting || saving}>
          {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
          削除
        </button>
      ) : null}
      <button className="command-button" type="button" onClick={onSave} disabled={saving || deleting}>
        {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
        {creating ? "作成" : "保存"}
      </button>
    </div>
  );
}

function addMapLayers(map: MapLibreMap, layer: Layer, color: string): string[] {
  const sourceLayer = layer.tileSourceId;
  const source = layer.id;
  const geometryType = layer.geometryType.toUpperCase();
  const isZone = layer.layerRole === "zone";
  const ids: string[] = [];

  if (geometryType.includes("POLYGON") || geometryType === "GEOMETRY") {
    const fillId = `${layer.id}-fill`;
    const outlineId = `${layer.id}-outline`;
    map.addLayer({
      id: fillId,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": isZone ? "#38bdf8" : color, "fill-opacity": isZone ? 0.18 : 0.32 }
    } as maplibregl.FillLayerSpecification);
    map.addLayer({
      id: outlineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "line-color": isZone ? "#0369a1" : color, "line-width": isZone ? 2.2 : 1.2 }
    } as maplibregl.LineLayerSpecification);
    ids.push(fillId, outlineId);
  }

  if (geometryType.includes("LINE") || geometryType === "GEOMETRY") {
    const lineId = `${layer.id}-line`;
    map.addLayer({
      id: lineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "LineString"],
      paint: { "line-color": color, "line-width": 2.2 }
    } as maplibregl.LineLayerSpecification);
    ids.push(lineId);
  }

  if (geometryType.includes("POINT") || geometryType === "GEOMETRY") {
    const pointId = `${layer.id}-point`;
    map.addLayer({
      id: pointId,
      type: "circle",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5
      }
    } as maplibregl.CircleLayerSpecification);
    ids.push(pointId);
  }

  return ids;
}

function syncConditionSearchHighlight(map: MapLibreMap, results: FeatureSearchResult[]) {
  const sourceId = "condition-search-highlight";
  const emptyCollection = { type: "FeatureCollection", features: [] } as any;
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "geojson",
      data: emptyCollection
    });
  }
  if (!map.getLayer(`${sourceId}-fill`)) {
    map.addLayer({
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": "#facc15", "fill-opacity": 0.5 }
    } as maplibregl.FillLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-line-halo`)) {
    map.addLayer({
      id: `${sourceId}-line-halo`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.95,
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 7, 12, 9, 16, 12]
      }
    } as maplibregl.LineLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-line`)) {
    map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#e11d48",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 6, 16, 8]
      }
    } as maplibregl.LineLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-point`)) {
    map.addLayer({
      id: `${sourceId}-point`,
      type: "circle",
      source: sourceId,
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-color": "#e11d48",
        "circle-radius": 7,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2
      }
    } as maplibregl.CircleLayerSpecification);
  }

  const features = results
    .filter((result) => result.geometry)
    .map((result) => ({
      type: "Feature",
      geometry: result.geometry,
      properties: {
        layerId: result.layerId,
        featureId: result.featureId
      }
    }));
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  source?.setData({ type: "FeatureCollection", features } as any);
  [
    `${sourceId}-fill`,
    `${sourceId}-line-halo`,
    `${sourceId}-line`,
    `${sourceId}-point`
  ].forEach((layerId) => {
    if (map.getLayer(layerId)) map.moveLayer(layerId);
  });
}

function toAttributePayload(condition: AttributeConditionDraft) {
  if (condition.operator === "IS NULL") {
    return {
      layerId: condition.layerId,
      field: condition.field,
      operator: condition.operator
    };
  }
  if (condition.operator === "IN") {
    return {
      layerId: condition.layerId,
      field: condition.field,
      operator: condition.operator,
      values: condition.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    };
  }
  return {
    layerId: condition.layerId,
    field: condition.field,
    operator: condition.operator,
    value: parseDraftValue(condition.value)
  };
}

function toConditionAttributePayload(condition: AttributeConditionDraft): ConditionQueryCondition {
  const payload = toAttributePayload(condition);
  return {
    type: "attribute",
    ...payload
  };
}

function conditionResultName(name: string, query: ConditionQuery): string {
  const explicitName = name.trim();
  if (explicitName) return explicitName;
  const keyword = query.keyword?.trim();
  return keyword ? `条件検索結果: ${keyword}` : "条件検索結果";
}

function readZoneDistance(operator: string, value: string): number | undefined {
  if (operator !== "dwithin") return undefined;
  const distance = Number(value.trim());
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error("指定距離は正の数値で入力してください");
  }
  return distance;
}

function parseDraftValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

function parseEditedProperty(value: string, originalValue: unknown, fieldName: string): unknown {
  const trimmed = value.trim();
  if (originalValue === null || originalValue === undefined) {
    return trimmed ? parseDraftValue(value) : null;
  }
  if (typeof originalValue === "number") {
    if (!trimmed) return null;
    const next = Number(trimmed);
    if (!Number.isFinite(next)) throw new Error(`${fieldName} は数値で入力してください`);
    return next;
  }
  if (typeof originalValue === "boolean") {
    if (trimmed.toLowerCase() === "true") return true;
    if (trimmed.toLowerCase() === "false") return false;
    throw new Error(`${fieldName} は true または false で入力してください`);
  }
  if (typeof originalValue === "object") {
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }
  return value;
}

function moveLayerBefore(layers: Layer[], sourceLayerId: string, targetLayerId: string): Layer[] {
  const sourceIndex = layers.findIndex((layer) => layer.id === sourceLayerId);
  const targetIndex = layers.findIndex((layer) => layer.id === targetLayerId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layers;

  const next = [...layers];
  const [sourceLayer] = next.splice(sourceIndex, 1);
  const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(insertIndex, 0, sourceLayer);
  return next;
}

function orderLayers(layers: Layer[], layerOrder: string[] | undefined): Layer[] {
  if (!layerOrder?.length) return layers;
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const orderedLayers: Layer[] = [];
  const usedLayerIds = new Set<string>();

  for (const layerId of layerOrder) {
    const layer = layerById.get(layerId);
    if (!layer) continue;
    orderedLayers.push(layer);
    usedLayerIds.add(layerId);
  }

  return [...orderedLayers, ...layers.filter((layer) => !usedLayerIds.has(layer.id))];
}

function groupLayerListItems(layers: Layer[]): LayerListItem[] {
  const items: LayerListItem[] = [];
  const resultSetItems = new Map<string, Extract<LayerListItem, { type: "resultSet" }>>();
  for (const layer of layers) {
    if (layer.resultSetId) {
      const existing = resultSetItems.get(layer.resultSetId);
      if (existing) {
        existing.layers.push(layer);
      } else {
        const item: Extract<LayerListItem, { type: "resultSet" }> = {
          type: "resultSet",
          id: layer.resultSetId,
          name: layer.resultSetName ?? "条件検索結果",
          layers: [layer]
        };
        resultSetItems.set(layer.resultSetId, item);
        items.push(item);
      }
      continue;
    }
    items.push({ type: "layer", layer });
  }
  return items;
}

function restoreVisibleLayerIds(
  layers: Layer[],
  savedViewState: Partial<LayerViewState> | null,
  previousLayerIds: Set<string>,
  currentVisibleLayerIds: Set<string>
): Set<string> {
  if (savedViewState?.visibleLayerIds) {
    const savedVisibleLayerIds = new Set(savedViewState.visibleLayerIds);
    const savedKnownLayerIds = new Set(savedViewState.layerOrder ?? []);
    return new Set(
      layers
        .filter((layer) => savedVisibleLayerIds.has(layer.id) || !savedKnownLayerIds.has(layer.id))
        .map((layer) => layer.id)
    );
  }

  if (previousLayerIds.size || currentVisibleLayerIds.size) {
    const next = new Set(layers.filter((layer) => currentVisibleLayerIds.has(layer.id)).map((layer) => layer.id));
    for (const layer of layers) {
      if (!previousLayerIds.has(layer.id)) next.add(layer.id);
    }
    return next;
  }

  return new Set(layers.map((layer) => layer.id));
}

function syncMapLayerOrder(
  map: MapLibreMap,
  layers: Layer[],
  styleLayerIdsByLayerId: Record<string, string[]>
) {
  for (const layer of [...layers].reverse()) {
    for (const styleLayerId of styleLayerIdsByLayerId[layer.id] ?? []) {
      if (map.getLayer(styleLayerId)) {
        map.moveLayer(styleLayerId);
      }
    }
  }
}

function readLayerViewState(projectId: string): Partial<LayerViewState> | null {
  try {
    const rawState = window.localStorage.getItem(layerViewStateStoragePrefix + projectId);
    if (!rawState) return null;
    const parsed = JSON.parse(rawState) as Partial<LayerViewState>;
    return {
      baseMapVisible: typeof parsed.baseMapVisible === "boolean" ? parsed.baseMapVisible : undefined,
      visibleLayerIds: Array.isArray(parsed.visibleLayerIds) ? parsed.visibleLayerIds.filter(isString) : undefined,
      layerOrder: Array.isArray(parsed.layerOrder) ? parsed.layerOrder.filter(isString) : undefined
    };
  } catch {
    return null;
  }
}

function writeLayerViewState(projectId: string, state: LayerViewState) {
  try {
    window.localStorage.setItem(layerViewStateStoragePrefix + projectId, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in private or restricted browser contexts.
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function upsertJob<T extends { id: string }>(jobs: T[], next: T): T[] {
  const filtered = jobs.filter((job) => job.id !== next.id);
  return [next, ...filtered];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatArea(value?: number | null): string {
  return value === null || value === undefined ? "" : value.toLocaleString();
}

function relationshipSummary(relationships: PartyRelationship[]): string {
  if (!relationships.length) return "";
  return relationships
    .slice(0, 2)
    .map((relationship) => `${relationship.relationType}:${relationship.partyName ?? relationship.partyId}`)
    .join(" / ");
}

function gisLinkSummary(layerId?: string | null, featureId?: string | null): string {
  return layerId && featureId ? "あり" : "";
}

function zoneLayerSummary(layers: Layer[], layerId?: string | null, featureId?: string | null): string {
  if (!layerId || !featureId) return "";
  const layer = layers.find((item) => item.id === layerId);
  return `${layer?.name ?? "区域レイヤ"} · ID ${featureId}`;
}

function zoneLayerIdOf(zone: Zone): string {
  return zone.zoneLayerId ?? zone.sourceLayerId ?? "";
}

function zoneFeatureIdOf(zone: Zone): string {
  return zone.zoneFeatureId ?? zone.sourceFeatureId ?? "";
}

async function buildBusinessMapTargets({
  tab,
  zones,
  lands,
  buildings,
  parties,
  layerById
}: BusinessMapTargetContext): Promise<BusinessMapTarget[]> {
  if (tab === "zone") {
    const includeContained = zones.length === 1;
    const groups = await Promise.all(zones.map((zone) => zoneToBusinessMapTargets(zone, layerById, includeContained)));
    return groups.flat();
  }
  if (tab === "lands") {
    return lands.flatMap((land) => landToBusinessMapTarget(land, layerById) ?? []);
  }
  if (tab === "buildings") {
    return buildings.flatMap((building) => buildingToBusinessMapTarget(building, layerById) ?? []);
  }
  return partyBusinessMapTargets(parties, lands, buildings, layerById);
}

async function zoneToBusinessMapTargets(zone: Zone, layerById: Map<string, Layer>, includeContained: boolean): Promise<BusinessMapTarget[]> {
  const zoneLayerId = zoneLayerIdOf(zone);
  const zoneFeatureId = zoneFeatureIdOf(zone);
  if (!zoneLayerId || !zoneFeatureId) return [];
  const targets: BusinessMapTarget[] = [{
    layerId: zoneLayerId,
    layerName: sourceLayerName(layerById, zoneLayerId, "区域"),
    featureId: zoneFeatureId,
    matchSummary: `区域 ${zone.id} · ${zone.name}`,
    businessLinks: {
      lands: zone.lands ?? [],
      buildings: zone.buildings ?? []
    },
    matchedBusinessLinks: emptyBusinessLinks
  }];
  if (!includeContained) return targets;

  const landTargets = await Promise.all(
    (zone.lands ?? []).map(async (link) => {
      const land = await getLandForMap(link.id);
      return land ? landToBusinessMapTarget(land, layerById, "区域内の土地", { lands: [link], buildings: [] }) : null;
    })
  );
  const buildingTargets = await Promise.all(
    (zone.buildings ?? []).map(async (link) => {
      const building = await getBuildingForMap(link.id);
      return building ? buildingToBusinessMapTarget(building, layerById, "区域内の建物", { lands: [], buildings: [link] }) : null;
    })
  );
  return [...targets, ...landTargets, ...buildingTargets].filter((target): target is BusinessMapTarget => Boolean(target));
}

function landToBusinessMapTarget(
  land: Land,
  layerById: Map<string, Layer>,
  matchSummary = `土地 ${land.id} · ${landMapLabel(land)}`,
  matchedBusinessLinks?: BusinessLinks
): BusinessMapTarget | null {
  if (!land.sourceLayerId || !land.sourceFeatureId) return null;
  const landLink = { id: land.id, label: landMapLabel(land) };
  return {
    layerId: land.sourceLayerId,
    layerName: sourceLayerName(layerById, land.sourceLayerId, "土地"),
    featureId: land.sourceFeatureId,
    matchSummary,
    businessLinks: {
      lands: [landLink],
      buildings: land.buildings
    },
    matchedBusinessLinks: matchedBusinessLinks ?? {
      lands: [landLink],
      buildings: []
    }
  };
}

function buildingToBusinessMapTarget(
  building: Building,
  layerById: Map<string, Layer>,
  matchSummary = `建物 ${building.id} · ${buildingMapLabel(building)}`,
  matchedBusinessLinks?: BusinessLinks
): BusinessMapTarget | null {
  if (!building.sourceLayerId || !building.sourceFeatureId) return null;
  const buildingLink = { id: building.id, label: buildingMapLabel(building) };
  return {
    layerId: building.sourceLayerId,
    layerName: sourceLayerName(layerById, building.sourceLayerId, "建物"),
    featureId: building.sourceFeatureId,
    matchSummary,
    businessLinks: {
      lands: building.landId ? [{ id: building.landId, label: building.landLabel ?? building.landId }] : [],
      buildings: [buildingLink]
    },
    matchedBusinessLinks: matchedBusinessLinks ?? {
      lands: [],
      buildings: [buildingLink]
    }
  };
}

async function partyBusinessMapTargets(
  parties: Party[],
  lands: Land[],
  buildings: Building[],
  layerById: Map<string, Layer>
): Promise<BusinessMapTarget[]> {
  const landById = new Map(lands.map((land) => [land.id, land]));
  const buildingById = new Map(buildings.map((building) => [building.id, building]));
  const relationships = parties
    .flatMap((party) => party.relationships.map((relationship) => ({ party, relationship })))
    .slice(0, businessMapHighlightLimit * 2);
  const targets = await Promise.all(
    relationships.map(async ({ party, relationship }) => {
      const matchSummary = `${party.name} · ${relationship.relationType}`;
      if (relationship.targetType === "land") {
        const land = landById.get(relationship.targetId) ?? (await getLandForMap(relationship.targetId));
        if (!land) return null;
        return landToBusinessMapTarget(land, layerById, matchSummary, {
          lands: [{ id: land.id, label: relationship.targetLabel ?? landMapLabel(land) }],
          buildings: []
        });
      }
      const building = buildingById.get(relationship.targetId) ?? (await getBuildingForMap(relationship.targetId));
      if (!building) return null;
      return buildingToBusinessMapTarget(building, layerById, matchSummary, {
        lands: [],
        buildings: [{ id: building.id, label: relationship.targetLabel ?? buildingMapLabel(building) }]
      });
    })
  );
  return targets.filter((target): target is BusinessMapTarget => Boolean(target));
}

async function getLandForMap(id: string): Promise<Land | null> {
  try {
    return await getLand(id);
  } catch {
    return null;
  }
}

async function getBuildingForMap(id: string): Promise<Building | null> {
  try {
    return await getBuilding(id);
  } catch {
    return null;
  }
}

function uniqueBusinessMapTargets(targets: BusinessMapTarget[]): BusinessMapTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.layerId}:${target.featureId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLayerName(layerById: Map<string, Layer>, layerId: string, fallback: string): string {
  return layerById.get(layerId)?.name ?? fallback;
}

function landMapLabel(land: Land): string {
  return [land.lotNumber, land.address].filter(Boolean).join(" · ") || land.id;
}

function buildingMapLabel(building: Building): string {
  return building.name || building.houseNumber || building.buildingLocation || building.id;
}

function featureResultSummary(result: FeatureSearchResult): string {
  const entries = Object.entries(result.properties)
    .filter(([, value]) => value !== null && value !== undefined && formatValue(value) !== "")
    .slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join(" · ") || "属性なし";
}

function businessLinksSummary(links: BusinessLinks): string {
  const parts = [];
  if (links.lands.length) parts.push(`土地 ${links.lands.length}`);
  if (links.buildings.length) parts.push(`建物 ${links.buildings.length}`);
  return parts.length ? parts.join(" / ") : "業務リンクなし";
}

function featureResultBusinessSummary(result: FeatureSearchResult): string {
  const matchedLinks = result.matchedBusinessLinks ?? emptyBusinessLinks;
  if (matchedLinks.lands.length || matchedLinks.buildings.length) {
    return `一致: ${businessLinksSummary(matchedLinks)}`;
  }
  return businessLinksSummary(result.businessLinks ?? emptyBusinessLinks);
}

function groupFeatureResults(results: FeatureSearchResult[]) {
  const groups = new Map<string, { layerId: string; layerName: string; results: FeatureSearchResult[] }>();
  for (const result of results) {
    const existing = groups.get(result.layerId);
    if (existing) {
      existing.results.push(result);
    } else {
      groups.set(result.layerId, {
        layerId: result.layerId,
        layerName: result.layerName,
        results: [result]
      });
    }
  }
  return [...groups.values()];
}

function mergeChoiceOptions(
  defaults: string[],
  ...sources: Array<string | null | undefined | Array<string | null | undefined>>
): string[] {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) values.add(trimmed);
  };
  defaults.forEach(add);
  sources.forEach((source) => {
    if (Array.isArray(source)) {
      source.forEach(add);
    } else {
      add(source);
    }
  });
  return [...values];
}

function attributeValueOptionKey(layerId: string, field: string): string {
  return `${layerId}\u001f${field}`;
}

function relationshipTypeChoices(...groups: Array<Array<{ relationships: PartyRelationship[] }>>): string[] {
  return mergeChoiceOptions(
    relationTypeOptions,
    groups.flatMap((group) => group.flatMap((item) => item.relationships.map((relationship) => relationship.relationType)))
  );
}

function formatEditorValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function editableFeatureAttributes(layer: Layer) {
  return layer.attributes.filter((attribute) => attribute.name !== layer.featureIdColumn && attribute.name !== layer.geometryColumn);
}

function defaultZoneSpatialLayerIds(layers: Layer[]): string[] {
  const polygonLayerIds = layers.filter(isPolygonLayer).map((layer) => layer.id);
  if (polygonLayerIds.length) return polygonLayerIds;
  return layers[0] ? [layers[0].id] : [];
}

function isPolygonLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("POLYGON");
}

function isZoneLayer(layer: Layer): boolean {
  return layer.layerRole === "zone";
}

function zoneLayerOptions(layers: Layer[]): Layer[] {
  const zoneLayers = layers.filter(isZoneLayer);
  return zoneLayers.length ? zoneLayers : layers.filter(isZoneSourceLayer);
}

function isZoneSourceLayer(layer: Layer): boolean {
  const geometryType = layer.geometryType.toUpperCase();
  return geometryType.includes("POLYGON") || geometryType === "GEOMETRY";
}

function canUseSelectedFeatureAsZoneFeature(feature: Feature, layer: Layer): boolean {
  return isZoneLayer(layer) && isPolygonGeometry(feature.geometry);
}

function isPointLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("POINT");
}

function isPolygonGeometry(geometry: unknown): boolean {
  return isRecord(geometry) && typeof geometry.type === "string" && geometry.type.toUpperCase().includes("POLYGON");
}

function isLineLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("LINE");
}

type GeometryBounds = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

function focusGeometry(map: MapLibreMap | null, geometry: unknown) {
  if (!map) return;
  const bounds = geoJsonGeometryBounds(geometry);
  if (!bounds) return;
  const southWest: [number, number] = [bounds.minLng, bounds.minLat];
  const northEast: [number, number] = [bounds.maxLng, bounds.maxLat];
  if (bounds.minLng === bounds.maxLng && bounds.minLat === bounds.maxLat) {
    map.flyTo({ center: southWest, zoom: Math.max(map.getZoom(), 16), duration: 500 });
    return;
  }
  map.fitBounds([southWest, northEast], { padding: 72, duration: 500, maxZoom: 17 });
}

function focusFeatureResults(map: MapLibreMap | null, results: FeatureSearchResult[]) {
  if (!map) return;
  const bounds: GeometryBounds = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY
  };
  for (const result of results) {
    const geometryBounds = geoJsonGeometryBounds(result.geometry);
    if (!geometryBounds) continue;
    extendBounds(bounds, geometryBounds.minLng, geometryBounds.minLat);
    extendBounds(bounds, geometryBounds.maxLng, geometryBounds.maxLat);
  }
  if (!Number.isFinite(bounds.minLng) || !Number.isFinite(bounds.minLat)) return;
  const southWest: [number, number] = [bounds.minLng, bounds.minLat];
  const northEast: [number, number] = [bounds.maxLng, bounds.maxLat];
  if (bounds.minLng === bounds.maxLng && bounds.minLat === bounds.maxLat) {
    map.flyTo({ center: southWest, zoom: Math.max(map.getZoom(), 16), duration: 500 });
    return;
  }
  map.fitBounds([southWest, northEast], { padding: 72, duration: 500, maxZoom: 17 });
}

function geoJsonGeometryBounds(geometry: unknown): GeometryBounds | null {
  if (!isRecord(geometry)) return null;
  const bounds: GeometryBounds = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY
  };

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const childBounds = geoJsonGeometryBounds(child);
      if (childBounds) {
        extendBounds(bounds, childBounds.minLng, childBounds.minLat);
        extendBounds(bounds, childBounds.maxLng, childBounds.maxLat);
      }
    }
  } else {
    extendBoundsFromCoordinates(bounds, geometry.coordinates);
  }

  if (!Number.isFinite(bounds.minLng) || !Number.isFinite(bounds.minLat)) return null;
  return bounds;
}

function extendBoundsFromCoordinates(bounds: GeometryBounds, value: unknown) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    extendBounds(bounds, value[0], value[1]);
    return;
  }
  for (const item of value) {
    extendBoundsFromCoordinates(bounds, item);
  }
}

function extendBounds(bounds: GeometryBounds, lng: number, lat: number) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  bounds.minLng = Math.min(bounds.minLng, lng);
  bounds.minLat = Math.min(bounds.minLat, lat);
  bounds.maxLng = Math.max(bounds.maxLng, lng);
  bounds.maxLat = Math.max(bounds.maxLat, lat);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRoute(pathname: string): RouteSelection {
  const [segment, rawId] = pathname.split("/").filter(Boolean);
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (segment === "zones") return { tab: "zone", id };
  if (segment === "lands") return { tab: "lands", id };
  if (segment === "buildings") return { tab: "buildings", id };
  if (segment === "parties") return { tab: "parties", id };
  return { tab: "zone", id: null };
}

function tabPath(tab: BusinessTab): string {
  if (tab === "zone") return "/zones";
  if (tab === "lands") return "/lands";
  if (tab === "buildings") return "/buildings";
  if (tab === "parties") return "/parties";
  return "/zones";
}

function emptyZoneDraft(): ZoneDraft {
  return {
    id: "",
    name: "",
    zoneType: "",
    status: "",
    memo: "",
    zoneLayerId: "",
    zoneFeatureId: ""
  };
}

function emptyLandDraft(): LandDraft {
  return {
    id: "",
    lotNumber: "",
    address: "",
    landUse: "",
    areaSqm: "",
    registeredOwner: "",
    rightType: "",
    registrationCause: "",
    registrationAcceptedOn: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

function emptyBuildingDraft(): BuildingDraft {
  return {
    id: "",
    landId: "",
    name: "",
    buildingLocation: "",
    houseNumber: "",
    buildingUse: "",
    floors: "",
    totalFloorAreaSqm: "",
    structure: "",
    registeredOwner: "",
    rightType: "",
    registrationAcceptedOn: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

function emptyPartyDraft(): PartyDraft {
  return {
    id: "",
    name: "",
    partyType: "",
    contact: "",
    address: "",
    memo: "",
    tags: ""
  };
}

function parsePartyTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,、]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    )
  );
}

function newLandDraft(): LandDraft {
  return { ...emptyLandDraft(), status: "調査中" };
}

function newBuildingDraft(): BuildingDraft {
  return { ...emptyBuildingDraft(), status: "調査中" };
}

function newPartyDraft(): PartyDraft {
  return { ...emptyPartyDraft(), partyType: "法人" };
}

function newZoneDraft(selectedFeature?: Feature | null, selectedFeatureLayer?: Layer | null, fallbackLayer?: Layer): ZoneDraft {
  const useSelectedFeature = Boolean(
    selectedFeature && selectedFeatureLayer && canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)
  );
  const zoneLayerId = useSelectedFeature && selectedFeatureLayer ? selectedFeatureLayer.id : fallbackLayer?.id ?? "";
  const zoneFeatureId = useSelectedFeature && selectedFeature ? selectedFeature.featureId : "";
  return {
    ...emptyZoneDraft(),
    status: "有効",
    zoneLayerId,
    zoneFeatureId
  };
}

function toZoneDraft(zone: Zone): ZoneDraft {
  return {
    id: zone.id,
    name: zone.name,
    zoneType: zone.zoneType ?? "",
    status: zone.status,
    memo: zone.memo ?? "",
    zoneLayerId: zoneLayerIdOf(zone),
    zoneFeatureId: zoneFeatureIdOf(zone)
  };
}

function toLandDraft(land: Land): LandDraft {
  return {
    id: land.id,
    lotNumber: land.lotNumber,
    address: land.address,
    landUse: land.landUse ?? "",
    areaSqm: land.areaSqm === null || land.areaSqm === undefined ? "" : String(land.areaSqm),
    registeredOwner: land.registeredOwner ?? "",
    rightType: land.rightType ?? "",
    registrationCause: land.registrationCause ?? "",
    registrationAcceptedOn: land.registrationAcceptedOn ?? "",
    status: land.status,
    memo: land.memo ?? "",
    sourceLayerId: land.sourceLayerId ?? "",
    sourceFeatureId: land.sourceFeatureId ?? ""
  };
}

function toBuildingDraft(building: Building): BuildingDraft {
  return {
    id: building.id,
    landId: building.landId ?? "",
    name: building.name,
    buildingLocation: building.buildingLocation ?? "",
    houseNumber: building.houseNumber ?? "",
    buildingUse: building.buildingUse ?? "",
    floors: building.floors === null || building.floors === undefined ? "" : String(building.floors),
    totalFloorAreaSqm:
      building.totalFloorAreaSqm === null || building.totalFloorAreaSqm === undefined ? "" : String(building.totalFloorAreaSqm),
    structure: building.structure ?? "",
    registeredOwner: building.registeredOwner ?? "",
    rightType: building.rightType ?? "",
    registrationAcceptedOn: building.registrationAcceptedOn ?? "",
    status: building.status,
    memo: building.memo ?? "",
    sourceLayerId: building.sourceLayerId ?? "",
    sourceFeatureId: building.sourceFeatureId ?? ""
  };
}

function toPartyDraft(party: Party): PartyDraft {
  return {
    id: party.id,
    name: party.name,
    partyType: party.partyType,
    contact: party.contact ?? "",
    address: party.address ?? "",
    memo: party.memo ?? "",
    tags: (party.tags ?? []).join("、")
  };
}

function nullableString(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

function nullableNumber(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const next = Number(trimmed);
  if (!Number.isFinite(next)) throw new Error(`${label} は数値で入力してください`);
  return next;
}

function nullableInteger(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const next = Number(trimmed);
  if (!Number.isInteger(next)) throw new Error(`${label} は整数で入力してください`);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
