import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import maplibregl, { type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import {
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
  createImportJob,
  conditionSearchFeatures,
  deleteBuilding,
  deleteLand,
  deleteParty,
  getAnalysisJob,
  getBuilding,
  getBuildings,
  getBusinessLinks,
  getFeature,
  getImportJob,
  getLand,
  getLands,
  getLayers,
  getParties,
  getParty,
  getProjects,
  updateBuilding,
  updateFeature,
  updateLand,
  updateParty
} from "./api";
import type {
  AnalysisJob,
  AttributeConditionDraft,
  Building,
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
  SpatialConditionDraft
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
  lotNumber: string;
  address: string;
  landUse: string;
  areaSqm: string;
  status: string;
  memo: string;
  sourceLayerId: string;
  sourceFeatureId: string;
};

type BuildingDraft = {
  landId: string;
  name: string;
  buildingUse: string;
  floors: string;
  totalFloorAreaSqm: string;
  structure: string;
  status: string;
  memo: string;
  sourceLayerId: string;
  sourceFeatureId: string;
};

type PartyDraft = {
  name: string;
  partyType: string;
  contact: string;
  address: string;
  memo: string;
};

const emptyBusinessLinks: BusinessLinks = { lands: [], buildings: [] };

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
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
  const [selectedFeatureLayer, setSelectedFeatureLayer] = useState<Layer | null>(null);
  const [businessLinks, setBusinessLinks] = useState<BusinessLinks>(emptyBusinessLinks);
  const [loadingBusinessLinks, setLoadingBusinessLinks] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingLayers, setLoadingLayers] = useState(false);
  const [zoneSearchQuery, setZoneSearchQuery] = useState("");
  const [zoneSearchLinkedOnly, setZoneSearchLinkedOnly] = useState(false);
  const [zoneSpatialLayerIds, setZoneSpatialLayerIds] = useState<string[]>([]);
  const [zoneBusinessSourceType, setZoneBusinessSourceType] = useState<ZoneBusinessSourceType>("all");
  const [zoneBusinessQuery, setZoneBusinessQuery] = useState("");
  const [zonePartyQuery, setZonePartyQuery] = useState("");
  const [zonePartyType, setZonePartyType] = useState("");
  const [zoneRelationType, setZoneRelationType] = useState("");
  const [zoneSearchResults, setZoneSearchResults] = useState<FeatureSearchResult[]>([]);
  const [loadingZoneSearch, setLoadingZoneSearch] = useState(false);
  const [conditionBuilderOpen, setConditionBuilderOpen] = useState(false);
  const [savingConditionSearch, setSavingConditionSearch] = useState(false);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFormat, setUploadFormat] = useState("geojson");
  const [uploadSrid, setUploadSrid] = useState("4326");
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

  const [featureEditOpen, setFeatureEditOpen] = useState(false);
  const [featurePropertyDraft, setFeaturePropertyDraft] = useState<Record<string, string>>({});
  const [featureGeometryDraft, setFeatureGeometryDraft] = useState("");
  const [savingFeature, setSavingFeature] = useState(false);

  const [landQuery, setLandQuery] = useState("");
  const [lands, setLands] = useState<Land[]>([]);
  const [selectedLandId, setSelectedLandId] = useState<string | null>(null);
  const [selectedLand, setSelectedLand] = useState<Land | null>(null);
  const [landDraft, setLandDraft] = useState<LandDraft>(emptyLandDraft());
  const [loadingLands, setLoadingLands] = useState(false);
  const [savingLand, setSavingLand] = useState(false);
  const [deletingLand, setDeletingLand] = useState(false);

  const [buildingQuery, setBuildingQuery] = useState("");
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<Building | null>(null);
  const [buildingDraft, setBuildingDraft] = useState<BuildingDraft>(emptyBuildingDraft());
  const [loadingBuildings, setLoadingBuildings] = useState(false);
  const [savingBuilding, setSavingBuilding] = useState(false);
  const [deletingBuilding, setDeletingBuilding] = useState(false);

  const [partyQuery, setPartyQuery] = useState("");
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [partyDraft, setPartyDraft] = useState<PartyDraft>(emptyPartyDraft());
  const [loadingParties, setLoadingParties] = useState(false);
  const [savingParty, setSavingParty] = useState(false);
  const [deletingParty, setDeletingParty] = useState(false);

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
  const layerListItems = useMemo(() => groupLayerListItems(layers), [layers]);
  const polygonLayers = useMemo(() => layers.filter(isPolygonLayer), [layers]);
  const boundaryCandidateLayers = useMemo(() => layers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer)), [layers]);

  useEffect(() => {
    setZoneSpatialLayerIds((current) => {
      const validLayerIds = current.filter((id) => layerById.has(id));
      if (validLayerIds.length) {
        return validLayerIds.length === current.length ? current : validLayerIds;
      }
      const defaultLayerIds = polygonLayers.map((layer) => layer.id);
      if (defaultLayerIds.length) return defaultLayerIds;
      return layers[0] ? [layers[0].id] : [];
    });
  }, [layerById, layers, polygonLayers]);

  const navigateTab = useCallback((tab: BusinessTab) => {
    const path = tabPath(tab);
    window.history.pushState(null, "", path);
    const nextRoute = parseRoute(path);
    setActiveTab(nextRoute.tab);
    setRouteSelection(nextRoute);
  }, []);

  const selectLand = useCallback((id: string) => {
    const path = `/lands/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("lands");
    setRouteSelection({ tab: "lands", id });
    setSelectedLandId(id);
  }, []);

  const selectBuilding = useCallback((id: string) => {
    const path = `/buildings/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("buildings");
    setRouteSelection({ tab: "buildings", id });
    setSelectedBuildingId(id);
  }, []);

  const selectParty = useCallback((id: string) => {
    const path = `/parties/${encodeURIComponent(id)}`;
    window.history.pushState(null, "", path);
    setActiveTab("parties");
    setRouteSelection({ tab: "parties", id });
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
    if (routeSelection.tab === "lands" && routeSelection.id) {
      setSelectedLandId(routeSelection.id);
    }
    if (routeSelection.tab === "buildings" && routeSelection.id) {
      setSelectedBuildingId(routeSelection.id);
    }
    if (routeSelection.tab === "parties" && routeSelection.id) {
      setSelectedPartyId(routeSelection.id);
    }
  }, [routeSelection]);

  useEffect(() => {
    if (activeTab !== "zone") return;
    window.setTimeout(() => mapRef.current?.resize(), 0);
  }, [activeTab]);

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
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLayers(false);
    }
  }, [outerBoundaryLayerId, outerTargetLayerId, selectedProject, targetLayerId]);

  const refreshLands = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingLands(true);
    try {
      const items = await getLands(selectedProject, landQuery);
      setLands(items);
      if (activeTab === "lands" && !selectedLandId && items[0]) {
        setSelectedLandId(items[0].id);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLands(false);
    }
  }, [activeTab, landQuery, selectedLandId, selectedProject]);

  const refreshBuildings = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingBuildings(true);
    try {
      const items = await getBuildings(selectedProject, buildingQuery);
      setBuildings(items);
      if (activeTab === "buildings" && !selectedBuildingId && items[0]) {
        setSelectedBuildingId(items[0].id);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingBuildings(false);
    }
  }, [activeTab, buildingQuery, selectedBuildingId, selectedProject]);

  const refreshParties = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingParties(true);
    try {
      const items = await getParties(selectedProject, partyQuery);
      setParties(items);
      if (activeTab === "parties" && !selectedPartyId && items[0]) {
        setSelectedPartyId(items[0].id);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingParties(false);
    }
  }, [activeTab, partyQuery, selectedPartyId, selectedProject]);

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
    void refreshLands();
  }, [refreshLands]);

  useEffect(() => {
    void refreshBuildings();
  }, [refreshBuildings]);

  useEffect(() => {
    void refreshParties();
  }, [refreshParties]);

  useEffect(() => {
    if (!selectedLandId) {
      setSelectedLand(null);
      setLandDraft(emptyLandDraft());
      return;
    }
    getLand(selectedLandId)
      .then((item) => {
        setSelectedLand(item);
        setLandDraft(toLandDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [selectedLandId]);

  useEffect(() => {
    if (!selectedBuildingId) {
      setSelectedBuilding(null);
      setBuildingDraft(emptyBuildingDraft());
      return;
    }
    getBuilding(selectedBuildingId)
      .then((item) => {
        setSelectedBuilding(item);
        setBuildingDraft(toBuildingDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [selectedBuildingId]);

  useEffect(() => {
    if (!selectedPartyId) {
      setSelectedParty(null);
      setPartyDraft(emptyPartyDraft());
      return;
    }
    getParty(selectedPartyId)
      .then((item) => {
        setSelectedParty(item);
        setPartyDraft(toPartyDraft(item));
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, [selectedPartyId]);

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
  }, [layers, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    syncConditionSearchHighlight(map, zoneSearchResults);
  }, [mapReady, zoneSearchResults]);

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

  const submitZoneSearch = async () => {
    if (!selectedProject) return;
    setLoadingZoneSearch(true);
    try {
      const results = await conditionSearchFeatures(buildConditionQuery());
      setZoneSearchResults(results);
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
    if (
      zoneSearchLinkedOnly ||
      zoneBusinessSourceType !== "all" ||
      zoneBusinessQuery.trim() ||
      zonePartyQuery.trim() ||
      zonePartyType.trim() ||
      zoneRelationType.trim()
    ) {
      conditions.push({
        type: "business",
        sourceTypes: zoneBusinessSourceType === "all" ? ["land", "building"] : [zoneBusinessSourceType],
        businessQuery: zoneBusinessQuery.trim() || undefined,
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

  const saveLand = async () => {
    if (!selectedLand) return;
    if (!landDraft.lotNumber.trim() || !landDraft.address.trim() || !landDraft.status.trim()) {
      setNotice("地番、所在地、ステータスは必須です");
      return;
    }
    try {
      setSavingLand(true);
      const item = await updateLand(selectedLand.id, {
        lotNumber: landDraft.lotNumber,
        address: landDraft.address,
        landUse: nullableString(landDraft.landUse),
        areaSqm: nullableNumber(landDraft.areaSqm, "面積"),
        status: landDraft.status,
        memo: nullableString(landDraft.memo),
        sourceLayerId: nullableString(landDraft.sourceLayerId),
        sourceFeatureId: nullableString(landDraft.sourceFeatureId)
      });
      setSelectedLand(item);
      setLandDraft(toLandDraft(item));
      void refreshLands();
      void refreshBuildings();
      setNotice("土地を保存しました");
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
      setNotice("土地を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingLand(false);
    }
  };

  const saveBuilding = async () => {
    if (!selectedBuilding) return;
    if (!buildingDraft.name.trim() || !buildingDraft.status.trim()) {
      setNotice("建物名、ステータスは必須です");
      return;
    }
    try {
      setSavingBuilding(true);
      const item = await updateBuilding(selectedBuilding.id, {
        landId: nullableString(buildingDraft.landId),
        name: buildingDraft.name,
        buildingUse: nullableString(buildingDraft.buildingUse),
        floors: nullableInteger(buildingDraft.floors, "階数"),
        totalFloorAreaSqm: nullableNumber(buildingDraft.totalFloorAreaSqm, "延床面積"),
        structure: nullableString(buildingDraft.structure),
        status: buildingDraft.status,
        memo: nullableString(buildingDraft.memo),
        sourceLayerId: nullableString(buildingDraft.sourceLayerId),
        sourceFeatureId: nullableString(buildingDraft.sourceFeatureId)
      });
      setSelectedBuilding(item);
      setBuildingDraft(toBuildingDraft(item));
      void refreshBuildings();
      if (selectedLandId) void getLand(selectedLandId).then(setSelectedLand).catch((error) => setNotice(errorMessage(error)));
      setNotice("建物を保存しました");
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
      if (selectedLandId) await getLand(selectedLandId).then(setSelectedLand);
      setNotice("建物を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDeletingBuilding(false);
    }
  };

  const saveParty = async () => {
    if (!selectedParty) return;
    if (!partyDraft.name.trim() || !partyDraft.partyType.trim()) {
      setNotice("名称、種別は必須です");
      return;
    }
    try {
      setSavingParty(true);
      const item = await updateParty(selectedParty.id, {
        name: partyDraft.name,
        partyType: partyDraft.partyType,
        contact: nullableString(partyDraft.contact),
        address: nullableString(partyDraft.address),
        memo: nullableString(partyDraft.memo)
      });
      setSelectedParty(item);
      setPartyDraft(toPartyDraft(item));
      void refreshParties();
      setNotice("関係者を保存しました");
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
      </header>

      <main className="business-workspace">
        <section className={`tab-pane zone-tab${activeTab === "zone" ? " active" : ""}`} aria-hidden={activeTab !== "zone"}>
          <div className="app-shell">
            <aside className="left-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">PostGIS Web GIS</p>
            <h1>レイヤ操作</h1>
          </div>
          <button className="icon-button" type="button" onClick={() => void refreshLayers()} title="レイヤ更新">
            <RefreshCcw size={18} />
          </button>
        </header>

        <section className="panel-section">
          <label>
            プロジェクト
            <select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <ZoneSearchPanel
          layers={layers}
          layerById={layerById}
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
          onSelect={(result) => void openZoneSearchResult(result)}
        />

        <section className="panel-section">
          <div className="section-title">
            <Upload size={16} />
            <h2>取込</h2>
          </div>
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
          <button className="command-button" type="button" onClick={() => void submitUpload()} disabled={!uploadFile}>
            <Upload size={16} />
            取込開始
          </button>
        </section>

        <section className="panel-section layer-list-section">
          <div className="section-title">
            <Layers size={16} />
            <h2>レイヤ</h2>
            {loadingLayers ? <Loader2 className="spin muted-icon" size={15} /> : null}
          </div>
          <div className="layer-list">
            <div className="layer-row base-layer">
              <span className="drag-handle disabled" aria-hidden="true" />
              <button
                className="icon-button"
                type="button"
                onClick={() => setBaseMapVisible((visible) => !visible)}
                title="ベース地図表示切替"
              >
                {baseMapVisible ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
              <div className="layer-meta">
                <strong>
                  <MapIcon size={14} />
                  OpenStreetMap
                </strong>
                <span>ベース地図</span>
              </div>
            </div>
            {layerListItems.map((item) => {
              if (item.type === "resultSet") {
                const childIds = item.layers.map((layer) => layer.id);
                const allVisible = childIds.every((layerId) => visibleLayerIds.has(layerId));
                return (
                  <div className="layer-result-group" key={item.id}>
                    <div className="layer-row layer-group-row">
                      <span className="drag-handle disabled" aria-hidden="true" />
                      <button className="icon-button" type="button" onClick={() => toggleLayerGroup(childIds)} title="まとめて表示切替">
                        {allVisible ? <Eye size={17} /> : <EyeOff size={17} />}
                      </button>
                      <div className="layer-meta">
                        <strong>{item.name}</strong>
                        <span>条件検索結果 · {item.layers.length.toLocaleString()}レイヤ</span>
                      </div>
                    </div>
                    {item.layers.map((layer) => (
                      <div className="layer-row child-layer-row" key={layer.id}>
                        <span className="drag-handle disabled" aria-hidden="true" />
                        <button className="icon-button" type="button" onClick={() => toggleLayer(layer.id)} title="表示切替">
                          {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                        </button>
                        <div className="layer-meta">
                          <strong>{layer.name}</strong>
                          <span>
                            {layer.geometryType} · {layer.rowCount.toLocaleString()}件
                          </span>
                        </div>
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
                  onDragEnd={() => setDraggingLayerId(null)}
                  onDragOver={dragLayerOver}
                  onDragStart={(event) => startLayerDrag(event, layer.id)}
                  onDrop={(event) => dropLayer(event, layer.id)}
                >
                  <span className="drag-handle" title="ドラッグして並べ替え" aria-label="ドラッグして並べ替え">
                    <GripVertical size={16} />
                  </span>
                  <button className="icon-button" type="button" onClick={() => toggleLayer(layer.id)} title="表示切替">
                    {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                  </button>
                  <div className="layer-meta">
                    <strong>{layer.name}</strong>
                    <span>
                      {layer.geometryType} · {layer.rowCount.toLocaleString()}件{layer.isResult ? " · 結果" : ""}
                    </span>
                  </div>
                </div>
              );
            })}
            {!layers.length ? <p className="empty-state">取込済みレイヤはありません</p> : null}
          </div>
        </section>

        <section className="panel-section analysis-section">
          <div className="section-title">
            <MapIcon size={16} />
            <h2>外縁生成</h2>
          </div>
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
            <input
              value={outerBoundaryBufferMeters}
              onChange={(event) => setOuterBoundaryBufferMeters(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <button
            className="command-button"
            type="button"
            onClick={() => void submitOuterBoundary()}
            disabled={!outerTargetLayerId || !outerBoundaryLayerId}
          >
            <Play size={16} />
            外縁生成開始
          </button>
        </section>
      </aside>

      <main className="map-panel">
        <div ref={mapContainerRef} className="map-container" />
        {notice ? (
          <div className="notice">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>
              閉じる
            </button>
          </div>
        ) : null}
      </main>

      <aside className="right-panel">
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
                  onClick={() => setFeatureEditOpen((open) => !open)}
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
                  onSave={() => void saveSelectedFeature()}
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

        <section className="panel-section">
          <h2>ジョブ</h2>
          <JobList title="取込" jobs={importJobs} />
          <JobList title="解析" jobs={analysisJobs} />
        </section>
            </aside>
          </div>
        </section>

        <section className={`tab-pane${activeTab === "lands" ? " active" : ""}`} aria-hidden={activeTab !== "lands"}>
          <LandWorkspace
            query={landQuery}
            setQuery={setLandQuery}
            items={lands}
            selected={selectedLand}
            draft={landDraft}
            setDraft={setLandDraft}
            loading={loadingLands}
            saving={savingLand}
            deleting={deletingLand}
            onRefresh={() => void refreshLands()}
            onSelect={selectLand}
            onSave={() => void saveLand()}
            onDelete={() => void removeLand()}
            onOpenBuilding={selectBuilding}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>

        <section className={`tab-pane${activeTab === "buildings" ? " active" : ""}`} aria-hidden={activeTab !== "buildings"}>
          <BuildingWorkspace
            query={buildingQuery}
            setQuery={setBuildingQuery}
            items={buildings}
            lands={lands}
            selected={selectedBuilding}
            draft={buildingDraft}
            setDraft={setBuildingDraft}
            loading={loadingBuildings}
            saving={savingBuilding}
            deleting={deletingBuilding}
            onRefresh={() => void refreshBuildings()}
            onSelect={selectBuilding}
            onSave={() => void saveBuilding()}
            onDelete={() => void removeBuilding()}
            onOpenLand={selectLand}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>

        <section className={`tab-pane${activeTab === "parties" ? " active" : ""}`} aria-hidden={activeTab !== "parties"}>
          <PartyWorkspace
            query={partyQuery}
            setQuery={setPartyQuery}
            items={parties}
            selected={selectedParty}
            draft={partyDraft}
            setDraft={setPartyDraft}
            loading={loadingParties}
            saving={savingParty}
            deleting={deletingParty}
            onRefresh={() => void refreshParties()}
            onSelect={selectParty}
            onSave={() => void saveParty()}
            onDelete={() => void removeParty()}
            selectedProject={selectedProject}
            projects={projects}
            onProjectChange={setSelectedProject}
          />
        </section>
      </main>

      {notice && activeTab !== "zone" ? (
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
  const updateAttribute = (id: string, patch: Partial<AttributeConditionDraft>) => {
    setAttributeConditions((current) =>
      current.map((condition) => {
        if (condition.id !== id) return condition;
        const next = { ...condition, ...patch };
        if (patch.layerId) {
          next.field = layerById.get(patch.layerId)?.attributes[0]?.name ?? "";
        }
        return next;
      })
    );
  };

  return (
    <div className="conditions">
      {attributeConditions.map((condition) => {
        const fields = layerById.get(condition.layerId)?.attributes ?? [];
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
            <input
              value={condition.value}
              onChange={(event) => updateAttribute(condition.id, { value: event.target.value })}
              disabled={condition.operator === "IS NULL"}
            />
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
  onSelect
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
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
                  onChange={(event) => setBusinessSourceType(event.target.value as ZoneBusinessSourceType)}
                >
                  <option value="all">土地または建物</option>
                  <option value="land">土地</option>
                  <option value="building">建物</option>
                </select>
              </label>
              <label className="search-field">
                業務キーワード
                <span>
                  <Search size={15} />
                  <input value={businessQuery} onChange={(event) => setBusinessQuery(event.target.value)} />
                </span>
              </label>
            </div>
            <div className="zone-condition-grid business-party-grid">
              <label>
                事業者
                <input value={partyQuery} onChange={(event) => setPartyQuery(event.target.value)} />
              </label>
              <label>
                種別
                <input value={partyType} onChange={(event) => setPartyType(event.target.value)} />
              </label>
              <label>
                関係
                <input value={relationType} onChange={(event) => setRelationType(event.target.value)} />
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

function LandWorkspace({
  query,
  setQuery,
  items,
  selected,
  draft,
  setDraft,
  loading,
  saving,
  deleting,
  onRefresh,
  onSelect,
  onSave,
  onDelete,
  onOpenBuilding,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  items: Land[];
  selected: Land | null;
  draft: LandDraft;
  setDraft: React.Dispatch<React.SetStateAction<LandDraft>>;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenBuilding: (id: string) => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  return (
    <div className="object-workspace">
      <ObjectSidebar
        title="土地"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        {items.map((land) => (
          <button
            className={`object-row${selected?.id === land.id ? " active" : ""}`}
            key={land.id}
            type="button"
            onClick={() => onSelect(land.id)}
          >
            <strong>{land.id}</strong>
            <span>{land.lotNumber}</span>
            <em>{land.address}</em>
          </button>
        ))}
        {!items.length ? <p className="empty-state">土地はありません</p> : null}
      </ObjectSidebar>

      <section className="object-detail">
        {selected ? (
          <>
            <ObjectDetailHeader
              id={selected.id}
              title={selected.lotNumber}
              subtitle={selected.address}
              status={selected.status}
              href={`/lands/${encodeURIComponent(selected.id)}`}
            />
            <div className="object-form">
              <label>
                地番
                <input value={draft.lotNumber} onChange={(event) => setDraft((current) => ({ ...current, lotNumber: event.target.value }))} />
              </label>
              <label>
                所在地
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label>
                用途
                <input value={draft.landUse} onChange={(event) => setDraft((current) => ({ ...current, landUse: event.target.value }))} />
              </label>
              <label>
                面積(m2)
                <input value={draft.areaSqm} onChange={(event) => setDraft((current) => ({ ...current, areaSqm: event.target.value }))} inputMode="decimal" />
              </label>
              <label>
                ステータス
                <input value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))} />
              </label>
              <label>
                source layer
                <input value={draft.sourceLayerId} onChange={(event) => setDraft((current) => ({ ...current, sourceLayerId: event.target.value }))} />
              </label>
              <label>
                source feature
                <input value={draft.sourceFeatureId} onChange={(event) => setDraft((current) => ({ ...current, sourceFeatureId: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>

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

            <RelationshipList relationships={selected.relationships} />
            <ObjectActions saving={saving} deleting={deleting} onSave={onSave} onDelete={onDelete} />
          </>
        ) : (
          <p className="empty-state">土地を選択してください</p>
        )}
      </section>
    </div>
  );
}

function BuildingWorkspace({
  query,
  setQuery,
  items,
  lands,
  selected,
  draft,
  setDraft,
  loading,
  saving,
  deleting,
  onRefresh,
  onSelect,
  onSave,
  onDelete,
  onOpenLand,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  items: Building[];
  lands: Land[];
  selected: Building | null;
  draft: BuildingDraft;
  setDraft: React.Dispatch<React.SetStateAction<BuildingDraft>>;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  return (
    <div className="object-workspace">
      <ObjectSidebar
        title="建物"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        {items.map((building) => (
          <button
            className={`object-row${selected?.id === building.id ? " active" : ""}`}
            key={building.id}
            type="button"
            onClick={() => onSelect(building.id)}
          >
            <strong>{building.id}</strong>
            <span>{building.name}</span>
            <em>{building.landLabel ?? "土地未設定"}</em>
          </button>
        ))}
        {!items.length ? <p className="empty-state">建物はありません</p> : null}
      </ObjectSidebar>

      <section className="object-detail">
        {selected ? (
          <>
            <ObjectDetailHeader
              id={selected.id}
              title={selected.name}
              subtitle={selected.landLabel ?? "土地未設定"}
              status={selected.status}
              href={`/buildings/${encodeURIComponent(selected.id)}`}
            />
            <div className="object-form">
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
                用途
                <input value={draft.buildingUse} onChange={(event) => setDraft((current) => ({ ...current, buildingUse: event.target.value }))} />
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
                構造
                <input value={draft.structure} onChange={(event) => setDraft((current) => ({ ...current, structure: event.target.value }))} />
              </label>
              <label>
                ステータス
                <input value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))} />
              </label>
              <label>
                source layer
                <input value={draft.sourceLayerId} onChange={(event) => setDraft((current) => ({ ...current, sourceLayerId: event.target.value }))} />
              </label>
              <label>
                source feature
                <input value={draft.sourceFeatureId} onChange={(event) => setDraft((current) => ({ ...current, sourceFeatureId: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
            {selected.landId ? (
              <div className="object-related">
                <h3>土地</h3>
                <button type="button" onClick={() => selected.landId && onOpenLand(selected.landId)}>
                  <MapIcon size={15} />
                  <strong>{selected.landId}</strong>
                  <span>{selected.landLabel}</span>
                </button>
              </div>
            ) : null}
            <RelationshipList relationships={selected.relationships} />
            <ObjectActions saving={saving} deleting={deleting} onSave={onSave} onDelete={onDelete} />
          </>
        ) : (
          <p className="empty-state">建物を選択してください</p>
        )}
      </section>
    </div>
  );
}

function PartyWorkspace({
  query,
  setQuery,
  items,
  selected,
  draft,
  setDraft,
  loading,
  saving,
  deleting,
  onRefresh,
  onSelect,
  onSave,
  onDelete,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  items: Party[];
  selected: Party | null;
  draft: PartyDraft;
  setDraft: React.Dispatch<React.SetStateAction<PartyDraft>>;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onSave: () => void;
  onDelete: () => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  return (
    <div className="object-workspace">
      <ObjectSidebar
        title="関係者"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        {items.map((party) => (
          <button
            className={`object-row${selected?.id === party.id ? " active" : ""}`}
            key={party.id}
            type="button"
            onClick={() => onSelect(party.id)}
          >
            <strong>{party.id}</strong>
            <span>{party.name}</span>
            <em>{party.partyType}</em>
          </button>
        ))}
        {!items.length ? <p className="empty-state">関係者はありません</p> : null}
      </ObjectSidebar>

      <section className="object-detail">
        {selected ? (
          <>
            <ObjectDetailHeader
              id={selected.id}
              title={selected.name}
              subtitle={selected.partyType}
              href={`/parties/${encodeURIComponent(selected.id)}`}
            />
            <div className="object-form">
              <label>
                名称
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                種別
                <input value={draft.partyType} onChange={(event) => setDraft((current) => ({ ...current, partyType: event.target.value }))} />
              </label>
              <label>
                連絡先
                <input value={draft.contact} onChange={(event) => setDraft((current) => ({ ...current, contact: event.target.value }))} />
              </label>
              <label>
                住所
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
            <RelationshipList relationships={selected.relationships} />
            <ObjectActions saving={saving} deleting={deleting} onSave={onSave} onDelete={onDelete} />
          </>
        ) : (
          <p className="empty-state">関係者を選択してください</p>
        )}
      </section>
    </div>
  );
}

function ObjectSidebar({
  title,
  query,
  setQuery,
  loading,
  onRefresh,
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
        <button className="icon-button" type="button" onClick={onRefresh} title="更新">
          {loading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
        </button>
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
      <label className="search-field">
        検索
        <span>
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </span>
      </label>
      <div className="object-list">{children}</div>
    </aside>
  );
}

function ObjectDetailHeader({
  id,
  title,
  subtitle,
  status,
  href
}: {
  id: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  href: string;
}) {
  return (
    <header className="object-detail-header">
      <div>
        <p className="eyebrow">{id}</p>
        <h1>{title}</h1>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      <div className="object-header-actions">
        {status ? <strong>{status}</strong> : null}
        <a className="icon-button" href={href} target="_blank" rel="noreferrer" title="別タブで開く">
          <ExternalLink size={16} />
        </a>
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
  onDelete
}: {
  saving: boolean;
  deleting: boolean;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="object-actions">
      <button className="danger-button" type="button" onClick={onDelete} disabled={deleting || saving}>
        {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
        削除
      </button>
      <button className="command-button" type="button" onClick={onSave} disabled={saving || deleting}>
        {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
        保存
      </button>
    </div>
  );
}

function addMapLayers(map: MapLibreMap, layer: Layer, color: string): string[] {
  const sourceLayer = layer.tileSourceId;
  const source = layer.id;
  const geometryType = layer.geometryType.toUpperCase();
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
      paint: { "fill-color": color, "fill-opacity": 0.32 }
    } as maplibregl.FillLayerSpecification);
    map.addLayer({
      id: outlineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "line-color": color, "line-width": 1.2 }
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
      paint: { "fill-color": "#facc15", "fill-opacity": 0.42 }
    } as maplibregl.FillLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-line`)) {
    map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      paint: { "line-color": "#e11d48", "line-width": 3 }
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

function formatEditorValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function editableFeatureAttributes(layer: Layer) {
  return layer.attributes.filter((attribute) => attribute.name !== layer.featureIdColumn && attribute.name !== layer.geometryColumn);
}

function isPolygonLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("POLYGON");
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
  if (segment === "lands") return { tab: "lands", id };
  if (segment === "buildings") return { tab: "buildings", id };
  if (segment === "parties") return { tab: "parties", id };
  return { tab: "zone", id: null };
}

function tabPath(tab: BusinessTab): string {
  if (tab === "lands") return "/lands";
  if (tab === "buildings") return "/buildings";
  if (tab === "parties") return "/parties";
  return "/";
}

function emptyLandDraft(): LandDraft {
  return {
    lotNumber: "",
    address: "",
    landUse: "",
    areaSqm: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

function emptyBuildingDraft(): BuildingDraft {
  return {
    landId: "",
    name: "",
    buildingUse: "",
    floors: "",
    totalFloorAreaSqm: "",
    structure: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

function emptyPartyDraft(): PartyDraft {
  return {
    name: "",
    partyType: "",
    contact: "",
    address: "",
    memo: ""
  };
}

function toLandDraft(land: Land): LandDraft {
  return {
    lotNumber: land.lotNumber,
    address: land.address,
    landUse: land.landUse ?? "",
    areaSqm: land.areaSqm === null || land.areaSqm === undefined ? "" : String(land.areaSqm),
    status: land.status,
    memo: land.memo ?? "",
    sourceLayerId: land.sourceLayerId ?? "",
    sourceFeatureId: land.sourceFeatureId ?? ""
  };
}

function toBuildingDraft(building: Building): BuildingDraft {
  return {
    landId: building.landId ?? "",
    name: building.name,
    buildingUse: building.buildingUse ?? "",
    floors: building.floors === null || building.floors === undefined ? "" : String(building.floors),
    totalFloorAreaSqm:
      building.totalFloorAreaSqm === null || building.totalFloorAreaSqm === undefined ? "" : String(building.totalFloorAreaSqm),
    structure: building.structure ?? "",
    status: building.status,
    memo: building.memo ?? "",
    sourceLayerId: building.sourceLayerId ?? "",
    sourceFeatureId: building.sourceFeatureId ?? ""
  };
}

function toPartyDraft(party: Party): PartyDraft {
  return {
    name: party.name,
    partyType: party.partyType,
    contact: party.contact ?? "",
    address: party.address ?? "",
    memo: party.memo ?? ""
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
