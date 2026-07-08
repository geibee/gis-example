import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from "react";
import { useRouterState } from "@tanstack/react-router";
import { getBuilding, getFeature, getLand, getLayers, getZone } from "./api";
import { useAppShell } from "./appShell";
import { activeScreenMeta } from "./routeMeta";
import { useBusinessLinksQuery, useUpdateFeatureMutation } from "./queries/features";
import { useDeleteLayerMutation, useDeleteResultSetMutation, useLayersQuery } from "./queries/layers";
import type { Building, BusinessObjectFilters, Feature, FeatureSearchResult, Land, Layer, Party, Zone } from "./types";
import type { BusinessTab, LayerListItem, MapPaneApi } from "./appTypes";
import { businessMapHighlightLimit, emptyBusinessLinks } from "./constants";
import {
  buildBusinessMapTargets,
  editableFeatureAttributes,
  errorMessage,
  formatEditorValue,
  groupLayerListItems,
  moveLayerBefore,
  orderLayers,
  parseEditedProperty,
  readLayerViewState,
  restoreVisibleLayerIds,
  uniqueBusinessMapTargets,
  writeLayerViewState
} from "./utils";

// 各画面が「一覧・選択中オブジェクト」を地図ハイライトへ反映するための入力。
// 画面側は useBusinessListHighlights 経由で自分のタブ分だけを供給する。
export type BusinessHighlightInput = {
  tab: BusinessTab;
  zones?: Zone[];
  lands?: Land[];
  buildings?: Building[];
  parties?: Party[];
};

export type ZoneMapFocusOptions = {
  // フォーカスした区域レイヤを画面側の状態 (GIS 検索の対象レイヤ等) に反映したい場合に使う
  onFocusLayer?: (layerId: string) => void;
};

