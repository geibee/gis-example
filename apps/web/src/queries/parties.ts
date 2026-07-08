import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createParty,
  createPartyRelationship,
  deleteParty,
  deletePartyRelationship,
  getParties,
  getParty,
  updateParty,
  updatePartyRelationship
} from "../api";
import type { Party, PartyWriteRequest } from "../contracts";
import type { BusinessListSearchCriteria } from "../appTypes";
import { keys } from "./keys";

export function usePartiesQuery(projectId: string, criteria: BusinessListSearchCriteria) {
  return useQuery({
    queryKey: keys.parties.list(projectId, criteria),
    queryFn: () => getParties(projectId, criteria.query, criteria.filters),
    enabled: Boolean(projectId)
  });
}

export function usePartyQuery(id: string | null) {
  return useQuery({
    queryKey: keys.parties.detail(id ?? ""),
    queryFn: () => getParty(id!),
    enabled: Boolean(id)
  });
}

// 関係者本体の変更は関係者一覧のみに影響する (土地・建物・区域は触らない)。
export function useCreatePartyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PartyWriteRequest) => createParty(body),
    onSuccess: (item: Party) => {
      queryClient.setQueryData(keys.parties.detail(item.id), item);
      void queryClient.invalidateQueries({ queryKey: keys.parties.lists() });
    }
  });
}

export function useUpdatePartyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: PartyWriteRequest }) => updateParty(input.id, input.body),
    onSuccess: (item: Party) => {
      queryClient.setQueryData(keys.parties.detail(item.id), item);
      void queryClient.invalidateQueries({ queryKey: keys.parties.lists() });
    }
  });
}

export function useDeletePartyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteParty(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: keys.parties.detail(id) });
      void queryClient.invalidateQueries({ queryKey: keys.parties.lists() });
    }
  });
}

// 関係 (関係者 ↔ 土地/建物) の変更は、関係サマリを表示する
// 関係者・土地・建物のキャッシュに影響する。区域は関係を表示しないため触らない。
function invalidateRelationshipRelated(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: keys.parties.all });
  void queryClient.invalidateQueries({ queryKey: keys.lands.all });
  void queryClient.invalidateQueries({ queryKey: keys.buildings.all });
}

export type RelationshipPayload = {
  projectId: string;
  partyId: string;
  targetType: "land" | "building";
  targetId: string;
  relationType: string;
  note: string | null;
};

export function useSaveRelationshipMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { relationshipId: string | null; payload: RelationshipPayload }) =>
      input.relationshipId
        ? updatePartyRelationship(input.relationshipId, input.payload)
        : createPartyRelationship(input.payload),
    onSuccess: () => invalidateRelationshipRelated(queryClient)
  });
}

export function useDeleteRelationshipMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (relationshipId: string) => deletePartyRelationship(relationshipId),
    onSuccess: () => invalidateRelationshipRelated(queryClient)
  });
}
