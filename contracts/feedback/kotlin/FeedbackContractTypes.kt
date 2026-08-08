// このファイルは contracts/feedback/openapi.yaml から生成されます。直接編集しないでください。
@file:Suppress("unused")

package feedback.contract.generated

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

typealias FeedbackApplicationManifestV1 = JsonObject

typealias FeedbackLocationV1 = JsonObject

typealias FeedbackTargetV1 = JsonObject

typealias FeedbackWebhookEventV1 = JsonObject

@Serializable
data class FeedbackCapabilities(
    val apiVersion: String,
    val apiMajorVersion: Long,
    val manifestSchemaVersions: List<String>,
    val targetSchemaVersions: List<String>,
    val evidence: JsonObject,
    val features: List<String>
)

@Serializable
data class FeedbackProblem(
    val type: String,
    val title: String,
    val status: Long,
    val detail: String? = null,
    val code: String,
    val requestId: String
)

typealias FeedbackPermission = String

@Serializable
data class FeedbackParticipant(
    val principalId: String,
    val displayName: String? = null,
    val participantName: String? = null
)

@Serializable
data class FeedbackMembership(
    val applicationKey: String,
    val externalWorkspaceKey: String,
    val permissions: List<FeedbackPermission>
)

@Serializable
data class FeedbackMe(
    val participant: FeedbackParticipant,
    val memberships: List<FeedbackMembership>
)

@Serializable
data class FeedbackWorkspaceMember(
    val userId: String,
    val issuer: String,
    val subject: String,
    val email: String? = null,
    val displayName: String? = null,
    val permissions: List<FeedbackPermission>,
    val version: Long
)

@Serializable
data class FeedbackMembershipCreateRequest(
    val issuer: String,
    val subject: String,
    val permissions: List<FeedbackPermission>
)

@Serializable
data class FeedbackMembershipPatchRequest(
    val permissions: List<FeedbackPermission>
)

@Serializable
data class FeedbackHostContextV1(
    val schemaVersion: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val release: String,
    val locale: String? = null
)

typealias FeedbackParticipantPolicy = JsonElement

@Serializable
data class FeedbackEvidencePolicy(
    val enabled: Boolean,
    val maxBytes: Long,
    val acceptedContentTypes: List<String>
)

@Serializable
data class FeedbackReviewContextV1(
    val session: JsonElement,
    val scope: String,
    val posting: String,
    val permissions: List<FeedbackPermission>,
    val participantPolicy: FeedbackParticipantPolicy,
    val evidencePolicy: FeedbackEvidencePolicy
)

typealias FeedbackSessionStatus = String

@Serializable
data class FeedbackSessionV1(
    val id: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val manifestVersion: String,
    val title: String,
    val description: String? = null,
    val status: FeedbackSessionStatus,
    val outOfScopePosting: String,
    val startAt: String? = null,
    val endAt: String? = null,
    val scopes: List<FeedbackSessionScopeV1>,
    val perspectives: List<FeedbackSessionPerspectiveV1>,
    val createdAt: String,
    val updatedAt: String,
    val version: Long
)

@Serializable
data class FeedbackSessionScopeV1(
    val pageKey: String,
    val routeTemplate: String? = null,
    val reviewable: Boolean
)

@Serializable
data class FeedbackSessionPerspectiveV1(
    val code: String,
    val label: String,
    val status: String,
    val guidance: String? = null
)

@Serializable
data class FeedbackSessionPage(
    val items: List<FeedbackSessionV1>,
    val nextCursor: String? = null,
    val totalCount: Long? = null
)

@Serializable
data class FeedbackSessionCreateRequest(
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val manifestVersion: String,
    val title: String,
    val description: String? = null,
    val outOfScopePosting: String,
    val startAt: String? = null,
    val endAt: String? = null,
    val scopes: List<FeedbackSessionScopeV1>? = null,
    val perspectives: List<FeedbackSessionPerspectiveV1>? = null
)

@Serializable
data class FeedbackSessionPatchRequest(
    val title: String? = null,
    val description: String? = null,
    val status: FeedbackSessionStatus? = null,
    val outOfScopePosting: String? = null,
    val startAt: String? = null,
    val endAt: String? = null
)

typealias FeedbackThreadStatus = String

@Serializable
data class FeedbackMessageV1(
    val id: String,
    val threadId: String,
    val author: FeedbackParticipant,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val version: Long
)

@Serializable
data class FeedbackMessageVersionV1(
    val id: String,
    val threadId: String,
    val author: FeedbackParticipant,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val version: Long,
    val current: Boolean
)

@Serializable
data class FeedbackThreadV1(
    val id: String,
    val sessionId: String,
    val displayNumber: Long,
    val location: FeedbackLocationV1,
    val target: FeedbackTargetV1,
    val perspectiveCode: String,
    val status: FeedbackThreadStatus,
    val reporter: FeedbackParticipant,
    val evidenceAvailable: Boolean? = null,
    val messages: List<FeedbackMessageV1>,
    val createdAt: String,
    val updatedAt: String,
    val version: Long
)

@Serializable
data class FeedbackThreadPage(
    val items: List<FeedbackThreadV1>,
    val nextCursor: String? = null,
    val totalCount: Long? = null
)

@Serializable
data class FeedbackDeepLink(
    val url: String
)

@Serializable
data class FeedbackThreadCreateRequest(
    val location: FeedbackLocationV1,
    val target: FeedbackTargetV1,
    val perspectiveCode: String,
    val body: String,
    val participantName: String? = null,
    val evidence: JsonObject? = null
)

@Serializable
data class FeedbackMessageCreateRequest(
    val body: String,
    val participantName: String? = null
)

@Serializable
data class FeedbackMessagePatchRequest(
    val body: String,
    val participantName: String? = null
)

@Serializable
data class FeedbackExportRequest(
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val sessionId: String? = null,
    val format: String,
    val locale: String? = null,
    val timezone: String? = null
)

@Serializable
data class FeedbackExportJob(
    val id: String,
    val status: String,
    val downloadUrl: String? = null,
    val expiresAt: String? = null,
    val createdAt: String,
    val error: String? = null
)

@Serializable
data class FeedbackRetentionPolicy(
    val evidenceRetentionDays: Long?,
    val exportRetentionDays: Long? = null
)

@Serializable
data class FeedbackNotificationSettings(
    val webhookEnabled: Boolean,
    val webhookEndpoint: String? = null,
    val includeBody: Boolean,
    val includeEvidence: Boolean
)

@Serializable
data class FeedbackNotificationAttempt(
    val retryCycle: Long,
    val attempt: Long,
    val status: String,
    val responseStatus: Long? = null,
    val error: String? = null,
    val createdAt: String
)

@Serializable
data class FeedbackNotificationDelivery(
    val id: String,
    val eventType: String,
    val status: String,
    val retryCycle: Long,
    val attemptCount: Long,
    val availableAt: String,
    val deliveredAt: String? = null,
    val lastError: String? = null,
    val createdAt: String,
    val attempts: List<FeedbackNotificationAttempt>
)
