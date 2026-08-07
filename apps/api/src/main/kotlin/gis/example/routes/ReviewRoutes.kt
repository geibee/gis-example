// レビューセッション管理ルート (openapi.yaml tag: review)。設計は docs/prototype-review.md
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.ReviewSessionListQuery
import gis.example.RouteAuthz.ProjectFromBodyField
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.appPrincipal
import gis.example.auditTrail
import gis.example.authorizedJsonBody
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createReviewSession
import gis.example.getReviewSession
import gis.example.listReviewSessions
import gis.example.updateReviewSession
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.reviewRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        // レビュー対象者 (viewer) もガイドを読むため READ 側は REVIEW_READ
        get("/api/review-sessions", ProjectFromQuery(Action.REVIEW_READ)) {
            val params = call.request.queryParameters
            val result = db.listReviewSessions(
                ReviewSessionListQuery(
                    projectId = call.authorizedProjectId(),
                    status = params["status"],
                    limit = parseListLimit(params["limit"]),
                    offset = parseListOffset(params["offset"])
                )
            )
            call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
            call.respond(result.items)
        }

        post("/api/review-sessions", ProjectFromBodyField(Action.REVIEW_MANAGE)) {
            val createdBy = call.appPrincipal().userId
            call.respond(
                HttpStatusCode.Created,
                db.createReviewSession(call.authorizedJsonBody(), createdBy, call.auditTrail())
            )
        }

        get(
            "/api/review-sessions/{id}",
            ResourceFromPath(Action.REVIEW_READ, ProjectResourceType.REVIEW_SESSION, uuidLabel = "id")
        ) {
            val id = call.authorizedResourceId()
            call.respond(
                db.getReviewSession(id)
                    ?: throw ApiException(HttpStatusCode.NotFound, "Review session not found")
            )
        }

        patch(
            "/api/review-sessions/{id}",
            ResourceFromPath(Action.REVIEW_MANAGE, ProjectResourceType.REVIEW_SESSION, uuidLabel = "id")
        ) {
            call.respond(
                db.updateReviewSession(call.authorizedResourceId(), call.receive<JsonObject>(), call.auditTrail())
            )
        }
    }
}
