import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createZone, createZoneLayerFromImport, deleteZone, getZone, getZones, updateZone } from "../api";
import type { Zone, ZoneLayerOperation, ZoneWriteRequest } from "../contracts";
import type { BusinessListSearchCriteria } from "../appTypes";
import { keys } from "./keys";

export function useZonesQuery(projectId: string, criteria: BusinessListSearchCriteria) {
  return useQuery({
    queryKey: keys.zones.list(projectId, criteria),
    queryFn: () => getZones(projectId, criteria.query, criteria.filters),
    enabled: Boolean(projectId)
  });
}

export function useZoneQuery(id: string | null) {
  return useQuery({
    queryKey: keys.zones.detail(id ?? ""),
    queryFn: () => getZone(id!),
    enabled: Boolean(id)
  });
}

// 作成/更新: 返却された詳細をキャッシュへ反映し、区域一覧のみ無効化する
// (土地・建物・関係者など無関係な一覧は触らない)。
export function useCreateZoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ZoneWriteRequest) => createZone(body),
    onSuccess: (item: Zone) => {
      queryClient.setQueryData(keys.zones.detail(item.id), item);
      void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
    }
  });
}

export function useUpdateZoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: ZoneWriteRequest }) => updateZone(input.id, input.body),
    onSuccess: (item: Zone) => {
      queryClient.setQueryData(keys.zones.detail(item.id), item);
      void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
    }
  });
}

export function useDeleteZoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteZone(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: keys.zones.detail(id) });
      void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
    }
  });
}

// 取込レイヤからの区域レイヤ一括作成: レイヤ一覧と区域一覧の両方が成果物。
// 呼び出し側が作成レイヤをフィルタ等へ反映できるよう、mutateAsync は
// 再取得完了 (invalidate の解決) まで待ってから解決する。
export function useCreateZoneLayerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof createZoneLayerFromImport>[0]) => createZoneLayerFromImport(body),
    onSuccess: (_result: ZoneLayerOperation) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.layers.all }),
        queryClient.invalidateQueries({ queryKey: keys.zones.lists() })
      ])
  });
}
