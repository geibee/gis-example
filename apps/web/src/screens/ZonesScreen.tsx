import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppShell } from "../appShell";
import { useBusinessListHighlights, useMapState } from "../mapState";
import { ZoneSearchPanel } from "../components/ZoneSearchPanel";
import { ZoneWorkspace } from "../components/ZoneWorkspace";
import { conditionSearchFeatures } from "../api";
import { keys } from "../queries/keys";
import { useBuildingsQuery } from "../queries/buildings";
import { useAnalysisJobPolling, useCreateAnalysisJobMutation, useCreateImportJobMutation, useImportJobPolling } from "../queries/jobs";
import { useLandsQuery } from "../queries/lands";
import { usePartiesQuery } from "../queries/parties";
import {
  useCreateZoneLayerMutation,
  useCreateZoneMutation,
  useDeleteZoneMutation,
  useUpdateZoneMutation,
  useZoneQuery,
  useZonesQuery
} from "../queries/zones";
import type {
  AttributeConditionDraft,
  ConditionQuery,
  ConditionQueryCondition,
  FeatureSearchResult,
  SpatialConditionDraft,
  Zone,
  ZoneLayerOperation
} from "../types";
import type { ZoneBusinessSourceType, ZoneLayerCreateMetadata } from "../appTypes";
import {
  canCreateZoneLayerFromSource,
  canUseSelectedFeatureAsZoneFeature,
  conditionResultName,
  defaultZoneSpatialLayerIds,
  emptyZoneDraft,
  errorMessage,
  isZoneLayer,
  newZoneDraft,
  normalizeZoneLayerFilter,
  nullableString,
  readZoneDistance,
  toConditionAttributePayload,
  toZoneDraft,
  zoneMetadataFromDraft
} from "../utils";
import { unfilteredCriteria, useBusinessListState, useBusinessObjectScreen } from "./businessScreenState";

