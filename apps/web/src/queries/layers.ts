import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteLayer, deleteResultSet, getLayers } from "../api";
import { keys } from "./keys";

export function useLayersQuery(projectId: string) {
  return useQuery({
    queryKey: keys.layers.list(projectId),
    queryFn: () => getLayers(projectId),
    enabled: Boolean(projectId)
  });
}

export function useDeleteLayerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (layerId: string) => deleteLayer(layerId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.layers.all })
  });
}

export function useDeleteResultSetMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (resultSetId: string) => deleteResultSet(resultSetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.layers.all })
  });
}