// 地図ペイン (MapPane) と全画面が共有する地図まわりの状態・操作。
// レイヤ一覧はサーバ状態 (useLayersQuery) を正とし、並び順・表示状態などの
// クライアント状態のみをここで管理する。
function useMapController() {
  const { selectedProject, setNotice, setMapSupportOpen, mapSupportOpen } = useAppShell();
  const activeTab = useRouterState({ select: (state) => activeScreenMeta(state.matches)?.tab ?? "zone" });

  const mapApiRef = useRef<MapPaneApi | null>(null);
  const layersRef = useRef<Layer[]>([]);
  const loadedLayerProjectId = useRef<string | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [baseMapVisible, setBaseMapVisible] = useState(true);
  const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(new Set());
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [deletingLayerIds, setDeletingLayerIds] = useState<Set<string>>(new Set());
  const [deletingResultSetIds, setDeletingResultSetIds] = useState<Set<string>>(new Set());
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
  const [selectedFeatureLayer, setSelectedFeatureLayer] = useState<Layer | null>(null);
  const [featureEditOpen, setFeatureEditOpen] = useState(false);
  const [featurePropertyDraft, setFeaturePropertyDraft] = useState<Record<string, string>>({});
  const [featureGeometryDraft, setFeatureGeometryDraft] = useState("");
  const [highlightInput, setHighlightInput] = useState<BusinessHighlightInput | null>(null);
  const [listMapHighlightResults, setListMapHighlightResults] = useState<FeatureSearchResult[]>([]);
  const [manualMapHighlightResults, setManualMapHighlightResults] = useState<FeatureSearchResult[] | null>(null);
  const mapHighlightResults = manualMapHighlightResults ?? listMapHighlightResults;

  const layersQuery = useLayersQuery(selectedProject);
  const deleteLayerMutation = useDeleteLayerMutation();
  const deleteResultSetMutation = useDeleteResultSetMutation();
  const updateFeatureMutation = useUpdateFeatureMutation();

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
  const layerListItems = useMemo<LayerListItem[]>(() => groupLayerListItems(layers), [layers]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // サーバのレイヤ一覧 (クエリ) → クライアントの並び順・表示状態へ反映する。
  // 並び順と表示レイヤは localStorage のビュー状態を正として復元する。
  useEffect(() => {
    const nextLayers = layersQuery.data;
    if (!nextLayers || !selectedProject) return;
    const savedViewState = readLayerViewState(selectedProject);
    const previousLayers = loadedLayerProjectId.current === selectedProject ? layersRef.current : [];
    const previousLayerIds = new Set(previousLayers.map((layer) => layer.id));
    const orderedLayers = orderLayers(nextLayers, savedViewState?.layerOrder ?? previousLayers.map((layer) => layer.id));
    loadedLayerProjectId.current = selectedProject;
    if (typeof savedViewState?.baseMapVisible === "boolean") {
      setBaseMapVisible(savedViewState.baseMapVisible);
    }
    setLayers(orderedLayers);
    setVisibleLayerIds((current) => restoreVisibleLayerIds(orderedLayers, savedViewState, previousLayerIds, current));
  }, [layersQuery.data, selectedProject]);

  useEffect(() => {
    if (!selectedProject || loadedLayerProjectId.current !== selectedProject) return;
    writeLayerViewState(selectedProject, {
      baseMapVisible,
      visibleLayerIds: layers.filter((layer) => visibleLayerIds.has(layer.id)).map((layer) => layer.id),
      layerOrder: layers.map((layer) => layer.id)
    });
  }, [baseMapVisible, layers, selectedProject, visibleLayerIds]);

  // レイヤ削除・プロジェクト切替でレイヤが消えたら、そのレイヤに依存する地図状態を掃除する
  useEffect(() => {
    setSelectedFeature((current) => (current && !layerById.has(current.layerId) ? null : current));
    setSelectedFeatureLayer((current) => (current && !layerById.has(current.id) ? null : current));
    const prune = (results: FeatureSearchResult[]) => results.filter((result) => layerById.has(result.layerId));
    setListMapHighlightResults((current) => {
      const next = prune(current);
      return next.length === current.length ? current : next;
    });
    setManualMapHighlightResults((current) => {
      if (!current) return current;
      const next = prune(current);
      return next.length === current.length ? current : next;
    });
  }, [layerById]);

  useEffect(() => {
    window.setTimeout(() => mapApiRef.current?.resize(), 0);
  }, [activeTab, mapSupportOpen]);

  // ---------------------------------------------------------------- レイヤ操作

  const toggleLayer = useCallback((layerId: string) => {
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }, []);

  const toggleLayerGroup = useCallback((layerIds: string[]) => {
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      const allVisible = layerIds.every((layerId) => next.has(layerId));
      for (const layerId of layerIds) {
        if (allVisible) next.delete(layerId);
        else next.add(layerId);
      }
      return next;
    });
  }, []);

  const showLayers = useCallback((layerIds: string[]) => {
    setVisibleLayerIds((current) => new Set([...current, ...layerIds]));
  }, []);

  const requestLayerDelete = useCallback(
    async (layer: Layer) => {
      if (!window.confirm(`レイヤ「${layer.name}」を削除します。実体テーブルも削除されます。よろしいですか？`)) {
        return;
      }
      setDeletingLayerIds((current) => new Set([...current, layer.id]));
      try {
        await deleteLayerMutation.mutateAsync(layer.id);
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
    },
    [deleteLayerMutation, setNotice]
  );

  const requestResultSetDelete = useCallback(
    async (resultSet: Extract<LayerListItem, { type: "resultSet" }>) => {
      if (
        !window.confirm(
          `条件検索結果「${resultSet.name}」を削除します。配下の${resultSet.layers.length.toLocaleString()}レイヤと実体テーブルも削除されます。よろしいですか？`
        )
      ) {
        return;
      }
      setDeletingResultSetIds((current) => new Set([...current, resultSet.id]));
      try {
        await deleteResultSetMutation.mutateAsync(resultSet.id);
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
    },
    [deleteResultSetMutation, setNotice]
  );

  const startLayerDrag = useCallback((event: DragEvent<HTMLDivElement>, layerId: string) => {
    setDraggingLayerId(layerId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
  }, []);

  const dragLayerOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const dropLayer = useCallback(
    (event: DragEvent<HTMLDivElement>, targetLayerId: string) => {
      event.preventDefault();
      const sourceLayerId = event.dataTransfer.getData("text/plain") || draggingLayerId;
      setDraggingLayerId(null);
      if (!sourceLayerId || sourceLayerId === targetLayerId) return;
      setLayers((current) => moveLayerBefore(current, sourceLayerId, targetLayerId));
    },
    [draggingLayerId]
  );

  // ---------------------------------------------------------------- 地物選択・編集

  const handleMapFeatureClick = useCallback(
    async (layer: Layer, featureId: string) => {
      try {
        const feature = await getFeature(layer.id, featureId);
        setSelectedFeature(feature);
        setSelectedFeatureLayer(layer);
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [setNotice]
  );

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

  const businessLinksQuery = useBusinessLinksQuery(selectedFeatureLayer?.id, selectedFeature?.featureId);
  const businessLinks = businessLinksQuery.data ?? emptyBusinessLinks;
  const loadingBusinessLinks = businessLinksQuery.isLoading;

  const saveSelectedFeature = useCallback(async () => {
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
      const feature = await updateFeatureMutation.mutateAsync({
        layerId: selectedFeatureLayer.id,
        featureId: selectedFeature.featureId,
        body: { properties, geometry }
      });
      setSelectedFeature(feature);
      mapApiRef.current?.reloadLayerSource(selectedFeatureLayer.id);
      setNotice("地物を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [featureGeometryDraft, featurePropertyDraft, selectedFeature, selectedFeatureLayer, setNotice, updateFeatureMutation]);

  // ---------------------------------------------------------------- 業務オブジェクトの地図ハイライト

  // 画面からのハイライト入力更新。入力が変わる (一覧・選択の変化) タイミングで
  // 手動ハイライト (区域の地図表示・GIS 検索結果) は解除する。
  const setBusinessHighlightInput = useCallback((input: BusinessHighlightInput | null) => {
    setManualMapHighlightResults(null);
    setHighlightInput(input);
  }, []);

  useEffect(() => {
    if (!selectedProject || !highlightInput) {
      setListMapHighlightResults([]);
      return;
    }
    let active = true;
    const syncBusinessListResults = async () => {
      const targets = uniqueBusinessMapTargets(
        await buildBusinessMapTargets({
          tab: highlightInput.tab,
          zones: highlightInput.zones ?? [],
          lands: highlightInput.lands ?? [],
          buildings: highlightInput.buildings ?? [],
          parties: highlightInput.parties ?? [],
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
  }, [highlightInput, layerById, mapReady, selectedProject]);

  // ---------------------------------------------------------------- 画面横断の地図操作

  // 業務オブジェクトの GIS リンク (ソース地物) を地図上で開く
  const openSourceFeature = useCallback(
    async (sourceLayerId?: string | null, sourceFeatureId?: string | null, options: ZoneMapFocusOptions = {}) => {
      if (!sourceLayerId || !sourceFeatureId) {
        setNotice("GISリンクがありません");
        return;
      }
      try {
        const feature = await getFeature(sourceLayerId, sourceFeatureId);
        const layer =
          layerById.get(sourceLayerId) ?? (await getLayers(selectedProject)).find((item) => item.id === sourceLayerId) ?? null;
        setSelectedFeature(feature);
        setSelectedFeatureLayer(layer);
        setMapSupportOpen(true);
        if (layer) {
          showLayers([layer.id]);
          options.onFocusLayer?.(layer.id);
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
    },
    [layerById, selectedProject, setMapSupportOpen, setNotice, showLayers]
  );

  // 区域とその区域内の土地・建物をまとめて地図表示する
  const openZoneOnMap = useCallback(
    async (zone: Zone, options: ZoneMapFocusOptions = {}) => {
      try {
        setMapSupportOpen(true);
        const zoneLayerId = zone.zoneLayerId ?? zone.sourceLayerId;
        const zoneFeatureId = zone.zoneFeatureId ?? zone.sourceFeatureId;
        const layer =
          layerById.get(zoneLayerId) ?? (await getLayers(selectedProject)).find((item) => item.id === zoneLayerId) ?? null;
        const zoneFeature = await getFeature(zoneLayerId, zoneFeatureId);
        setSelectedFeature(zoneFeature);
        setSelectedFeatureLayer(layer);
        if (layer) {
          showLayers([layer.id]);
          options.onFocusLayer?.(layer.id);
        }

        const zoneDetail = zone.lands?.length || zone.buildings?.length ? zone : await getZone(zone.id);
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
    },
    [layerById, selectedProject, setMapSupportOpen, setNotice, showLayers]
  );

  // 検索結果 (FeatureSearchResult) の地物を地図上で開く
  const openFeatureResult = useCallback(
    async (result: FeatureSearchResult) => {
      const layer = layerById.get(result.layerId);
      if (!layer) {
        setNotice("検索結果のレイヤを取得できませんでした");
        return;
      }
      try {
        showLayers([result.layerId]);
        const feature = await getFeature(result.layerId, result.featureId);
        setSelectedFeature(feature);
        setSelectedFeatureLayer(layer);
        mapApiRef.current?.focusGeometry(feature.geometry);
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [layerById, setNotice, showLayers]
  );

  // 一覧検索フィルタへ「地図の表示範囲」「選択中の地物」を反映する共通処理
  const applyMapBoundsFilter = useCallback(
    (setter: (update: (current: BusinessObjectFilters) => BusinessObjectFilters) => void) => {
      const bbox = mapApiRef.current?.getBoundsBbox();
      if (!bbox) {
        setNotice("地図がまだ準備できていません");
        return;
      }
      setter((current) => ({ ...current, bbox }));
    },
    [setNotice]
  );

  const applySelectedFeatureFilter = useCallback(
    (setter: (update: (current: BusinessObjectFilters) => BusinessObjectFilters) => void) => {
      if (!selectedFeature || !selectedFeatureLayer) {
        setNotice("先に地図上の地物を選択してください");
        return;
      }
      setter((current) => ({
        ...current,
        intersectsLayerId: selectedFeature.layerId,
        intersectsFeatureId: selectedFeature.featureId
      }));
    },
    [selectedFeature, selectedFeatureLayer, setNotice]
  );

  return {
    // MapPane 連携
    mapApiRef,
    setMapReady,
    handleMapFeatureClick,
    // レイヤ (サーバ状態 + クライアント側ビュー状態)
    layers,
    layerById,
    layerListItems,
    loadingLayers: layersQuery.isFetching,
    refetchLayers: () => void layersQuery.refetch(),
    baseMapVisible,
    setBaseMapVisible,
    visibleLayerIds,
    showLayers,
    toggleLayer,
    toggleLayerGroup,
    draggingLayerId,
    setDraggingLayerId,
    deletingLayerIds,
    deletingResultSetIds,
    requestLayerDelete,
    requestResultSetDelete,
    startLayerDrag,
    dragLayerOver,
    dropLayer,
    // 選択地物と編集
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
    savingFeature: updateFeatureMutation.isPending,
    saveSelectedFeature,
    // 業務オブジェクトのハイライトと画面横断の地図操作
    mapHighlightResults,
    setManualMapHighlightResults,
    setBusinessHighlightInput,
    openSourceFeature,
    openZoneOnMap,
    openFeatureResult,
    applyMapBoundsFilter,
    applySelectedFeatureFilter
  };
}

export type MapState = ReturnType<typeof useMapController>;

const MapStateContext = createContext<MapState | null>(null);

export function MapStateProvider({ children }: { children: ReactNode }) {
  const value = useMapController();
  return <MapStateContext.Provider value={value}>{children}</MapStateContext.Provider>;
}

export function useMapState(): MapState {
  const state = useContext(MapStateContext);
  if (!state) {
    throw new Error("MapStateContext が提供されていません (MapStateProvider 配下でのみ使用できます)");
  }
  return state;
}

// 画面の一覧・選択中オブジェクトを地図ハイライトへ供給する。
// アンマウント時 (タブ離脱) には入力を解除してハイライトを消す。
export function useBusinessListHighlights(input: BusinessHighlightInput) {
  const { setBusinessHighlightInput } = useMapState();
  const { tab, zones, lands, buildings, parties } = input;
  useEffect(() => {
    setBusinessHighlightInput({ tab, zones, lands, buildings, parties });
  }, [buildings, lands, parties, setBusinessHighlightInput, tab, zones]);
  useEffect(() => () => setBusinessHighlightInput(null), [setBusinessHighlightInput]);
}
