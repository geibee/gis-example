package gis.example

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class ErrorResponse(val error: String)

@Serializable
data class ProjectDto(
    val id: String,
    val name: String,
    val createdAt: String
)

@Serializable
data class LayerAttributeDto(
    val name: String,
    val dataType: String,
    val ordinalPosition: Int
)

@Serializable
data class LayerDto(
    val id: String,
    val projectId: String,
    val name: String,
    val schemaName: String,
    val tableName: String,
    val geometryColumn: String,
    val geometryType: String,
    val sourceSrid: Int? = null,
    val displaySrid: Int,
    val featureIdColumn: String,
    val bbox4326: List<Double>? = null,
    val rowCount: Long,
    val isResult: Boolean,
    val layerRole: String,
    val resultSetId: String? = null,
    val resultSetName: String? = null,
    val sourceLayerId: String? = null,
    val tileSourceId: String,
    val attributes: List<LayerAttributeDto> = emptyList(),
    val createdAt: String
)

@Serializable
data class ImportJobDto(
    val id: String,
    val projectId: String,
    val filename: String,
    val format: String,
    val sourceSrid: Int? = null,
    val status: String,
    val errorMessage: String? = null,
    val layerId: String? = null,
    val layerRole: String,
    val createdAt: String,
    val startedAt: String? = null,
    val finishedAt: String? = null
)

@Serializable
data class AttributeConditionDto(
    val layerId: String,
    val field: String,
    val operator: String,
    val value: JsonElement? = null,
    val values: List<String>? = null
)

@Serializable
data class SpatialConditionDto(
    val layerId: String,
    val operator: String,
    val distanceMeters: Double? = null
)

@Serializable
data class ConditionQueryConditionDto(
    val type: String,
    val layerId: String? = null,
    val field: String? = null,
    val operator: String? = null,
    val value: JsonElement? = null,
    val values: List<String>? = null,
    val comparisonTarget: String? = null,
    val sourceTypes: List<String>? = null,
    val businessQuery: String? = null,
    val status: String? = null,
    val landUse: String? = null,
    val buildingUse: String? = null,
    val partyQuery: String? = null,
    val partyType: String? = null,
    val relationType: String? = null,
    val spatialOperator: String? = null,
    val distanceMeters: Double? = null
)

@Serializable
data class ConditionQueryDto(
    val projectId: String? = null,
    val targetLayerIds: List<String> = emptyList(),
    val keyword: String? = null,
    val conditions: List<ConditionQueryConditionDto> = emptyList(),
    val limit: Int = 100
)

@Serializable
data class AnalysisJobRequest(
    val projectId: String? = null,
    val name: String? = null,
    val targetLayerId: String? = null,
    val operation: String? = null,
    val attributeConditions: List<AttributeConditionDto> = emptyList(),
    val spatialConditions: List<SpatialConditionDto> = emptyList(),
    val conditionQuery: ConditionQueryDto? = null
)

@Serializable
data class AnalysisJobDto(
    val id: String,
    val projectId: String,
    val name: String,
    val criteria: JsonObject,
    val status: String,
    val errorMessage: String? = null,
    val resultLayerId: String? = null,
    val resultSetId: String? = null,
    val resultCount: Long? = null,
    val createdAt: String,
    val startedAt: String? = null,
    val finishedAt: String? = null
)

@Serializable
data class FeatureDto(
    val layerId: String,
    val featureId: String,
    val properties: JsonObject,
    val geometry: JsonElement? = null
)

@Serializable
data class FeatureSearchResultDto(
    val layerId: String,
    val layerName: String,
    val featureId: String,
    val properties: JsonObject,
    val geometry: JsonElement? = null,
    val matchSummary: String? = null,
    val businessLinks: BusinessLinksDto = BusinessLinksDto(),
    val matchedBusinessLinks: BusinessLinksDto = BusinessLinksDto()
)

@Serializable
data class BusinessSpatialSearchRequest(
    val projectId: String? = null,
    val targetLayerIds: List<String> = emptyList(),
    val sourceTypes: List<String> = listOf("land", "building"),
    val businessQuery: String? = null,
    val status: String? = null,
    val landUse: String? = null,
    val buildingUse: String? = null,
    val partyQuery: String? = null,
    val partyType: String? = null,
    val relationType: String? = null,
    val spatialOperator: String? = "intersects",
    val distanceMeters: Double? = null,
    val limit: Int = 100
)

@Serializable
data class FeatureUpdateRequest(
    val properties: JsonObject = JsonObject(emptyMap()),
    val geometry: JsonElement? = null
)

@Serializable
data class BusinessEntityLinkDto(
    val id: String,
    val label: String
)

@Serializable
data class PartyRelationshipDto(
    val id: String,
    val projectId: String,
    val partyId: String,
    val partyName: String? = null,
    val targetType: String,
    val targetId: String,
    val targetLabel: String? = null,
    val relationType: String,
    val note: String? = null
)