// 区域画面: 一覧・詳細・区域レイヤ作成 (取込ジョブ) のサーバ状態はクエリフック、
// GIS 条件検索や取込フォームなどの画面状態はこのファイルで完結する。
export default function ZonesScreen() {
  const { projects, selectedProject, setSelectedProject, setNotice } = useAppShell();
  const map = useMapState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------- 一覧・詳細
  const list = useBusinessListState();
  const zonesQuery = useZonesQuery(selectedProject, list.criteria);
  const zones = useMemo(() => zonesQuery.data ?? [], [zonesQuery.data]);

  const screen = useBusinessObjectScreen({
    useDetailQuery: useZoneQuery,
    toDraft: toZoneDraft,
    emptyDraft: emptyZoneDraft,
    newDraft: newZoneDraft,
    navigateToList: () => void navigate({ to: "/zones" }),
    navigateToDetail: (id) => void navigate({ to: "/zones/$id", params: { id } })
  });

  // 参照用 (条件検索の選択肢) の絞り込みなし一覧
  const landsQuery = useLandsQuery(selectedProject, unfilteredCriteria);
  const buildingsQuery = useBuildingsQuery(selectedProject, unfilteredCriteria);
  const partiesQuery = usePartiesQuery(selectedProject, unfilteredCriteria);

  const createMutation = useCreateZoneMutation();
  const updateMutation = useUpdateZoneMutation();
  const deleteMutation = useDeleteZoneMutation();
  const createZoneLayerMutation = useCreateZoneLayerMutation();
  const createImportJobMutation = useCreateImportJobMutation();
  const createAnalysisJobMutation = useCreateAnalysisJobMutation();

  const zoneLayers = useMemo(() => map.layers.filter(isZoneLayer), [map.layers]);
  const zoneSourceLayers = useMemo(() => map.layers.filter(canCreateZoneLayerFromSource), [map.layers]);

  // 区域レイヤの増減に合わせて一覧フィルタの zoneLayerId を正規化する
  const { setFilters, setCriteria } = list;
  useEffect(() => {
    setFilters((current) => normalizeZoneLayerFilter(current, zoneLayers));
    setCriteria((current) => {
      const nextFilters = normalizeZoneLayerFilter(current.filters, zoneLayers);
      return nextFilters === current.filters ? current : { ...current, filters: nextFilters };
    });
  }, [setCriteria, setFilters, zoneLayers]);

  // ---------------------------------------------------------------- GIS 条件検索
  const [analysisName, setAnalysisName] = useState("");
  const [zoneSearchQuery, setZoneSearchQuery] = useState("");
  const [conditionBuilderOpen, setConditionBuilderOpen] = useState(false);
  const [attributeConditions, setAttributeConditions] = useState<AttributeConditionDraft[]>([]);
  const [spatialConditions, setSpatialConditions] = useState<SpatialConditionDraft[]>([]);
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
  const [loadingZoneSearch, setLoadingZoneSearch] = useState(false);

  useEffect(() => {
    setZoneSpatialLayerIds((current) => {
      const validLayerIds = current.filter((id) => map.layerById.has(id));
      if (validLayerIds.length) {
        return validLayerIds.length === current.length ? current : validLayerIds;
      }
      return defaultZoneSpatialLayerIds(map.layers);
    });
  }, [map.layerById, map.layers]);

  // レイヤ削除・プロジェクト切替で消えたレイヤを参照する条件・結果を掃除する
  useEffect(() => {
    const pruneByLayer = <T extends { layerId: string }>(items: T[]) => {
      const next = items.filter((item) => !item.layerId || map.layerById.has(item.layerId));
      return next.length === items.length ? items : next;
    };
    setAttributeConditions(pruneByLayer);
    setSpatialConditions(pruneByLayer);
    setZoneSearchResults((current) => {
      const next = current.filter((result) => map.layerById.has(result.layerId));
      return next.length === current.length ? current : next;
    });
  }, [map.layerById]);

  const buildConditionQuery = (): ConditionQuery => {
    const targetLayerIds = zoneSpatialLayerIds.filter((id) => map.layerById.has(id));
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

  const submitZoneSearch = async () => {
    if (!selectedProject) return;
    setLoadingZoneSearch(true);
    try {
      const results = await conditionSearchFeatures(buildConditionQuery());
      setZoneSearchResults(results);
      map.setManualMapHighlightResults(results);
      if (!results.length) setNotice("検索結果はありません");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingZoneSearch(false);
    }
  };

  // 条件検索結果の保存は分析ジョブとして実行し、進捗は refetchInterval でポーリングする。
  // 成果物 (結果レイヤ) のキャッシュ無効化はポーリングフック側が行う。
  const analysisPolling = useAnalysisJobPolling({
    onSucceeded: () => {},
    onFailed: (job) => setNotice(job.errorMessage ?? "条件検索結果の保存に失敗しました"),
    onTimeout: () => setNotice("分析ジョブの完了確認がタイムアウトしました。時間をおいてレイヤ一覧を確認してください")
  });

  const saveConditionSearchResult = async () => {
    if (!selectedProject || !zoneSearchResults.length) return;
    try {
      const query = buildConditionQuery();
      const job = await createAnalysisJobMutation.mutateAsync({
        projectId: selectedProject,
        name: conditionResultName(analysisName, query),
        operation: "condition_search",
        conditionQuery: query
      });
      analysisPolling.start(job.id);
      setNotice("条件検索結果の保存を開始しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const clearZoneSearchConditions = () => {
    setZoneSearchQuery("");
    setZoneSpatialLayerIds(defaultZoneSpatialLayerIds(map.layers));
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
    map.setManualMapHighlightResults(null);
    setAnalysisName("");
  };

  const addAttributeCondition = () => {
    const layer = map.layerById.get(zoneSpatialLayerIds[0] ?? "") ?? map.layers[0];
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
    const layer = map.layers.find((item) => !targetIds.has(item.id)) ?? map.layers[0];
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

  // ---------------------------------------------------------------- 区域レイヤ作成 (取込ジョブ)
  const [zoneSourceLayerId, setZoneSourceLayerId] = useState("");
  const [zoneUploadFile, setZoneUploadFile] = useState<File | null>(null);
  const [zoneUploadFormat, setZoneUploadFormat] = useState("geojson");
  const [zoneUploadSrid, setZoneUploadSrid] = useState("4326");
  const [creatingZoneLayer, setCreatingZoneLayer] = useState(false);
  const pendingZoneMetadataRef = useRef<ZoneLayerCreateMetadata>({});

  useEffect(() => {
    setZoneSourceLayerId((current) =>
      zoneSourceLayers.some((layer) => layer.id === current) ? current : zoneSourceLayers[0]?.id ?? ""
    );
  }, [zoneSourceLayers]);

  const openCreatedZoneFromOperation = (result: ZoneLayerOperation) => {
    const createdZone = result.zones[0];
    if (!createdZone) return;
    queryClient.setQueryData(keys.zones.detail(createdZone.id), createdZone);
    screen.afterSave(createdZone);
  };

  const createZoneFromSourceLayer = async (
    layerId: string,
    metadata: ZoneLayerCreateMetadata = {}
  ): Promise<ZoneLayerOperation | null> => {
    if (!selectedProject) return null;
    try {
      // mutateAsync はキャッシュ無効化 (レイヤ・区域一覧の再取得) 完了後に解決するため、
      // この後の zoneLayerId フィルタ設定が正規化で巻き戻されない
      const result = await createZoneLayerMutation.mutateAsync({
        projectId: selectedProject,
        layerId,
        name: metadata.name,
        zoneType: metadata.zoneType,
        status: metadata.status
      });
      setFilters((current) => ({ ...current, zoneLayerId: result.layer.id }));
      map.showLayers([result.layer.id]);
      setNotice(`区域レイヤを作成しました（${result.zonesCreated.toLocaleString()}件作成）`);
      return result;
    } catch (error) {
      setNotice(errorMessage(error));
      return null;
    }
  };

  // 取込ジョブの進捗ポーリング。完了時に取込レイヤから区域レイヤを一括作成する
  const importPolling = useImportJobPolling({
    onSucceeded: async (job) => {
      if (job.layerId) {
        const result = await createZoneFromSourceLayer(job.layerId, pendingZoneMetadataRef.current);
        if (result) openCreatedZoneFromOperation(result);
      } else {
        setNotice("区域データの取込結果を取得できませんでした");
      }
      setCreatingZoneLayer(false);
    },
    onFailed: (job) => {
      setCreatingZoneLayer(false);
      setNotice(job.errorMessage ?? "区域データの取込に失敗しました");
    },
    onTimeout: () => {
      setCreatingZoneLayer(false);
      setNotice("取込ジョブの完了確認がタイムアウトしました。時間をおいてレイヤ一覧を確認してください");
    },
    onError: () => setCreatingZoneLayer(false)
  });

  const submitZoneUpload = async () => {
    if (!selectedProject || !zoneUploadFile) return;
    const formData = new FormData();
    formData.set("projectId", selectedProject);
    formData.set("format", zoneUploadFormat);
    if (zoneUploadSrid.trim()) formData.set("sourceSrid", zoneUploadSrid.trim());
    formData.set("file", zoneUploadFile);
    try {
      setCreatingZoneLayer(true);
      pendingZoneMetadataRef.current = zoneMetadataFromDraft(screen.draft);
      const job = await createImportJobMutation.mutateAsync(formData);
      importPolling.start(job.id);
    } catch (error) {
      setCreatingZoneLayer(false);
      setNotice(errorMessage(error));
    }
  };

  const submitZoneFromLayer = async () => {
    if (!zoneSourceLayerId) return;
    setCreatingZoneLayer(true);
    try {
      const result = await createZoneFromSourceLayer(zoneSourceLayerId, zoneMetadataFromDraft(screen.draft));
      if (result) openCreatedZoneFromOperation(result);
    } finally {
      setCreatingZoneLayer(false);
    }
  };

  // ---------------------------------------------------------------- 区域の保存・削除
  const saveZone = async () => {
    if (!screen.draft.name.trim() || !screen.draft.status.trim()) {
      setNotice("区域名、ステータスは必須です");
      return;
    }
    if (screen.creating && !screen.draft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    if (!(screen.draft.zoneLayerId ?? "").trim() || !(screen.draft.zoneFeatureId ?? "").trim()) {
      setNotice("区域レイヤと地物IDは必須です");
      return;
    }
    try {
      const payload = {
        ...(screen.creating ? { id: screen.draft.id.trim(), projectId: selectedProject } : {}),
        name: screen.draft.name,
        zoneType: nullableString(screen.draft.zoneType),
        status: screen.draft.status,
        memo: nullableString(screen.draft.memo),
        zoneLayerId: screen.draft.zoneLayerId ?? "",
        zoneFeatureId: screen.draft.zoneFeatureId ?? "",
        sourceLayerId: screen.draft.zoneLayerId ?? "",
        sourceFeatureId: screen.draft.zoneFeatureId ?? ""
      };
      const item = screen.creating
        ? await createMutation.mutateAsync(payload)
        : screen.selected
          ? await updateMutation.mutateAsync({ id: screen.selected.id, body: payload })
          : null;
      if (!item) return;
      screen.afterSave(item);
      setNotice(screen.creating ? "区域を作成しました" : "区域を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const removeZone = async () => {
    if (!screen.selected || !window.confirm(`${screen.selected.id} を削除しますか`)) return;
    try {
      await deleteMutation.mutateAsync(screen.selected.id);
      screen.afterDelete();
      setNotice("区域を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  // 地図上で選択中の区域レイヤ地物を、編集中の区域ドラフトの GIS リンクとして採用する
  const applySelectedFeatureToZoneDraft = () => {
    const { selectedFeature, selectedFeatureLayer } = map;
    if (!selectedFeature || !selectedFeatureLayer || !canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)) {
      setNotice("先に地図上の区域レイヤ地物を選択してください");
      return;
    }
    setZoneDraftGisLink(selectedFeature.layerId, selectedFeature.featureId);
  };

  const setZoneDraftGisLink = (zoneLayerId: string, zoneFeatureId: string) => {
    screen.setDraft((current) => ({ ...current, zoneLayerId, zoneFeatureId }));
  };

  // ---------------------------------------------------------------- 地図ハイライト
  const highlightZones = useMemo<Zone[]>(
    () => (screen.selectedId ? (screen.selected ? [screen.selected] : []) : zones),
    [screen.selected, screen.selectedId, zones]
  );
  useBusinessListHighlights({ tab: "zone", zones: highlightZones });

  const focusZoneLayerForSearch = (layerId: string) => setZoneSpatialLayerIds([layerId]);

  return (
    <section className="tab-pane zone-tab active">
      <ZoneWorkspace
        query={list.query}
        setQuery={list.setQuery}
        filters={list.filters}
        setFilters={list.setFilters}
        filtersOpen={list.filtersOpen}
        setFiltersOpen={list.setFiltersOpen}
        items={zones}
        selectedId={screen.selectedId}
        selected={screen.selected}
        draft={screen.draft}
        setDraft={screen.setDraft}
        creating={screen.creating}
        loading={zonesQuery.isFetching}
        saving={createMutation.isPending || updateMutation.isPending}
        deleting={deleteMutation.isPending}
        onRefresh={() => void zonesQuery.refetch()}
        onSearch={list.submit}
        onSelect={screen.select}
        onCreate={screen.beginCreate}
        onCancelCreate={screen.cancelCreate}
        onBackToList={screen.backToList}
        onSave={() => void saveZone()}
        onDelete={() => void removeZone()}
        onOpenLand={(id) => void navigate({ to: "/lands/$id", params: { id } })}
        onOpenBuilding={(id) => void navigate({ to: "/buildings/$id", params: { id } })}
        onOpenParty={(id) => void navigate({ to: "/parties/$id", params: { id } })}
        onShowOnMap={(zone) => void map.openZoneOnMap(zone, { onFocusLayer: focusZoneLayerForSearch })}
        onOpenSourceFeature={(layerId, featureId) =>
          void map.openSourceFeature(layerId, featureId, { onFocusLayer: focusZoneLayerForSearch })
        }
        onUseSelectedFeature={applySelectedFeatureToZoneDraft}
        layers={map.layers}
        selectedFeature={map.selectedFeature}
        selectedFeatureLayer={map.selectedFeatureLayer}
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
            layers={map.layers}
            layerById={map.layerById}
            lands={landsQuery.data ?? []}
            buildings={buildingsQuery.data ?? []}
            parties={partiesQuery.data ?? []}
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
            saving={createAnalysisJobMutation.isPending}
            results={zoneSearchResults}
            selectedFeature={map.selectedFeature}
            onSearch={() => void submitZoneSearch()}
            onSave={() => void saveConditionSearchResult()}
            onClear={clearZoneSearchConditions}
            onSelect={(result) => void map.openFeatureResult(result)}
          />
        }
      />
    </section>
  );
}
