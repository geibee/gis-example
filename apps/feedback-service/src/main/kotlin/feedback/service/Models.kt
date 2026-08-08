package feedback.service

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class FeedbackProblem(
    val type: String,
    val title: String,
    val status: Int,
    val detail: String? = null,
    val code: String,
    val requestId: String
)

@Serializable
data class FeedbackCapabilities(
    val apiVersion: String = "1.0",
    val apiMajorVersion: Int = 1,
    val manifestSchemaVersions: List<String> = listOf("1"),
    val targetSchemaVersions: List<String> = listOf("1"),
    val evidence: CapabilitiesEvidencePolicy,
    val features: List<String>
)

@Serializable
data class CapabilitiesEvidencePolicy(
    val maxBytes: Long,
    val maxCountPerWorkspace: Int,
    val acceptedContentTypes: List<String> = listOf("image/png", "image/webp")
)

@Serializable
data class EvidencePolicy(
    val enabled: Boolean = true,
    val maxBytes: Long,
    val acceptedContentTypes: List<String> = listOf("image/png", "image/webp")
)

@Serializable
data class Participant(
    val principalId: String,
    val displayName: String? = null,
    val participantName: String? = null
)

@Serializable
data class Membership(
    val applicationKey: String,
    val externalWorkspaceKey: String,
    val permissions: List<String>
)

@Serializable
data class FeedbackMe(
    val participant: Participant,
    val memberships: List<Membership>
)

@Serializable
data class FeedbackWorkspaceMember(
    val userId: String,
    val issuer: String,
    val subject: String,
    val email: String? = null,
    val displayName: String? = null,
    val permissions: List<String>,
    val version: Int
)

@Serializable
data class FeedbackMembershipCreateRequest(
    val issuer: String,
    val subject: String,
    val permissions: List<String>
)

@Serializable
data class FeedbackMembershipPatchRequest(val permissions: List<String>)

@Serializable
data class SessionScope(
    val pageKey: String,
    val routeTemplate: String? = null,
    val reviewable: Boolean
)

@Serializable
data class SessionPerspective(
    val code: String,
    val label: String,
    val status: String,
    val guidance: String? = null
)

@Serializable
data class FeedbackSession(
    val id: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val manifestVersion: String,
    val title: String,
    val description: String? = null,
    val status: String,
    val outOfScopePosting: String,
    val startAt: String? = null,
    val endAt: String? = null,
    val scopes: List<SessionScope>,
    val perspectives: List<SessionPerspective>,
    val createdAt: String,
    val updatedAt: String,
    val version: Int
)

@Serializable
data class FeedbackSessionPage(
    val items: List<FeedbackSession>,
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
    val outOfScopePosting: String = "warn",
    val startAt: String? = null,
    val endAt: String? = null,
    val scopes: List<SessionScope> = emptyList(),
    val perspectives: List<SessionPerspective> = emptyList()
)

@Serializable
data class FeedbackMessage(
    val id: String,
    val threadId: String,
    val author: Participant,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val version: Int
)

@Serializable
data class FeedbackMessageVersion(
    val id: String,
    val threadId: String,
    val author: Participant,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val version: Int,
    val current: Boolean
)

@Serializable
data class FeedbackThread(
    val id: String,
    val sessionId: String,
    val displayNumber: Int,
    val location: JsonObject,
    val target: JsonObject,
    val perspectiveCode: String,
    val status: String,
    val reporter: Participant,
    val evidenceAvailable: Boolean = false,
    val messages: List<FeedbackMessage>,
    val createdAt: String,
    val updatedAt: String,
    val version: Int
)

@Serializable
data class FeedbackThreadPage(
    val items: List<FeedbackThread>,
    val nextCursor: String? = null,
    val totalCount: Long? = null
)

@Serializable
data class FeedbackDeepLink(val url: String)

@Serializable
data class FeedbackThreadCreateRequest(
    val location: JsonObject,
    val target: JsonObject,
    val perspectiveCode: String,
    val body: String,
    val participantName: String? = null,
    val evidence: EvidenceCreateRequest? = null
)

@Serializable
data class EvidenceCreateRequest(
    val contentType: String,
    val dataBase64: String,
    val viewportWidth: Int,
    val viewportHeight: Int,
    val pixelRatio: Double,
    val capturedAt: String
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
data class ThreadStatusPatchRequest(val status: String)

@Serializable
data class FeedbackReviewContext(
    val session: FeedbackSession?,
    val scope: String,
    val posting: String,
    val permissions: List<String>,
    val participantPolicy: ParticipantPolicy = ParticipantPolicy(),
    val evidencePolicy: EvidencePolicy
)

@Serializable
data class ParticipantPolicy(
    val mode: String = "authenticated-identity"
)

@Serializable
data class FeedbackRetentionPolicy(
    val evidenceRetentionDays: Int? = null,
    val exportRetentionDays: Int = 7
)

@Serializable
data class FeedbackNotificationSettings(
    val webhookEnabled: Boolean,
    val webhookEndpoint: String? = null,
    val includeBody: Boolean = false,
    val includeEvidence: Boolean = false
)

@Serializable
data class FeedbackNotificationAttempt(
    val retryCycle: Int,
    val attempt: Int,
    val status: String,
    val responseStatus: Int? = null,
    val error: String? = null,
    val createdAt: String
)

@Serializable
data class FeedbackNotificationDelivery(
    val id: String,
    val eventType: String,
    val status: String,
    val retryCycle: Int,
    val attemptCount: Int,
    val availableAt: String,
    val deliveredAt: String? = null,
    val lastError: String? = null,
    val createdAt: String,
    val attempts: List<FeedbackNotificationAttempt>
)

@Serializable
data class FeedbackExportRequest(
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val sessionId: String? = null,
    val format: String,
    val locale: String = "ja-JP",
    val timezone: String = "Asia/Tokyo"
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

data class StoredExport(
    val fileName: String,
    val contentType: String,
    val bytes: ByteArray
)

@Serializable
data class NotificationWebhookEvent(
    val schemaVersion: String = "1",
    val eventId: String,
    val requestId: String = "unknown",
    val eventType: String,
    val occurredAt: String,
    val tenantKey: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val sessionId: String,
    val threadId: String,
    val actor: Participant,
    val deepLink: String? = null,
    val body: String? = null,
    val evidenceUrl: String? = null
)

data class ResourceScope(
    val tenantId: String,
    val tenantKey: String,
    val applicationId: String,
    val environmentId: String? = null,
    val workspaceId: String? = null,
    val applicationKey: String,
    val environmentKey: String? = null,
    val externalWorkspaceKey: String? = null
)

data class StoredEvidence(
    val objectKey: String,
    val contentType: String,
    val bytes: ByteArray
)

data class ByteRange(val first: Int, val last: Int) {
    val length: Int get() = last - first + 1
}

data class IdempotentResponse(
    val status: Int,
    val body: JsonElement
)

enum class FeedbackPermission(val wireValue: String) {
    READ("feedback.read"),
    COMMENT("feedback.comment"),
    MANAGE("feedback.manage"),
    ADMIN("feedback.admin")
}

enum class ScopeKind {
    APPLICATION,
    WORKSPACE,
    SESSION,
    THREAD,
    MESSAGE,
    EXPORT
}

data class RoutePolicy(
    val method: String,
    val path: String,
    val permission: FeedbackPermission,
    val scopeKind: ScopeKind,
    val mutate: Boolean = false
)