@Serializable
data class LandDto(
    val id: String,
    val projectId: String,
    val lotNumber: String,
    val address: String,
    val landUse: String? = null,
    val areaSqm: Double? = null,
    val registeredOwner: String? = null,
    val rightType: String? = null,
    val registrationCause: String? = null,
    val registrationAcceptedOn: String? = null,
    val status: String,
    val memo: String? = null,
    val sourceLayerId: String? = null,
    val sourceFeatureId: String? = null,
    val buildings: List<BusinessEntityLinkDto> = emptyList(),
    val relationships: List<PartyRelationshipDto> = emptyList()
)

@Serializable
data class BuildingDto(
    val id: String,
    val projectId: String,
    val landId: String? = null,
    val landLabel: String? = null,
    val name: String,
    val buildingLocation: String? = null,
    val houseNumber: String? = null,
    val buildingUse: String? = null,
    val floors: Int? = null,
    val totalFloorAreaSqm: Double? = null,
    val structure: String? = null,
    val registeredOwner: String? = null,
    val rightType: String? = null,
    val registrationAcceptedOn: String? = null,
    val status: String,
    val memo: String? = null,
    val sourceLayerId: String? = null,
    val sourceFeatureId: String? = null,
    val relationships: List<PartyRelationshipDto> = emptyList()
)

@Serializable
data class PartyDto(
    val id: String,
    val projectId: String,
    val name: String,
    val partyType: String,
    val contact: String? = null,
    val address: String? = null,
    val memo: String? = null,
    val tags: List<String> = emptyList(),
    val relationships: List<PartyRelationshipDto> = emptyList()
)

@Serializable
data class ZoneDto(
    val id: String,
    val projectId: String,
    val name: String,
    val zoneType: String? = null,
    val status: String,
    val memo: String? = null,
    val zoneLayerId: String,
    val zoneFeatureId: String,
    val sourceLayerId: String,
    val sourceFeatureId: String,
    val landCount: Int = 0,
    val buildingCount: Int = 0,
    val lands: List<BusinessEntityLinkDto> = emptyList(),
    val buildings: List<BusinessEntityLinkDto> = emptyList()
)

@Serializable
data class ZonePartyBreakdownDto(
    val key: String,
    val count: Int
)

@Serializable
data class ZonePartySummaryEntryDto(
    val id: String,
    val name: String,
    val partyType: String,
    val tags: List<String> = emptyList(),
    val zoneInvolvement: Int,
    val projectInvolvement: Int,
    val relationTypes: List<String> = emptyList(),
    val coverageRatio: Double
)

@Serializable
data class ZonePartySummaryDto(
    val zoneId: String,
    val containedCount: Int,
    val partyCount: Int,
    val typeBreakdown: List<ZonePartyBreakdownDto> = emptyList(),
    val tagBreakdown: List<ZonePartyBreakdownDto> = emptyList(),
    val parties: List<ZonePartySummaryEntryDto> = emptyList()
)

@Serializable
data class ZoneLayerFromImportRequest(
    val projectId: String? = null,
    val layerId: String,
    val name: String? = null,
    val zoneType: String? = null,
    val status: String? = null,
    val nameField: String? = null
)

@Serializable
data class ZoneLayerOperationDto(
    val layer: LayerDto,
    val zonesCreated: Int,
    val zonesUpdated: Int,
    val zones: List<ZoneDto> = emptyList()
)

@Serializable
data class BusinessLinksDto(
    val lands: List<BusinessEntityLinkDto> = emptyList(),
    val buildings: List<BusinessEntityLinkDto> = emptyList()
)

@Serializable
data class VectorLayerDto(
    val id: String,
    val fields: Map<String, String>
)

@Serializable
data class TileJsonDto(
    val tilejson: String = "3.0.0",
    val name: String,
    val tiles: List<String>,
    @SerialName("vector_layers")
    val vectorLayers: List<VectorLayerDto>,
    val bounds: List<Double>? = null,
    val minzoom: Int = 0,
    val maxzoom: Int = 22
)

// ---------------------------------------------------------------- 認証・認可 (管理 API)

@Serializable
data class MembershipDto(
    val projectId: String,
    val role: String
)

@Serializable
data class MeDto(
    val userId: String,
    val subject: String,
    val email: String? = null,
    val displayName: String? = null,
    val systemRole: String,
    val memberships: List<MembershipDto> = emptyList()
)

@Serializable
data class UserDto(
    val id: String,
    val subject: String,
    val email: String? = null,
    val displayName: String? = null,
    val systemRole: String,
    val isActive: Boolean,
    val createdAt: String
)

@Serializable
data class UserPatchRequest(
    val systemRole: String? = null,
    val isActive: Boolean? = null
)

@Serializable
data class ProjectMemberDto(
    val userId: String,
    val projectId: String,
    val role: String,
    val email: String? = null,
    val displayName: String? = null
)

@Serializable
data class MemberPutRequest(
    val role: String
)

// ---------------------------------------------------------------- レビュー基盤 (docs/prototype-review.md)

/**
 * セッション内でのレビュー観点とその状態。
 *
 * status は ACTIVE / FUTURE / OUT_OF_SCOPE。FUTURE・OUT_OF_SCOPE も「行として返す」ことが要点で、
 * UI はグレーアウトして表示する (「今は見なくてよい」と「存在を忘れている」を区別させる)
 */
