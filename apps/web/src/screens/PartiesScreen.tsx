import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppShell } from "../appShell";
import { useBusinessListHighlights } from "../mapState";
import { PartyWorkspace } from "../components/PartyWorkspace";
import { useBuildingsQuery } from "../queries/buildings";
import { useLandsQuery } from "../queries/lands";
import {
  useCreatePartyMutation,
  useDeletePartyMutation,
  usePartiesQuery,
  usePartyQuery,
  useUpdatePartyMutation
} from "../queries/parties";
import type { Party } from "../contracts";
import { emptyPartyDraft, errorMessage, newPartyDraft, nullableString, parsePartyTags, toPartyDraft } from "../utils";
import {
  unfilteredCriteria,
  useBusinessListState,
  useBusinessObjectScreen,
  useRelationshipActions
} from "./businessScreenState";

// 関係者画面: 一覧・詳細のサーバ状態はクエリフック (queries/parties.ts)、
// 検索条件・編集ドラフトなどの画面状態はこのファイルで完結する。
export default function PartiesScreen() {
  const { projects, selectedProject, setSelectedProject, setNotice } = useAppShell();
  const navigate = useNavigate();

  const list = useBusinessListState();
  const partiesQuery = usePartiesQuery(selectedProject, list.criteria);
  const parties = useMemo(() => partiesQuery.data ?? [], [partiesQuery.data]);

  const screen = useBusinessObjectScreen({
    useDetailQuery: usePartyQuery,
    toDraft: toPartyDraft,
    emptyDraft: emptyPartyDraft,
    newDraft: newPartyDraft,
    navigateToList: () => void navigate({ to: "/parties" }),
    navigateToDetail: (id) => void navigate({ to: "/parties/$id", params: { id } })
  });

  // 関係先候補 (土地・建物)。地図ハイライトの解決にも使う
  const landsQuery = useLandsQuery(selectedProject, unfilteredCriteria);
  const buildingsQuery = useBuildingsQuery(selectedProject, unfilteredCriteria);
  const lands = useMemo(() => landsQuery.data ?? [], [landsQuery.data]);
  const buildings = useMemo(() => buildingsQuery.data ?? [], [buildingsQuery.data]);

  const createMutation = useCreatePartyMutation();
  const updateMutation = useUpdatePartyMutation();
  const deleteMutation = useDeletePartyMutation();
  const { saveRelationship, removeRelationship } = useRelationshipActions();

  const saveParty = async () => {
    if (!screen.draft.name.trim() || !screen.draft.partyType.trim()) {
      setNotice("名称、種別は必須です");
      return;
    }
    if (screen.creating && !screen.draft.id.trim()) {
      setNotice("IDは必須です");
      return;
    }
    try {
      const payload = {
        ...(screen.creating ? { id: screen.draft.id.trim(), projectId: selectedProject } : {}),
        name: screen.draft.name,
        partyType: screen.draft.partyType,
        contact: nullableString(screen.draft.contact),
        address: nullableString(screen.draft.address),
        memo: nullableString(screen.draft.memo),
        tags: parsePartyTags(screen.draft.tags)
      };
      const item = screen.creating
        ? await createMutation.mutateAsync(payload)
        : screen.selected
          ? await updateMutation.mutateAsync({ id: screen.selected.id, body: payload })
          : null;
      if (!item) return;
      screen.afterSave(item);
      setNotice(screen.creating ? "関係者を作成しました" : "関係者を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const removeParty = async () => {
    if (!screen.selected || !window.confirm(`${screen.selected.id} を削除しますか`)) return;
    try {
      await deleteMutation.mutateAsync(screen.selected.id);
      screen.afterDelete();
      setNotice("関係者を削除しました");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const highlightParties = useMemo<Party[]>(
    () => (screen.selectedId ? (screen.selected ? [screen.selected] : []) : parties),
    [parties, screen.selected, screen.selectedId]
  );
  useBusinessListHighlights({ tab: "parties", parties: highlightParties, lands, buildings });

  return (
    <section className="tab-pane active">
      <PartyWorkspace
        query={list.query}
        setQuery={list.setQuery}
        filters={list.filters}
        setFilters={list.setFilters}
        filtersOpen={list.filtersOpen}
        setFiltersOpen={list.setFiltersOpen}
        items={parties}
        lands={lands}
        buildings={buildings}
        selectedId={screen.selectedId}
        selected={screen.selected}
        draft={screen.draft}
        setDraft={screen.setDraft}
        creating={screen.creating}
        loading={partiesQuery.isFetching}
        saving={createMutation.isPending || updateMutation.isPending}
        deleting={deleteMutation.isPending}
        onRefresh={() => void partiesQuery.refetch()}
        onSearch={list.submit}
        onSelect={screen.select}
        onCreate={screen.beginCreate}
        onCancelCreate={screen.cancelCreate}
        onBackToList={screen.backToList}
        onSave={() => void saveParty()}
        onDelete={() => void removeParty()}
        onOpenLand={(id) => void navigate({ to: "/lands/$id", params: { id } })}
        onOpenBuilding={(id) => void navigate({ to: "/buildings/$id", params: { id } })}
        onSaveRelationship={(relationshipId, relationshipDraft) => void saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void removeRelationship(relationshipId)}
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={setSelectedProject}
      />
    </section>
  );
}
