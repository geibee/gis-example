// OpenAPI 生成型 (generated.ts) の別名を集約する re-export モジュール。
// サーバ契約型の定義元は apps/api/openapi.yaml → generated.ts のみ。
// ここでは手書きの型定義を行わず、components["schemas"] の別名だけを公開する。
// (新規エンドポイント追加時は openapi.yaml 更新 → generate:contracts 再生成 → ここに別名を足すだけ)
import type { components } from "./generated";

export type { components, operations, paths } from "./generated";

type Schemas = components["schemas"];

// ---------------------------------------------------------------- システム・管理
export type ApiErrorBody = Schemas["Error"];
export type Project = Schemas["Project"];
export type Membership = Schemas["Membership"];
export type Me = Schemas["Me"];
export type UserAccount = Schemas["User"];
export type UserPatchRequest = Schemas["UserPatchRequest"];
export type ProjectMember = Schemas["ProjectMember"];
export type MemberPutRequest = Schemas["MemberPutRequest"];

// ---------------------------------------------------------------- レイヤ・フィーチャ
export type LayerAttribute = Schemas["LayerAttribute"];
export type Layer = Schemas["Layer"];
export type Feature = Schemas["Feature"];
export type FeatureUpdateRequest = Schemas["FeatureUpdateRequest"];
export type FeatureSearchResult = Schemas["FeatureSearchResult"];
export type BusinessSpatialSearchRequest = Schemas["BusinessSpatialSearchRequest"];
export type ConditionQuery = Schemas["ConditionQuery"];
export type ConditionQueryCondition = Schemas["ConditionQueryCondition"];

// ---------------------------------------------------------------- 業務オブジェクト
export type BusinessEntityLink = Schemas["BusinessEntityLink"];
export type BusinessLinks = Schemas["BusinessLinks"];
export type PartyRelationship = Schemas["PartyRelationship"];
export type PartyRelationshipWriteRequest = Schemas["PartyRelationshipWriteRequest"];
export type Land = Schemas["Land"];
export type LandWriteRequest = Schemas["LandWriteRequest"];
export type Building = Schemas["Building"];
export type BuildingWriteRequest = Schemas["BuildingWriteRequest"];
export type Party = Schemas["Party"];
export type PartyWriteRequest = Schemas["PartyWriteRequest"];

// ---------------------------------------------------------------- 区域
export type Zone = Schemas["Zone"];
export type ZoneWriteRequest = Schemas["ZoneWriteRequest"];
export type ZonePartyBreakdown = Schemas["ZonePartyBreakdown"];
export type ZonePartySummaryEntry = Schemas["ZonePartySummaryEntry"];
export type ZonePartySummary = Schemas["ZonePartySummary"];
export type ZoneLayerFromImportRequest = Schemas["ZoneLayerFromImportRequest"];
export type ZoneLayerOperation = Schemas["ZoneLayerOperation"];

// ---------------------------------------------------------------- ジョブ
export type ImportJob = Schemas["ImportJob"];
export type AnalysisJobRequest = Schemas["AnalysisJobRequest"];
export type AnalysisJob = Schemas["AnalysisJob"];

// ---------------------------------------------------------------- タイル
export type VectorLayer = Schemas["VectorLayer"];
export type TileJson = Schemas["TileJson"];
