import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type MapLayerMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import { Building2, EyeOff, FileText, Map as MapIcon, Users } from "lucide-react";
import {
  conditionSearchFeatures,
  createAnalysisJob,
  createBuilding,
  createImportJob,
  createLand,
  createParty,
  createPartyRelationship,
  createZone,
  createZoneLayerFromImport,
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
  getLand,
  getLands,
  getLayers,
  getParties,
  getParty,
  getProjects,
  getZone,
  getZones,
  updateBuilding,
  updateFeature,
  updateLand,
  updateParty,
  updatePartyRelationship,
  updateZone
} from "./api";
import type {
  AttributeConditionDraft,
  Building,
  BusinessLinks,
  BusinessObjectFilters,
  ConditionQuery,
  ConditionQueryCondition,
  Feature,
  FeatureSearchResult,
  Land,
  Layer,
  Party,
  Project,
  SpatialConditionDraft,
  Zone,
  ZoneLayerOperation
} from "./types";
import type {
  BuildingDraft,
  BusinessListSearchCriteria,
  BusinessTab,
  LandDraft,
  LayerListItem,
  PartyDraft,
  RelationshipDraft,
  RouteSelection,
  ZoneBusinessSourceType,
  ZoneDraft,
  ZoneLayerCreateMetadata
} from "./appTypes";
import {
  baseStyle,
  businessMapHighlightLimit,
  defaultMapZoom,
  emptyBusinessLinks,
  imperialPalaceCenter,
  layerColors
} from "./constants";
import {
  addMapLayers,
  buildBusinessMapTargets,
  canCreateZoneLayerFromSource,
  canUseSelectedFeatureAsZoneFeature,
  conditionResultName,
  defaultZoneSpatialLayerIds,
  editableFeatureAttributes,
  emptyBuildingDraft,
  emptyBusinessListSearchCriteria,
  emptyLandDraft,
  emptyPartyDraft,
  emptyZoneDraft,
  errorMessage,
  focusFeatureResults,
  focusGeometry,
  formatEditorValue,
  groupLayerListItems,
  isZoneLayer,
  moveLayerBefore,
  newBuildingDraft,
  newLandDraft,
  newPartyDraft,
  newZoneDraft,
  normalizeZoneLayerFilter,
  nullableInteger,
  nullableNumber,
  nullableString,
  orderLayers,
  parseEditedProperty,
  parsePartyTags,
  parseRoute,
  readLayerViewState,
  readZoneDistance,
  restoreVisibleLayerIds,
  syncConditionSearchHighlight,
  syncMapLayerOrder,
  tabPath,
  toAttributePayload,
  toBuildingDraft,
  toBusinessListSearchCriteria,
  toConditionAttributePayload,
  toLandDraft,
  toPartyDraft,
  toZoneDraft,
  uniqueBusinessMapTargets,
  writeLayerViewState,
  zoneMetadataFromDraft
} from "./utils";
import { BuildingWorkspace } from "./components/BuildingWorkspace";
import { LandWorkspace } from "./components/LandWorkspace";
import { MapSupportPane } from "./components/MapSupportPane";
import { PartyWorkspace } from "./components/PartyWorkspace";
import { ZoneSearchPanel } from "./components/ZoneSearchPanel";
import { ZoneWorkspace } from "./components/ZoneWorkspace";

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

  const [analysisName, setAnalysisName] = useState("");
  const [targetLayerId, setTargetLayerId] = useState("");
  const [attributeConditions, setAttributeConditions] = useState<AttributeConditionDraft[]>([]);
  const [spatialConditions, setSpatialConditions] = useState<SpatialConditionDraft[]>([]);

  const [zoneSourceLayerId, setZoneSourceLayerId] = useState("");
  const [zoneUploadFile, setZoneUploadFile] = useState<File | null>(null);
  const [zoneUploadFormat, setZoneUploadFormat] = useState("geojson");
  const [zoneUploadSrid, setZoneUploadSrid] = useState("4326");
  const [creatingZoneLayer, setCreatingZoneLayer] = useState(false);

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
  const zoneSourceLayers = useMemo(() => layers.filter(canCreateZoneLayerFromSource), [layers]);

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
      const nextZoneSourceLayers = nextLayers.filter(canCreateZoneLayerFromSource);
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
      if (!nextZoneSourceLayers.some((layer) => layer.id === zoneSourceLayerId)) {
        setZoneSourceLayerId(nextZoneSourceLayers[0]?.id ?? "");
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLayers(false);
    }
  }, [selectedProject, targetLayerId, zoneSourceLayerId]);

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

  const submitZoneUpload = async () => {
    if (!selectedProject || !zoneUploadFile) return;
    const formData = new FormData();
    formData.set("projectId", selectedProject);
    formData.set("format", zoneUploadFormat);
    if (zoneUploadSrid.trim()) formData.set("sourceSrid", zoneUploadSrid.trim());
    formData.set("file", zoneUploadFile);
    try {
      setCreatingZoneLayer(true);
      const job = await createImportJob(formData);
      pollImportJob(job.id, { createZoneLayer: true, metadata: zoneMetadataFromDraft(zoneDraft) });
    } catch (error) {
      setCreatingZoneLayer(false);
      setNotice(errorMessage(error));
    }
  };

  const pollImportJob = (id: string, options: { createZoneLayer?: boolean; metadata?: ZoneLayerCreateMetadata } = {}) => {
    const timer = window.setInterval(async () => {
      try {
        const job = await getImportJob(id);
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          if (job.status === "failed") {
            if (options.createZoneLayer) setCreatingZoneLayer(false);
            setNotice(job.errorMessage ?? "区域データの取込に失敗しました");
            return;
          }
          if (options.createZoneLayer) {
            if (job.layerId) {
              const result = await createZoneFromSourceLayer(job.layerId, {
                ...options.metadata,
                manageLoading: false
              });
              if (result) openCreatedZoneFromOperation(result);
            } else {
              setNotice("区域データの取込結果を取得できませんでした");
            }
            setCreatingZoneLayer(false);
          } else {
            void refreshLayers();
            void refreshZones();
          }
        }
      } catch (error) {
        window.clearInterval(timer);
        if (options.createZoneLayer) setCreatingZoneLayer(false);
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
      pollAnalysisJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const openCreatedZoneFromOperation = (result: ZoneLayerOperation) => {
    const createdZone = result.zones[0];
    if (!createdZone) return;
    setActiveTab("zone");
    setCreatingZone(false);
    window.history.pushState(null, "", `/zones/${encodeURIComponent(createdZone.id)}`);
    setRouteSelection({ tab: "zone", id: createdZone.id });
    setSelectedZoneId(createdZone.id);
    setSelectedZone(createdZone);
    setZoneDraft(toZoneDraft(createdZone));
  };

  const createZoneFromSourceLayer = async (
    layerId: string,
    options: ZoneLayerCreateMetadata & { manageLoading?: boolean } = {}
  ): Promise<ZoneLayerOperation | null> => {
    if (!selectedProject) return null;
    const manageLoading = options.manageLoading ?? true;
    try {
      if (manageLoading) setCreatingZoneLayer(true);
      const result = await createZoneLayerFromImport({
        projectId: selectedProject,
        layerId,
        name: options.name,
        zoneType: options.zoneType,
        status: options.status
      });
      await refreshLayers();
      await refreshZones();
      setZoneFilters((current) => ({ ...current, zoneLayerId: result.layer.id }));
      setVisibleLayerIds((current) => new Set([...current, result.layer.id]));
      setNotice(`区域レイヤを作成しました（${result.zonesCreated.toLocaleString()}件作成）`);
      return result;
    } catch (error) {
      setNotice(errorMessage(error));
      return null;
    } finally {
      if (manageLoading) setCreatingZoneLayer(false);
    }
  };

  const submitZoneFromLayer = async () => {
    if (!zoneSourceLayerId) return;
    const result = await createZoneFromSourceLayer(zoneSourceLayerId, zoneMetadataFromDraft(zoneDraft));
    if (result) openCreatedZoneFromOperation(result);
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
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          if (job.status === "failed") {
            setNotice(job.errorMessage ?? "条件検索結果の保存に失敗しました");
          } else {
            void refreshLayers();
          }
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
    setZoneSourceLayerId((current) => (deletedLayerIds.has(current) ? remainingLayers.filter(canCreateZoneLayerFromSource)[0]?.id ?? "" : current));
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
    setZoneDraft(newZoneDraft());
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
            zoneSourceLayerId={zoneSourceLayerId}
            setZoneSourceLayerId={setZoneSourceLayerId}
            zoneSourceLayers={zoneSourceLayers}
            zoneUploadFile={zoneUploadFile}
            setZoneUploadFile={setZoneUploadFile}
            zoneUploadFormat={zoneUploadFormat}
            setZoneUploadFormat={setZoneUploadFormat}
            zoneUploadSrid={zoneUploadSrid}
            setZoneUploadSrid={setZoneUploadSrid}
            creatingZoneLayer={creatingZoneLayer}
            onSubmitZoneFromLayer={() => void submitZoneFromLayer()}
            onSubmitZoneUpload={() => void submitZoneUpload()}
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
