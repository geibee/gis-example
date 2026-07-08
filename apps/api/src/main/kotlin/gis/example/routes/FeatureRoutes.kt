// フィーチャ系ルート (openapi.yaml tag: features): 個別取得・更新と各種検索
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.BusinessSpatialSearchRequest
import gis.example.ConditionQueryDto
import gis.example.FeatureUpdateRequest
import gis.example.ProjectResourceType
import gis.example.conditionSearchFeatures
import gis.example.getBusinessLinks
import gis.example.getFeature
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import gis.example.searchBusinessSpatialFeatures
import gis.example.searchFeatures
import gis.example.updateFeature
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post

fun Route.featureRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/layers/{id}/features/{featureId}") {
        val layerId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
            "Layer id"
        )
        val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
        call.requireResourcePermission(db, Action.FEATURE_READ, ProjectResourceType.LAYER, layerId)
        call.respond(db.getFeature(layerId, featureId))
    }

    patch("/api/layers/{id}/features/{featureId}") {
        val layerId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
            "Layer id"
        )
        val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
        call.requireResourcePermission(db, Action.FEATURE_WRITE, ProjectResourceType.LAYER, layerId)
        val request = call.receive<FeatureUpdateRequest>()
        call.respond(db.updateFeature(layerId, featureId, request))
    }

    get("/api/features/search") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.FEATURE_READ, projectId)
        call.respond(
            db.searchFeatures(
                projectId = projectId,
                layerId = optionalUuid(params["layerId"], "layerId"),
                q = params["q"],
                field = params["field"],
                operator = params["operator"],
                value = params["value"],
                linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                limit = params["limit"]?.toIntOrNull() ?: 50
            )
        )
    }

    post("/api/features/business-spatial-search") {
        val request = call.receive<BusinessSpatialSearchRequest>()
        val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: db.defaultProjectId()
        call.requireProjectPermission(Action.FEATURE_READ, projectId)
        call.respond(db.searchBusinessSpatialFeatures(request))
    }

    post("/api/features/condition-search") {
        val request = call.receive<ConditionQueryDto>()
        val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: db.defaultProjectId()
        call.requireProjectPermission(Action.FEATURE_READ, projectId)
        call.respond(db.conditionSearchFeatures(request))
    }

    get("/api/features/{layerId}/{featureId}/business-links") {
        val layerId = requireUuid(
            call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
            "Layer id"
        )
        val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
        call.requireResourcePermission(db, Action.FEATURE_READ, ProjectResourceType.LAYER, layerId)
        call.respond(db.getBusinessLinks(layerId, featureId))
    }
}
