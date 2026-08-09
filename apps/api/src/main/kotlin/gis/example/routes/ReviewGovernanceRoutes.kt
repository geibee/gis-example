// レビュー証跡の保存方針と期限切れ削除 (openapi.yaml tag: review)。
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ReviewRetentionPurgeResultDto
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.auditTrail
import gis.example.authorizedProjectId
import gis.example.authorizedRoutes
import gis.example.getReviewRetentionPolicy
import gis.example.listExpiredReviewEvidence
import gis.example.purgeExpiredReviewEvidence
import gis.example.readEvidenceRetentionDays
import gis.example.updateReviewRetentionPolicy
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import org.slf4j.LoggerFactory

private val reviewGovernanceLogger = LoggerFactory.getLogger("gis.example.ReviewGovernance")

fun Route.reviewGovernanceRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/review-retention", ProjectFromQuery(Action.REVIEW_READ)) {
            call.respond(db.getReviewRetentionPolicy(call.authorizedProjectId()))
        }

        patch("/api/review-retention", ProjectFromQuery(Action.REVIEW_MANAGE)) {
            val request = call.receive<JsonObject>()
            if ("defaultEvidenceRetentionDays" !in request) {
                throw ApiException(HttpStatusCode.BadRequest, "defaultEvidenceRetentionDays is required")
            }
            call.respond(
                db.updateReviewRetentionPolicy(
                    projectId = call.authorizedProjectId(),
                    defaultEvidenceRetentionDays = readEvidenceRetentionDays(
                        request,
                        "defaultEvidenceRetentionDays"
                    ),
                    audit = call.auditTrail()
                )
            )
        }

        // 外部スケジューラから定期実行できる冪等な小分け削除。editor が手動実行することもできる。
        post("/api/review-retention/purge", ProjectFromQuery(Action.REVIEW_MANAGE)) {
            val projectId = call.authorizedProjectId()
            val candidates = db.listExpiredReviewEvidence(
                projectId,
                parseListLimit(call.request.queryParameters["limit"])
            )
            var purgedCount = 0
            var purgedBytes = 0L
            var failedCount = 0
            val audit = call.auditTrail()
            for (evidence in candidates) {
                val purged = runCatching {
                    withContext(Dispatchers.IO) {
                        db.purgeExpiredReviewEvidence(
                            projectId = projectId,
                            evidence = evidence,
                            deleteBlob = deps.uploadStorage::delete,
                            audit = audit
                        )
                    }
                }.onFailure { error ->
                    reviewGovernanceLogger.warn("期限切れレビュー証跡の削除に失敗しました: {}", evidence.id, error)
                }.getOrElse {
                    failedCount += 1
                    false
                }
                if (purged) {
                    purgedCount += 1
                    purgedBytes += evidence.byteSize
                }
            }
            val remaining = db.getReviewRetentionPolicy(projectId)
            call.respond(
                ReviewRetentionPurgeResultDto(
                    purgedEvidenceCount = purgedCount,
                    purgedEvidenceBytes = purgedBytes,
                    failedEvidenceCount = failedCount,
                    remainingExpiredEvidenceCount = remaining.expiredEvidenceCount
                )
            )
        }
    }
}
