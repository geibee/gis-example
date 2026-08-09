// レビュー通知・外部連携設定 (openapi.yaml tag: review)。接続先 URL / token は返さない。
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.appPrincipal
import gis.example.auditTrail
import gis.example.authorizedProjectId
import gis.example.authorizedRoutes
import gis.example.getReviewNotificationSettings
import gis.example.readOptionalBoolean
import gis.example.retryFailedReviewNotifications
import gis.example.updateReviewNotificationSettings
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.reviewNotificationRoutes(deps: AppDependencies) {
    val db = deps.db
    authorizedRoutes(db) {
        get("/api/review-notifications", ProjectFromQuery(Action.REVIEW_READ)) {
            call.respond(
                db.getReviewNotificationSettings(
                    call.authorizedProjectId(),
                    deps.reviewNotificationCapabilities
                )
            )
        }

        patch("/api/review-notifications", ProjectFromQuery(Action.REVIEW_MANAGE)) {
            val request = call.receive<JsonObject>()
            val emailEnabled = request.requiredBoolean("emailEnabled")
            val teamsEnabled = request.requiredBoolean("teamsEnabled")
            val issueEnabled = request.requiredBoolean("issueEnabled")
            val capabilities = deps.reviewNotificationCapabilities
            if (emailEnabled && !capabilities.email) {
                throw ApiException(HttpStatusCode.Conflict, "Email の配信先がサーバーに設定されていません")
            }
            if (teamsEnabled && !capabilities.teams) {
                throw ApiException(HttpStatusCode.Conflict, "Teams Webhook がサーバーに設定されていません")
            }
            if (issueEnabled && !capabilities.issue) {
                throw ApiException(HttpStatusCode.Conflict, "Issue Webhook がサーバーに設定されていません")
            }
            call.respond(
                db.updateReviewNotificationSettings(
                    projectId = call.authorizedProjectId(),
                    emailEnabled = emailEnabled,
                    teamsEnabled = teamsEnabled,
                    issueEnabled = issueEnabled,
                    updatedBy = call.appPrincipal().userId,
                    capabilities = capabilities,
                    audit = call.auditTrail()
                )
            )
        }

        post("/api/review-notifications/retry", ProjectFromQuery(Action.REVIEW_MANAGE)) {
            call.respond(
                db.retryFailedReviewNotifications(
                    call.authorizedProjectId(),
                    call.auditTrail()
                )
            )
        }
    }
}

private fun JsonObject.requiredBoolean(key: String): Boolean =
    readOptionalBoolean(this, key)
        ?: throw ApiException(HttpStatusCode.BadRequest, "$key is required and must be a boolean")
