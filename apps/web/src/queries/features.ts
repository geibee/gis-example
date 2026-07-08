import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getBusinessLinks, updateFeature } from "../api";
import type { Feature, FeatureUpdateRequest } from "../contracts";
import { keys } from "./keys";

// 選択地物の業務リンク。地物選択が変わるたびキーが変わり、自動で取得・キャッシュされる。
export function useBusinessLinksQuery(layerId: string | undefined, featureId: string | undefined) {
  return useQuery({
    queryKey: keys.features.businessLinks(layerId ?? "", featureId ?? ""),
    queryFn: () => getBusinessLinks(layerId!, featureId!),
    enabled: Boolean(layerId && featureId)
  });
}

// 地物 (属性・ジオメトリ) の保存。レイヤ由来の表示 (bbox 等) が変わりうるためレイヤ一覧を無効化する。
export function useUpdateFeatureMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { layerId: string; featureId: string; body: FeatureUpdateRequest }) =>
      updateFeature(input.layerId, input.featureId, input.body),
    onSuccess: (_feature: Feature) => {
      void queryClient.invalidateQueries({ queryKey: keys.layers.all });
    }
  });
}
