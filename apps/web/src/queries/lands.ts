import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLand, deleteLand, getLand, getLands, updateLand } from "../api";
import type { Land } from "../types";
import type { BusinessListSearchCriteria } from "../appTypes";
import { keys } from "./keys";

export function useLandsQuery(projectId: string, criteria: BusinessListSearchCriteria) {
  return useQuery({
    queryKey: keys.lands.list(projectId, criteria),
    queryFn: () => getLands(projectId, criteria.query, criteria.filters),
    enabled: Boolean(projectId)
  });
}

export function useLandQuery(id: string | null) {
  return useQuery({
    queryKey: keys.lands.detail(id ?? ""),
    queryFn: () => getLand(id!),
    enabled: Boolean(id)
  });
}

// 土地の変更は土地一覧に加え、土地リンクを表示する建物一覧・区域一覧にも影響する。
// 関係者は無関係なので触らない。
function invalidateLandRelated(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: keys.lands.lists() });
  void queryClient.invalidateQueries({ queryKey: keys.buildings.lists() });
  void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
}

export function useCreateLandMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => createLand(body),
    onSuccess: (item: Land) => {
      queryClient.setQueryData(keys.lands.detail(item.id), item);
      invalidateLandRelated(queryClient);
    }
  });
}

export function useUpdateLandMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: unknown }) => updateLand(input.id, input.body),
    onSuccess: (item: Land) => {
      queryClient.setQueryData(keys.lands.detail(item.id), item);
      invalidateLandRelated(queryClient);
    }
  });
}

export function useDeleteLandMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteLand(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: keys.lands.detail(id) });
      invalidateLandRelated(queryClient);
    }
  });
}
