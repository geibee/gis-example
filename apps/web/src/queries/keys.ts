import type { BusinessListSearchCriteria } from "../appTypes";

// クエリキーは全てここで一元管理する (階層化キーのファクトリ)。
// invalidate は「関連キーのプレフィックス単位」で行う:
//   - keys.zones.all       … 区域に関わる全キャッシュ (一覧 + 詳細)
//   - keys.zones.lists()   … 区域一覧のみ (検索条件違いも全て)
//   - keys.zones.detail(id)… 特定の区域詳細のみ
// 無関係なドメイン (例: 区域保存で関係者一覧) を invalidate しないことが原則。
export const keys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  layers: {
    all: ["layers"] as const,
    list: (projectId: string) => ["layers", "list", projectId] as const
  },
  zones: {
    all: ["zones"] as const,
    lists: () => ["zones", "list"] as const,
    list: (projectId: string, criteria: BusinessListSearchCriteria) => ["zones", "list", projectId, criteria] as const,
    details: () => ["zones", "detail"] as const,
    detail: (id: string) => ["zones", "detail", id] as const
  },
  lands: {
    all: ["lands"] as const,
    lists: () => ["lands", "list"] as const,
    list: (projectId: string, criteria: BusinessListSearchCriteria) => ["lands", "list", projectId, criteria] as const,
    details: () => ["lands", "detail"] as const,
    detail: (id: string) => ["lands", "detail", id] as const
  },
  buildings: {
    all: ["buildings"] as const,
    lists: () => ["buildings", "list"] as const,
    list: (projectId: string, criteria: BusinessListSearchCriteria) =>
      ["buildings", "list", projectId, criteria] as const,
    details: () => ["buildings", "detail"] as const,
    detail: (id: string) => ["buildings", "detail", id] as const
  },
  parties: {
    all: ["parties"] as const,
    lists: () => ["parties", "list"] as const,
    list: (projectId: string, criteria: BusinessListSearchCriteria) => ["parties", "list", projectId, criteria] as const,
    details: () => ["parties", "detail"] as const,
    detail: (id: string) => ["parties", "detail", id] as const
  },
  features: {
    businessLinks: (layerId: string, featureId: string) => ["features", "businessLinks", layerId, featureId] as const
  },
  jobs: {
    import: (id: string) => ["jobs", "import", id] as const,
    analysis: (id: string) => ["jobs", "analysis", id] as const
  }
} as const;