@Serializable
data class ReviewPerspectiveDto(
    val code: String,
    val label: String,
    val description: String? = null,
    val displayOrder: Int,
    val status: String,
    val guidance: String? = null
)

/** セッション内でレビュー対象となる画面・機能 */
@Serializable
data class ReviewScopeDto(
    val id: String,
    val pageId: String,
    val description: String? = null,
    val reviewable: Boolean,
    val displayOrder: Int
)

@Serializable
data class ReviewSessionDto(
    val id: String,
    val projectId: String,
    val title: String,
    val description: String? = null,
    val status: String,
    val startAt: String? = null,
    val endAt: String? = null,
    /** NULL はプロジェクト既定を継承する */
    val evidenceRetentionDays: Int? = null,
    /** セッション上書きとプロジェクト既定を解決した実効値。NULL は自動削除なし */
    val effectiveEvidenceRetentionDays: Int? = null,
    val createdBy: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val perspectives: List<ReviewPerspectiveDto> = emptyList(),
    val scopes: List<ReviewScopeDto> = emptyList()
)

/** コメント投稿時点の証跡。画像本体は API 経由でのみ取得できる (パスは公開しない) */
@Serializable
data class ReviewEvidenceDto(
    val id: String,
    val contentType: String,
    val byteSize: Long,
    val viewportWidth: Int,
    val viewportHeight: Int,
    val scrollX: Int,
    val scrollY: Int,
    val pixelRatio: Double,
    val frontendVersion: String,
    val route: String,
    val capturedAt: String,
    val expiresAt: String? = null
)

@Serializable
data class FeedbackMessageDto(
    val id: String,
    val threadId: String,
    val authorId: String? = null,
    val authorName: String? = null,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null
)

/** コメントの改訂版。version=1 を初版とし、最大 version が現在版になる。 */
@Serializable
data class FeedbackMessageVersionDto(
    val messageId: String,
    val version: Int,
    val body: String,
    val editedBy: String? = null,
    val editedByName: String? = null,
    val createdAt: String,
    val current: Boolean
)

@Serializable
data class FeedbackThreadDto(
    val id: String,
    val projectId: String,
    val reviewSessionId: String,
    val reviewScopeId: String? = null,
    val perspectiveCode: String,
    val perspectiveLabel: String,
    /** UI_ELEMENT / SCREEN_POSITION / MAP_FEATURE / MAP_POSITION */
    val targetType: String,
    /** FeedbackTarget (apps/web/src/review/types.ts) をそのまま保持する */
    val targetMetadata: JsonObject,
    val evidence: ReviewEvidenceDto? = null,
    val status: String,
    val createdBy: String? = null,
    val createdByName: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val messages: List<FeedbackMessageDto> = emptyList()
)

@Serializable
data class FeedbackSessionSummaryDto(
    val reviewSessionId: String,
    val title: String,
    val sessionStatus: String,
    val totalCount: Long,
    val openCount: Long,
    val resolvedCount: Long
)

@Serializable
data class FeedbackPerspectiveSummaryDto(
    val perspectiveCode: String,
    val perspectiveLabel: String,
    val totalCount: Long,
    val openCount: Long,
    val resolvedCount: Long
)

/** レビュー管理画面のプロジェクト横断集計。件数はページング前の全スレッドを対象とする。 */
@Serializable
data class FeedbackSummaryDto(
    val totalCount: Long,
    val openCount: Long,
    val resolvedCount: Long,
    val withEvidenceCount: Long,
    val sessions: List<FeedbackSessionSummaryDto> = emptyList(),
    val perspectives: List<FeedbackPerspectiveSummaryDto> = emptyList()
)

/** プロジェクトの証跡保存方針と、現在期限切れになっている証跡の規模。 */
@Serializable
data class ReviewRetentionPolicyDto(
    val projectId: String,
    val defaultEvidenceRetentionDays: Int? = null,
    val expiredEvidenceCount: Long,
    val expiredEvidenceBytes: Long
)

/** 1 回の削除実行結果。失敗分は DB 参照を残し、次回再試行できる。 */
@Serializable
data class ReviewRetentionPurgeResultDto(
    val purgedEvidenceCount: Int,
    val purgedEvidenceBytes: Long,
    val failedEvidenceCount: Int,
    val remainingExpiredEvidenceCount: Long
)

/** プロジェクト単位のレビュー通知設定。外部接続先そのものは環境変数からのみ読む。 */
@Serializable
data class ReviewNotificationSettingsDto(
    val projectId: String,
    val emailEnabled: Boolean,
    val teamsEnabled: Boolean,
    val issueEnabled: Boolean,
    val emailAvailable: Boolean,
    val teamsAvailable: Boolean,
    val issueAvailable: Boolean,
    val pendingDeliveryCount: Long,
    val failedDeliveryCount: Long,
    val updatedAt: String? = null
)

/** 手動再試行で待機状態へ戻した配信数。 */
@Serializable
data class ReviewNotificationRetryResultDto(
    val retriedDeliveryCount: Int
)
