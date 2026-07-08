import { type DragEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Building2, EyeOff, FileText, LogOut, Map as MapIcon, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "react-oidc-context";
import { AppStateContext } from "./appState";
import { activeScreenMeta, activeScreenObjectId, tabBasePath, tabDetailPath } from "./routeMeta";
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
  getMe,
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
  Me,
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
  MapPaneApi,
  PartyDraft,
  RelationshipDraft,
  ZoneBusinessSourceType,
  ZoneDraft,
  ZoneLayerCreateMetadata
} from "./appTypes";
import {
  businessMapHighlightLimit,
  emptyBusinessLinks,
  jobPollIntervalMs,
  jobPollTimeoutMs
} from "./constants";
import {
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
  readLayerViewState,
  readZoneDistance,
  restoreVisibleLayerIds,
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
// 地図ペイン (maplibre-gl を含む) はメインチャンクとは別チャンクとして遅延ロードする
const MapPane = lazy(() => import("./components/MapPane"));

// ルートレイアウト。認証と全業務 state を保持し (状態解体は issue #9)、
// ヘッダー・地図ペインを描画して <Outlet /> に各画面 (src/screens/) を差し込む。
export default function App() {
  const auth = useAuth();
  const app = useAppController();

  return (
    <div className="business-app">
      <header className="top-shell">
        <div className="product-mark">
          <FileText size={20} />
          <div>
            <strong>不動産業務管理</strong>
            <span>{app.projects.find((project) => project.id === app.selectedProject)?.name ?? "Project"}</span>
          </div>
        </div>
        <nav className="top-tabs" aria-label="業務タブ">
          <button className={app.activeTab === "zone" ? "active" : ""} type="button" onClick={() => app.navigateTab("zone")}>
            <MapIcon size={17} />
            区域
          </button>
          <button className={app.activeTab === "lands" ? "active" : ""} type="button" onClick={() => app.navigateTab("lands")}>
            <MapIcon size={17} />
            土地
          </button>
          <button className={app.activeTab === "buildings" ? "active" : ""} type="button" onClick={() => app.navigateTab("buildings")}>
            <Building2 size={17} />
            建物
          </button>
          <button className={app.activeTab === "parties" ? "active" : ""} type="button" onClick={() => app.navigateTab("parties")}>
            <Users size={17} />
            関係者
          </button>
          {app.me?.systemRole === "admin" ? (
            <button className={app.activeTab === "admin" ? "active" : ""} type="button" onClick={() => app.navigateTab("admin")}>
              <ShieldCheck size={17} />
              管理
            </button>
          ) : null}
        </nav>
        <button className="subtle-button top-map-toggle" type="button" onClick={() => app.setMapSupportOpen((open) => !open)}>
          {app.mapSupportOpen ? <EyeOff size={16} /> : <MapIcon size={16} />}
          {app.mapSupportOpen ? "地図を隠す" : "地図を表示"}
        </button>
        <button
          className="subtle-button"
          type="button"
          title={auth.user?.profile.preferred_username ?? auth.user?.profile.email ?? undefined}
          onClick={() => void auth.signoutRedirect()}
        >
          <LogOut size={16} />
          ログアウト
        </button>
      </header>

      <main className={`business-workspace${app.mapSupportOpen ? " map-open" : " map-closed"}`}>
        <div className="workspace-tabs">
          <AppStateContext.Provider value={app}>
            <Outlet />
          </AppStateContext.Provider>
        </div>

        <Suspense fallback={<aside className={`map-support-pane${app.mapSupportOpen ? "" : " closed"}`} />}>
          <MapPane
            apiRef={app.mapApiRef}
            onReadyChange={app.setMapReady}
            layers={app.layers}
            mapHighlightResults={app.mapHighlightResults}
            layerById={app.layerById}
            onPickFeature={app.handleMapFeatureClick}
            onNotice={app.setNotice}
            open={app.mapSupportOpen}
            onToggle={() => app.setMapSupportOpen((open) => !open)}
            baseMapVisible={app.baseMapVisible}
            setBaseMapVisible={app.setBaseMapVisible}
            layerListItems={app.layerListItems}
            visibleLayerIds={app.visibleLayerIds}
            loadingLayers={app.loadingLayers}
            deletingLayerIds={app.deletingLayerIds}
            deletingResultSetIds={app.deletingResultSetIds}
            draggingLayerId={app.draggingLayerId}
            onRefreshLayers={() => void app.refreshLayers()}
            onToggleLayer={app.toggleLayer}
            onToggleLayerGroup={app.toggleLayerGroup}
            onRequestLayerDelete={(layer) => void app.requestLayerDelete(layer)}
            onRequestResultSetDelete={(resultSet) => void app.requestResultSetDelete(resultSet)}
            onDragLayerStart={app.startLayerDrag}
            onDragLayerOver={app.dragLayerOver}
            onDropLayer={app.dropLayer}
            onDragLayerEnd={() => app.setDraggingLayerId(null)}
            selectedFeature={app.selectedFeature}
            selectedFeatureLayer={app.selectedFeatureLayer}
            businessLinks={app.businessLinks}
            loadingBusinessLinks={app.loadingBusinessLinks}
            featureEditOpen={app.featureEditOpen}
            setFeatureEditOpen={app.setFeatureEditOpen}
            featurePropertyDraft={app.featurePropertyDraft}
            setFeaturePropertyDraft={app.setFeaturePropertyDraft}
            featureGeometryDraft={app.featureGeometryDraft}
            setFeatureGeometryDraft={app.setFeatureGeometryDraft}
            savingFeature={app.savingFeature}
            onSaveFeature={() => void app.saveSelectedFeature()}
          />
        </Suspense>
      </main>

      {app.notice ? (
        <div className="notice business-notice">
          <span>{app.notice}</span>
          <button type="button" onClick={() => app.setNotice(null)}>
            閉じる
          </button>
        </div>
      ) : null}
    </div>
  );
}

// App が保持する state と handler 群。AppStateContext 経由で各画面 (薄いラッパ) へ渡す。
function useAppController() {
  const navigate = useNavigate();
  // URL (マッチ中ルートの staticData / $id param) を唯一の正として画面状態を導出する
  const activeTab = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.tab ?? "zone" });
  const routeObjectId = useRouterState({ select: (state) => activeScreenObjectId(state.matches) });
  const mapApiRef = useRef<MapPaneApi | null>(null);
  const loadedLayerProjectId = useRef<string | null>(null);
  const layersRef = useRef<Layer[]>([]);
  const activePollTimersRef = useRef<Set<number>>(new Set());

  const [mapReady, setMapReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [me, setMe] = useState<Me | null>(null);
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
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(() => (activeTab === "zone" ? routeObjectId : null));
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
  const [selectedLandId, setSelectedLandId] = useState<string | null>(() => (activeTab === "lands" ? routeObjectId : null));
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
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(() => (activeTab === "buildings" ? routeObjectId : null));
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
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(() => (activeTab === "parties" ? routeObjectId : null));
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
    void navigate({ to: tabBasePath[tab] });
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
  }, [navigate]);

  const selectZone = useCallback((id: string) => {
    void navigate({ to: tabDetailPath.zone, params: { id } });
    setCreatingZone(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setSelectedZone(null);
    setSelectedZoneId(id);
  }, [navigate]);

  const selectLand = useCallback((id: string) => {
    void navigate({ to: tabDetailPath.lands, params: { id } });
    setCreatingLand(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setSelectedLand(null);
    setSelectedLandId(id);
  }, [navigate]);

  const selectBuilding = useCallback((id: string) => {
    void navigate({ to: tabDetailPath.buildings, params: { id } });
    setCreatingBuilding(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setSelectedBuilding(null);
    setSelectedBuildingId(id);
  }, [navigate]);

  const selectParty = useCallback((id: string) => {
    void navigate({ to: tabDetailPath.parties, params: { id } });
    setCreatingParty(false);
    setListMapHighlightResults([]);
    setManualMapHighlightResults(null);
    setSelectedParty(null);
    setSelectedPartyId(id);
  }, [navigate]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // URL (ルート param) → 選択オブジェクトの同期。ブラウザバック/ディープリンクもここで反映される
  useEffect(() => {
    if (activeTab === "zone") {
      if (routeObjectId) {
        setCreatingZone(false);
        setSelectedZoneId(routeObjectId);
      } else if (!creatingZone) {
        setSelectedZoneId(null);
        setSelectedZone(null);
      }
    }
    if (activeTab === "lands") {
      if (routeObjectId) {
        setCreatingLand(false);
        setSelectedLandId(routeObjectId);
      } else if (!creatingLand) {
        setSelectedLandId(null);
        setSelectedLand(null);
      }
    }
    if (activeTab === "buildings") {
      if (routeObjectId) {
        setCreatingBuilding(false);
        setSelectedBuildingId(routeObjectId);
      } else if (!creatingBuilding) {
        setSelectedBuildingId(null);
        setSelectedBuilding(null);
      }
    }
    if (activeTab === "parties") {
      if (routeObjectId) {
        setCreatingParty(false);
        setSelectedPartyId(routeObjectId);
      } else if (!creatingParty) {
        setSelectedPartyId(null);
        setSelectedParty(null);
      }
    }
  }, [activeTab, creatingBuilding, creatingLand, creatingParty, creatingZone, routeObjectId]);

  useEffect(() => {
    window.setTimeout(() => mapApiRef.current?.resize(), 0);
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
    getMe()
      .then(setMe)
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
          mapApiRef.current?.resize();
          mapApiRef.current?.focusFeatureResults(results);
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

  // 地図クリックで拾った地物の詳細取得 (地図側の処理は MapPane に委譲)
  const handleMapFeatureClick = useCallback(async (layer: Layer, featureId: string) => {
    try {
      const feature = await getFeature(layer.id, featureId);
      setSelectedFeature(feature);
      setSelectedFeatureLayer(layer);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, []);

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
    mapApiRef.current?.reloadLayerSource(layerId);
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

  // ジョブポーリングの共通化: タイマーを ref で追跡してアンマウント時に解放し、
  // ジョブが進まない場合は上限時間で打ち切る (放置すると無限ポーリングになる)
  const startJobPolling = (tick: (stop: () => void) => Promise<void>, onTimeout: () => void) => {
    const startedAt = Date.now();
    const stop = () => {
      window.clearInterval(timer);
      activePollTimersRef.current.delete(timer);
    };
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > jobPollTimeoutMs) {
        stop();
        onTimeout();
        return;
      }
      await tick(stop);
    }, jobPollIntervalMs);
    activePollTimersRef.current.add(timer);
  };

  useEffect(() => {
    const timers = activePollTimersRef.current;
    return () => {
      for (const timer of timers) window.clearInterval(timer);
      timers.clear();
    };
  }, []);

  const pollImportJob = (id: string, options: { createZoneLayer?: boolean; metadata?: ZoneLayerCreateMetadata } = {}) => {
    startJobPolling(
      async (stop) => {
        try {
          const job = await getImportJob(id);
          if (job.status === "succeeded" || job.status === "failed") {
            stop();
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
          stop();
          if (options.createZoneLayer) setCreatingZoneLayer(false);
          setNotice(errorMessage(error));
        }
      },
      () => {
        if (options.createZoneLayer) setCreatingZoneLayer(false);
        setNotice("取込ジョブの完了確認がタイムアウトしました。時間をおいてレイヤ一覧を確認してください");
      }
    );
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
    setCreatingZone(false);
    void navigate({ to: tabDetailPath.zone, params: { id: createdZone.id } });
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
      mapApiRef.current?.focusGeometry(feature.geometry);
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
    startJobPolling(
      async (stop) => {
        try {
          const job = await getAnalysisJob(id);
          if (job.status === "succeeded" || job.status === "failed") {
            stop();
            if (job.status === "failed") {
              setNotice(job.errorMessage ?? "条件検索結果の保存に失敗しました");
            } else {
              void refreshLayers();
            }
          }
        } catch (error) {
          stop();
          setNotice(errorMessage(error));
        }
      },
      () => {
        setNotice("分析ジョブの完了確認がタイムアウトしました。時間をおいてレイヤ一覧を確認してください");
      }
    );
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
    void navigate({ to: tabBasePath.zone });
  };

  const beginCreateLand = () => {
    setCreatingLand(true);
    setSelectedLandId(null);
    setSelectedLand(null);
    setLandDraft(newLandDraft());
    void navigate({ to: tabBasePath.lands });
  };

  const beginCreateBuilding = () => {
    setCreatingBuilding(true);
    setSelectedBuildingId(null);
    setSelectedBuilding(null);
    setBuildingDraft(newBuildingDraft());
    void navigate({ to: tabBasePath.buildings });
  };

  const beginCreateParty = () => {
    setCreatingParty(true);
    setSelectedPartyId(null);
    setSelectedParty(null);
    setPartyDraft(newPartyDraft());
    void navigate({ to: tabBasePath.parties });
  };

  const cancelCreateZone = () => {
    setCreatingZone(false);
    setSelectedZoneId(null);
    setSelectedZone(null);
    setZoneDraft(emptyZoneDraft());
    void navigate({ to: tabBasePath.zone });
  };

  const cancelCreateLand = () => {
    setCreatingLand(false);
    setSelectedLandId(null);
    setSelectedLand(null);
    setLandDraft(emptyLandDraft());
    void navigate({ to: tabBasePath.lands });
  };

  const cancelCreateBuilding = () => {
    setCreatingBuilding(false);
    setSelectedBuildingId(null);
    setSelectedBuilding(null);
    setBuildingDraft(emptyBuildingDraft());
    void navigate({ to: tabBasePath.buildings });
  };

  const cancelCreateParty = () => {
    setCreatingParty(false);
    setSelectedPartyId(null);
    setSelectedParty(null);
    setPartyDraft(emptyPartyDraft());
    void navigate({ to: tabBasePath.parties });
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
        void navigate({ to: tabDetailPath.zone, params: { id: item.id } });
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

  // 地図上で選択中の区域レイヤ地物を、編集中の区域ドラフトの GIS リンクとして採用する
  const applySelectedFeatureToZoneDraft = () => {
    if (!selectedFeature || !selectedFeatureLayer || !canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)) {
      setNotice("先に地図上の区域レイヤ地物を選択してください");
      return;
    }
    setZoneDraft((current) => ({
      ...current,
      zoneLayerId: selectedFeature.layerId,
      zoneFeatureId: selectedFeature.featureId
    }));
  };

  const removeZone = async () => {
    if (!selectedZone || !window.confirm(`${selectedZone.id} を削除しますか`)) return;
    try {
      setDeletingZone(true);
      await deleteZone(selectedZone.id);
      setSelectedZoneId(null);
      setSelectedZone(null);
      void navigate({ to: tabBasePath.zone });
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
        void navigate({ to: tabDetailPath.lands, params: { id: item.id } });
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
      void navigate({ to: tabBasePath.lands });
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
        void navigate({ to: tabDetailPath.buildings, params: { id: item.id } });
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
      void navigate({ to: tabBasePath.buildings });
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
        void navigate({ to: tabDetailPath.parties, params: { id: item.id } });
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
      void navigate({ to: tabBasePath.parties });
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
    const bbox = mapApiRef.current?.getBoundsBbox();
    if (!bbox) {
      setNotice("地図がまだ準備できていません");
      return;
    }
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
        mapApiRef.current?.resize();
        mapApiRef.current?.focusGeometry(feature.geometry);
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
        mapApiRef.current?.resize();
        mapApiRef.current?.focusGeometry(zoneFeature.geometry);
      }, 80);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  return {
    // ルーティング由来の画面状態と遷移
    activeTab,
    navigateTab,
    selectZone,
    selectLand,
    selectBuilding,
    selectParty,
    // 共有 state
    me,
    projects,
    selectedProject,
    setSelectedProject,
    notice,
    setNotice,
    mapSupportOpen,
    setMapSupportOpen,
    layers,
    layerById,
    layerListItems,
    zoneSourceLayers,
    zones,
    lands,
    buildings,
    parties,
    selectedFeature,
    selectedFeatureLayer,
    // 地図ペイン (MapPane) 連携
    mapApiRef,
    setMapReady,
    handleMapFeatureClick,
    baseMapVisible,
    setBaseMapVisible,
    visibleLayerIds,
    mapHighlightResults,
    loadingLayers,
    deletingLayerIds,
    deletingResultSetIds,
    draggingLayerId,
    setDraggingLayerId,
    refreshLayers,
    toggleLayer,
    toggleLayerGroup,
    requestLayerDelete,
    requestResultSetDelete,
    startLayerDrag,
    dragLayerOver,
    dropLayer,
    businessLinks,
    loadingBusinessLinks,
    featureEditOpen,
    setFeatureEditOpen,
    featurePropertyDraft,
    setFeaturePropertyDraft,
    featureGeometryDraft,
    setFeatureGeometryDraft,
    savingFeature,
    saveSelectedFeature,
    // 画面横断の共通操作
    saveRelationship,
    removeRelationship,
    openSourceFeature,
    useMapBoundsFilter,
    useSelectedFeatureFilter,
    // 区域
    zoneQuery,
    setZoneQuery,
    zoneFilters,
    setZoneFilters,
    zoneFiltersOpen,
    setZoneFiltersOpen,
    selectedZoneId,
    selectedZone,
    zoneDraft,
    setZoneDraft,
    creatingZone,
    loadingZones,
    savingZone,
    deletingZone,
    refreshZones,
    submitZoneListSearch,
    beginCreateZone,
    cancelCreateZone,
    saveZone,
    removeZone,
    openZoneOnMap,
    applySelectedFeatureToZoneDraft,
    zoneSourceLayerId,
    setZoneSourceLayerId,
    zoneUploadFile,
    setZoneUploadFile,
    zoneUploadFormat,
    setZoneUploadFormat,
    zoneUploadSrid,
    setZoneUploadSrid,
    creatingZoneLayer,
    submitZoneFromLayer,
    submitZoneUpload,
    // 区域 GIS 検索 (ZoneSearchPanel)
    analysisName,
    setAnalysisName,
    zoneSearchQuery,
    setZoneSearchQuery,
    conditionBuilderOpen,
    setConditionBuilderOpen,
    attributeConditions,
    setAttributeConditions,
    spatialConditions,
    setSpatialConditions,
    addAttributeCondition,
    addSpatialCondition,
    zoneSearchLinkedOnly,
    setZoneSearchLinkedOnly,
    zoneSpatialLayerIds,
    setZoneSpatialLayerIds,
    zoneBusinessSourceType,
    setZoneBusinessSourceType,
    zoneBusinessQuery,
    setZoneBusinessQuery,
    zoneBusinessStatus,
    setZoneBusinessStatus,
    zoneLandUse,
    setZoneLandUse,
    zoneBuildingUse,
    setZoneBuildingUse,
    zonePartyQuery,
    setZonePartyQuery,
    zonePartyType,
    setZonePartyType,
    zoneRelationType,
    setZoneRelationType,
    loadingZoneSearch,
    savingConditionSearch,
    zoneSearchResults,
    submitZoneSearch,
    saveConditionSearchResult,
    clearZoneSearchConditions,
    openZoneSearchResult,
    // 土地
    landQuery,
    setLandQuery,
    landFilters,
    setLandFilters,
    landFiltersOpen,
    setLandFiltersOpen,
    selectedLandId,
    selectedLand,
    landDraft,
    setLandDraft,
    creatingLand,
    loadingLands,
    savingLand,
    deletingLand,
    refreshLands,
    submitLandListSearch,
    beginCreateLand,
    cancelCreateLand,
    saveLand,
    removeLand,
    // 建物
    buildingQuery,
    setBuildingQuery,
    buildingFilters,
    setBuildingFilters,
    buildingFiltersOpen,
    setBuildingFiltersOpen,
    selectedBuildingId,
    selectedBuilding,
    buildingDraft,
    setBuildingDraft,
    creatingBuilding,
    loadingBuildings,
    savingBuilding,
    deletingBuilding,
    refreshBuildings,
    submitBuildingListSearch,
    beginCreateBuilding,
    cancelCreateBuilding,
    saveBuilding,
    removeBuilding,
    // 関係者
    partyQuery,
    setPartyQuery,
    partyFilters,
    setPartyFilters,
    partyFiltersOpen,
    setPartyFiltersOpen,
    selectedPartyId,
    selectedParty,
    partyDraft,
    setPartyDraft,
    creatingParty,
    loadingParties,
    savingParty,
    deletingParty,
    refreshParties,
    submitPartyListSearch,
    beginCreateParty,
    cancelCreateParty,
    saveParty,
    removeParty
  };
}

// 各画面が AppStateContext 経由で参照する型 (appState.tsx からは型のみ import される)
export type AppState = ReturnType<typeof useAppController>;
