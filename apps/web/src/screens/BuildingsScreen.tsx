import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppShell } from "../appShell";
import { useBusinessListHighlights, useMapState } from "../mapState";
import { notifyError, notifyInfo, notifySuccess } from "../notifications";
import { confirmDialog } from "../ui/ConfirmDialog";
import { BuildingWorkspace } from "../components/BuildingWorkspace";
import {
  useBuildingQuery,
  useBuildingsQuery,
  useCreateBuildingMutation,
  useDeleteBuildingMutation,
  useImportBuildingsMutation,
  useUpdateBuildingMutation
} from "../queries/buildings";
import { useCreateImportJobMutation, useImportJobPolling } from "../queries/jobs";
import { useLandsQuery } from "../queries/lands";
import { usePartiesQuery } from "../queries/parties";
import type { Building } from "../contracts";
import {
  emptyBuildingDraft,
  errorMessage,
  newBuildingDraft,
  nullableInteger,
  nullableNumber,
  nullableString,
  toBuildingDraft
} from "../utils";
import {
  unfilteredCriteria,
  useBusinessListState,
  useBusinessObjectScreen,
  useRelationshipActions
} from "./businessScreenState";

// 建物画面: 一覧・詳細のサーバ状態はクエリフック (queries/buildings.ts)、
// 検索条件・編集ドラフトなどの画面状態はこのファイルで完結する。
export default function BuildingsScreen() {
  const { projects, selectedProject, setSelectedProject } = useAppShell();
  const map = useMapState();
  const navigate = useNavigate();

  const list = useBusinessListState();
  const buildingsQuery = useBuildingsQuery(selectedProject, list.criteria);
  const buildings = useMemo(() => buildingsQuery.data ?? [], [buildingsQuery.data]);

  const screen = useBusinessObjectScreen({
    useDetailQuery: useBuildingQuery,
    toDraft: toBuildingDraft,
    emptyDraft: emptyBuildingDraft,
    newDraft: newBuildingDraft,
    navigateToList: () => void navigate({ to: "/buildings" }),
    navigateToDetail: (id) => void navigate({ to: "/buildings/$id", params: { id } })
  });

  // 参照用 (リンク先土地・関係者候補) の絞り込みなし一覧
  const landsQuery = useLandsQuery(selectedProject, unfilteredCriteria);
  const partiesQuery = usePartiesQuery(selectedProject, unfilteredCriteria);

  const createMutation = useCreateBuildingMutation();
  const updateMutation = useUpdateBuildingMutation();
  const deleteMutation = useDeleteBuildingMutation();
  const createImportJobMutation = useCreateImportJobMutation();
  const importBuildingsMutation = useImportBuildingsMutation();
  const [importingGeoJson, setImportingGeoJson] = useState(false);
  const importProjectRef = useRef("");
  const { saveRelationship, removeRelationship } = useRelationshipActions();

  const importPolling = useImportJobPolling({
    onSucceeded: async (job) => {
      if (!job.layerId) {
        setImportingGeoJson(false);
        notifyError("建物データの取込結果を取得できませんでした");
        return;
      }
      try {
        const result = await importBuildingsMutation.mutateAsync({
          projectId: importProjectRef.current,
          layerId: job.layerId
        });
        const skipped = result.skippedCount ? `、${result.skippedCount.toLocaleString()}件スキップ` : "";
        notifySuccess(
          `建物を取り込みました（${result.createdCount.toLocaleString()}件追加、${result.updatedCount.toLocaleString()}件更新${skipped}）`
        );
      } catch (error) {
        notifyError(errorMessage(error));
      } finally {
        setImportingGeoJson(false);
      }
    },
    onFailed: (job) => {
      setImportingGeoJson(false);
      notifyError(job.errorMessage ?? "建物GeoJSONの取込に失敗しました");
    },
    onTimeout: () => {
      setImportingGeoJson(false);
      notifyInfo("取込ジョブの完了確認がタイムアウトしました。時間をおいてレイヤ一覧を確認してください");
    },
    onError: () => setImportingGeoJson(false)
  });

  const importBuildingGeoJson = async (file: File) => {
    if (!selectedProject) return;
    const formData = new FormData();
    formData.set("projectId", selectedProject);
    formData.set("format", "geojson");
    formData.set("sourceSrid", "4326");
    formData.set("file", file);
    try {
      setImportingGeoJson(true);
      importProjectRef.current = selectedProject;
      const job = await createImportJobMutation.mutateAsync(formData);
      importPolling.start(job.id);
    } catch (error) {
      setImportingGeoJson(false);
      notifyError(errorMessage(error));
    }
  };

  const saveBuilding = async () => {
    if (!screen.draft.name.trim() || !screen.draft.status.trim()) {
      notifyError("建物名、ステータスは必須です");
      return;
    }
    if (screen.creating && !screen.draft.id.trim()) {
      notifyError("IDは必須です");
      return;
    }
    try {
      const payload = {
        ...(screen.creating ? { id: screen.draft.id.trim(), projectId: selectedProject } : {}),
        landId: nullableString(screen.draft.landId),
        name: screen.draft.name,
        buildingLocation: nullableString(screen.draft.buildingLocation),
        houseNumber: nullableString(screen.draft.houseNumber),
        buildingUse: nullableString(screen.draft.buildingUse),
        floors: nullableInteger(screen.draft.floors, "階数"),
        totalFloorAreaSqm: nullableNumber(screen.draft.totalFloorAreaSqm, "延床面積"),
        structure: nullableString(screen.draft.structure),
        registeredOwner: nullableString(screen.draft.registeredOwner),
        rightType: nullableString(screen.draft.rightType),
        registrationAcceptedOn: nullableString(screen.draft.registrationAcceptedOn),
        status: screen.draft.status,
        memo: nullableString(screen.draft.memo),
        sourceLayerId: nullableString(screen.draft.sourceLayerId),
        sourceFeatureId: nullableString(screen.draft.sourceFeatureId)
      };
      const item = screen.creating
        ? await createMutation.mutateAsync(payload)
        : screen.selected
          ? await updateMutation.mutateAsync({ id: screen.selected.id, body: payload })
          : null;
      if (!item) return;
      screen.afterSave(item);
      notifySuccess(screen.creating ? "建物を作成しました" : "建物を保存しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const removeBuilding = async () => {
    if (!screen.selected) return;
    const confirmed = await confirmDialog({
      title: "建物の削除",
      message: `${screen.selected.id} を削除しますか`,
      confirmLabel: "削除",
      danger: true
    });
    if (!confirmed) return;
    try {
      await deleteMutation.mutateAsync(screen.selected.id);
      screen.afterDelete();
      notifySuccess("建物を削除しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const highlightBuildings = useMemo<Building[]>(
    () => (screen.selectedId ? (screen.selected ? [screen.selected] : []) : buildings),
    [buildings, screen.selected, screen.selectedId]
  );
  useBusinessListHighlights({ tab: "buildings", buildings: highlightBuildings });

  return (
    <section className="tab-pane active">
      <BuildingWorkspace
        query={list.query}
        setQuery={list.setQuery}
        filters={list.filters}
        setFilters={list.setFilters}
        filtersOpen={list.filtersOpen}
        setFiltersOpen={list.setFiltersOpen}
        items={buildings}
        lands={landsQuery.data ?? []}
        selectedId={screen.selectedId}
        selected={screen.selected}
        draft={screen.draft}
        setDraft={screen.setDraft}
        creating={screen.creating}
        loading={buildingsQuery.isFetching}
        saving={createMutation.isPending || updateMutation.isPending}
        deleting={deleteMutation.isPending}
        onRefresh={() => void buildingsQuery.refetch()}
        onSearch={list.submit}
        onSelect={screen.select}
        onCreate={screen.beginCreate}
        importing={importingGeoJson}
        onImportGeoJson={(file) => void importBuildingGeoJson(file)}
        onCancelCreate={screen.cancelCreate}
        onBackToList={screen.backToList}
        onSave={() => void saveBuilding()}
        onDelete={() => void removeBuilding()}
        onOpenLand={(id) => void navigate({ to: "/lands/$id", params: { id } })}
        onOpenParty={(id) => void navigate({ to: "/parties/$id", params: { id } })}
        onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
        onUseMapBounds={() => map.applyMapBoundsFilter(list.setFilters)}
        onUseSelectedFeature={() => map.applySelectedFeatureFilter(list.setFilters)}
        onOpenSourceFeature={(layerId, featureId) => void map.openSourceFeature(layerId, featureId)}
        layers={map.layers}
        parties={partiesQuery.data ?? []}
        selectedFeature={map.selectedFeature}
        selectedFeatureLayer={map.selectedFeatureLayer}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={setSelectedProject}
      />
    </section>
  );
}
