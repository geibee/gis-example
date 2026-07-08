import { useCallback, useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useAppShell } from "../appShell";
import { activeScreenObjectId } from "../routeMeta";
import {
  useDeleteRelationshipMutation,
  useSaveRelationshipMutation
} from "../queries/parties";
import type { BusinessListSearchCriteria, BusinessObjectFilters, RelationshipDraft } from "../appTypes";
import { emptyBusinessListSearchCriteria, errorMessage, nullableString, toBusinessListSearchCriteria } from "../utils";

// 参照用 (選択肢・関係先候補など) に使う「絞り込みなし一覧」の共有条件。
// 同一参照を使うことでクエリキーが画面間で一致し、キャッシュが共有される。
export const unfilteredCriteria: BusinessListSearchCriteria = { query: "", filters: {} };

// 一覧の検索ボックス・フィルタ・確定済み検索条件 (クエリキーになる) を持つ画面ローカル state
export function useBusinessListState() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<BusinessObjectFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [criteria, setCriteria] = useState<BusinessListSearchCriteria>(emptyBusinessListSearchCriteria);
  const submit = useCallback(() => {
    setCriteria(toBusinessListSearchCriteria(query, filters));
  }, [filters, query]);
  return { query, setQuery, filters, setFilters, filtersOpen, setFiltersOpen, criteria, setCriteria, submit };
}

// 「URL の $id を唯一の正」とする選択・新規作成・編集ドラフトの画面ローカル state。
// 詳細取得は呼び出し側のクエリフック (useDetailQuery) に委譲する。
export function useBusinessObjectScreen<TItem extends { id: string }, TDraft>(options: {
  useDetailQuery: (id: string | null) => { data: TItem | undefined };
  toDraft: (item: TItem) => TDraft;
  emptyDraft: () => TDraft;
  newDraft: () => TDraft;
  navigateToList: () => void;
  navigateToDetail: (id: string) => void;
}) {
  const { useDetailQuery, toDraft, emptyDraft, newDraft, navigateToList, navigateToDetail } = options;
  const routeObjectId = useRouterState({ select: (state) => activeScreenObjectId(state.matches) });
  const [creating, setCreating] = useState(false);
  const selectedId = creating ? null : routeObjectId;
  const detailQuery = useDetailQuery(selectedId);
  const selected = detailQuery.data && detailQuery.data.id === selectedId ? detailQuery.data : null;
  const [draft, setDraft] = useState<TDraft>(emptyDraft);

  // URL で詳細が開かれたら新規作成モードは解除する (ブラウザバック/ディープリンク含む)
  useEffect(() => {
    if (routeObjectId) setCreating(false);
  }, [routeObjectId]);

  // 詳細データ → 編集ドラフトの同期。バックグラウンド再取得で編集中の
  // ドラフトを上書きしないよう、対象 ID が変わったときだけ反映する。
  const draftSourceId = useRef<string | null>(null);
  useEffect(() => {
    if (selected && draftSourceId.current !== selected.id) {
      draftSourceId.current = selected.id;
      setDraft(toDraft(selected));
      return;
    }
    if (!selectedId && draftSourceId.current !== null) {
      draftSourceId.current = null;
      if (!creating) setDraft(emptyDraft());
    }
  }, [creating, emptyDraft, selected, selectedId, toDraft]);

  const select = useCallback(
    (id: string) => {
      navigateToDetail(id);
    },
    [navigateToDetail]
  );

  const beginCreate = useCallback(() => {
    setCreating(true);
    setDraft(newDraft());
    navigateToList();
  }, [navigateToList, newDraft]);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraft(emptyDraft());
    navigateToList();
  }, [emptyDraft, navigateToList]);

  const backToList = useCallback(() => {
    setCreating(false);
    navigateToList();
  }, [navigateToList]);

  // 保存成功後: 返却されたサーバ状態をドラフトへ反映し、詳細 URL へ遷移する
  const afterSave = useCallback(
    (item: TItem) => {
      setCreating(false);
      draftSourceId.current = item.id;
      setDraft(toDraft(item));
      navigateToDetail(item.id);
    },
    [navigateToDetail, toDraft]
  );

  const afterDelete = useCallback(() => {
    navigateToList();
  }, [navigateToList]);

  return {
    routeObjectId,
    selectedId,
    selected,
    creating,
    draft,
    setDraft,
    select,
    beginCreate,
    cancelCreate,
    backToList,
    afterSave,
    afterDelete
  };
}

// 関係 (関係者 ↔ 土地/建物) の保存・削除。土地・建物・関係者の 3 画面で共用する。
// キャッシュ無効化はミューテーション定義側 (queries/parties.ts) が行う。
export function useRelationshipActions() {
  const { selectedProject, setNotice } = useAppShell();
  const saveMutation = useSaveRelationshipMutation();
  const deleteMutation = useDeleteRelationshipMutation();

  const saveRelationship = useCallback(
    async (relationshipId: string | null, draft: RelationshipDraft) => {
      if (!draft.partyId || !draft.targetId || !draft.relationType.trim()) {
        setNotice("関係者、対象、関係種別は必須です");
        return;
      }
      try {
        await saveMutation.mutateAsync({
          relationshipId,
          payload: {
            projectId: selectedProject,
            partyId: draft.partyId,
            targetType: draft.targetType,
            targetId: draft.targetId,
            relationType: draft.relationType,
            note: nullableString(draft.note)
          }
        });
        setNotice(relationshipId ? "関係を更新しました" : "関係を追加しました");
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [saveMutation, selectedProject, setNotice]
  );

  const removeRelationship = useCallback(
    async (relationshipId: string) => {
      if (!window.confirm("この関係を削除しますか")) return;
      try {
        await deleteMutation.mutateAsync(relationshipId);
        setNotice("関係を削除しました");
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [deleteMutation, setNotice]
  );

  return { saveRelationship, removeRelationship };
}
