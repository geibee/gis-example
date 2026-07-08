import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppShell } from "../appShell";
import { useBusinessListHighlights, useMapState } from "../mapState";
import { BuildingWorkspace } from "../components/BuildingWorkspace";
import {
  useBuildingQuery,
  useBuildingsQuery,
  useCreateBuildingMutation,
  useDeleteBuildingMutation,
  useUpdateBuildingMutation
} from "../queries/buildings";
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
  const { projects, selectedProject, setSelectedProject, setNotice } = useAppShell();
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
  const { saveRelationship, removeRelationship } = useRelationshipActions();

  const saveBuilding = async () => {
    if (!screen.draft.name.trim() || !screen.draft.status.trim()) {
      setNotice("建物名、ステータスは必須です");
      return;
    }
    if (screen.creating && !screen.draft.id.trim()) {
      setNotice("IDは必須です");
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
      setNotice(screen.creating ? "建物を作成しました" : "建物を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const removeBuilding = async () => {
    if (!screen.selected || !window.confirm(`${screen.selected.id} を削除しますか`)) return;
    try {
      await deleteMutation.mutateAsync(screen.selected.id);
      screen.afterDelete();
      setNotice("建物を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
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
