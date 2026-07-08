import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppShell } from "../appShell";
import { useBusinessListHighlights, useMapState } from "../mapState";
import { LandWorkspace } from "../components/LandWorkspace";
import { useBuildingsQuery } from "../queries/buildings";
import {
  useCreateLandMutation,
  useDeleteLandMutation,
  useLandQuery,
  useLandsQuery,
  useUpdateLandMutation
} from "../queries/lands";
import { usePartiesQuery } from "../queries/parties";
import type { Land } from "../types";
import {
  emptyLandDraft,
  errorMessage,
  newLandDraft,
  nullableNumber,
  nullableString,
  toLandDraft
} from "../utils";
import {
  unfilteredCriteria,
  useBusinessListState,
  useBusinessObjectScreen,
  useRelationshipActions
} from "./businessScreenState";

// 土地画面: 一覧・詳細のサーバ状態はクエリフック (queries/lands.ts)、
// 検索条件・編集ドラフトなどの画面状態はこのファイルで完結する。
export default function LandsScreen() {
  const { projects, selectedProject, setSelectedProject, setNotice } = useAppShell();
  const map = useMapState();
  const navigate = useNavigate();

  const list = useBusinessListState();
  const landsQuery = useLandsQuery(selectedProject, list.criteria);
  const lands = useMemo(() => landsQuery.data ?? [], [landsQuery.data]);

  const screen = useBusinessObjectScreen({
    useDetailQuery: useLandQuery,
    toDraft: toLandDraft,
    emptyDraft: emptyLandDraft,
    newDraft: newLandDraft,
    navigateToList: () => void navigate({ to: "/lands" }),
    navigateToDetail: (id) => void navigate({ to: "/lands/$id", params: { id } })
  });

  // 参照用 (関係先候補・リンク表示) の絞り込みなし一覧。キャッシュは画面間で共有される
  const buildingsQuery = useBuildingsQuery(selectedProject, unfilteredCriteria);
  const partiesQuery = usePartiesQuery(selectedProject, unfilteredCriteria);

  const createMutation = useCreateLandMutation();
  const updateMutation = useUpdateLandMutation();
  const deleteMutation = useDeleteLandMutation();
  const { saveRelationship, removeRelationship } = useRelationshipActions();

  const saveLand = async () => {
    if (!screen.draft.lotNumber.trim() || !screen.draft.address.trim() || !screen.draft.status.trim()) {
      setNotice("地番、所在地、ステータスは必須です");
      return;
    }
    if (screen.creating && !screen.draft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    try {
      const payload = {
        ...(screen.creating ? { id: screen.draft.id.trim(), projectId: selectedProject } : {}),
        lotNumber: screen.draft.lotNumber,
        address: screen.draft.address,
        landUse: nullableString(screen.draft.landUse),
        areaSqm: nullableNumber(screen.draft.areaSqm, "面積"),
        registeredOwner: nullableString(screen.draft.registeredOwner),
        rightType: nullableString(screen.draft.rightType),
        registrationCause: nullableString(screen.draft.registrationCause),
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
      setNotice(screen.creating ? "土地を作成しました" : "土地を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const removeLand = async () => {
    if (!screen.selected || !window.confirm(`${screen.selected.id} を削除しますか`)) return;
    try {
      await deleteMutation.mutateAsync(screen.selected.id);
      screen.afterDelete();
      setNotice("土地を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  // 一覧・選択中オブジェクトを地図ハイライトへ反映する
  const highlightLands = useMemo<Land[]>(
    () => (screen.selectedId ? (screen.selected ? [screen.selected] : []) : lands),
    [lands, screen.selected, screen.selectedId]
  );
  useBusinessListHighlights({ tab: "lands", lands: highlightLands });

  return (
    <section className="tab-pane active">
      <LandWorkspace
        query={list.query}
        setQuery={list.setQuery}
        filters={list.filters}
        setFilters={list.setFilters}
        filtersOpen={list.filtersOpen}
        setFiltersOpen={list.setFiltersOpen}
        items={lands}
        selectedId={screen.selectedId}
        selected={screen.selected}
        draft={screen.draft}
        setDraft={screen.setDraft}
        creating={screen.creating}
        loading={landsQuery.isFetching}
        saving={createMutation.isPending || updateMutation.isPending}
        deleting={deleteMutation.isPending}
        onRefresh={() => void landsQuery.refetch()}
        onSearch={list.submit}
        onSelect={screen.select}
        onCreate={screen.beginCreate}
        onCancelCreate={screen.cancelCreate}
        onBackToList={screen.backToList}
        onSave={() => void saveLand()}
        onDelete={() => void removeLand()}
        onOpenBuilding={(id) => void navigate({ to: "/buildings/$id", params: { id } })}
        onOpenParty={(id) => void navigate({ to: "/parties/$id", params: { id } })}
        onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
        onUseMapBounds={() => map.applyMapBoundsFilter(list.setFilters)}
        onUseSelectedFeature={() => map.applySelectedFeatureFilter(list.setFilters)}
        onOpenSourceFeature={(layerId, featureId) => void map.openSourceFeature(layerId, featureId)}
        layers={map.layers}
        parties={partiesQuery.data ?? []}
        buildings={buildingsQuery.data ?? []}
        selectedFeature={map.selectedFeature}
        selectedFeatureLayer={map.selectedFeatureLayer}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={setSelectedProject}
      />
    </section>
  );
}
