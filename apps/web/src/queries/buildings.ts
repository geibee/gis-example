import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createBuilding, deleteBuilding, getBuilding, getBuildings, updateBuilding } from "../api";
import type { Building, BuildingWriteRequest } from "../contracts";
import type { BusinessListSearchCriteria } from "../appTypes";
import { keys } from "./keys";

export function useBuildingsQuery(projectId: string, criteria: BusinessListSearchCriteria) {
  return useQuery({
    queryKey: keys.buildings.list(projectId, criteria),
    queryFn: () => getBuildings(projectId, criteria.query, undefined, criteria.filters),
    enabled: Boolean(projectId)
  });
}

export function useBuildingQuery(id: string | null) {
  return useQuery({
    queryKey: keys.buildings.detail(id ?? ""),
    queryFn: () => getBuilding(id!),
    enabled: Boolean(id)
  });
}

// 建物の変更は建物一覧・区域一覧と、リンク先土地の詳細 (土地詳細は建物リンクを表示) に影響する。
// 建物が別の土地へ付け替えられるケースがあるため土地詳細はプレフィックス単位で無効化する。
function invalidateBuildingRelated(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: keys.buildings.lists() });
  void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
  void queryClient.invalidateQueries({ queryKey: keys.lands.details() });
}

export function useCreateBuildingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BuildingWriteRequest) => createBuilding(body),
    onSuccess: (item: Building) => {
      queryClient.setQueryData(keys.buildings.detail(item.id), item);
      invalidateBuildingRelated(queryClient);
    }
  });
}

export function useUpdateBuildingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: BuildingWriteRequest }) => updateBuilding(input.id, input.body),
    onSuccess: (item: Building) => {
      queryClient.setQueryData(keys.buildings.detail(item.id), item);
      invalidateBuildingRelated(queryClient);
    }
  });
}

export function useDeleteBuildingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteBuilding(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: keys.buildings.detail(id) });
      invalidateBuildingRelated(queryClient);
    }
  });
}
