// フィーチャ系ルート (openapi.yaml tag: features): 個別取得・更新と各種検索
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.BusinessSpatialSearchRequest
import gis.example.ConditionQueryDto
import gis.example.FeatureUpdateRequest
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.CheckedInHandler
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.auditTrail
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.conditionSearchFeatures
import gis.example.getBusinessLinks
import gis.example.getFeature
import gis.example.requireProjectPermission
import gis.example.searchBusinessSpatialFeatures
import gis.example.searchFeatures
import gis.example.updateFeature
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

fun Route.featureRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get(
            "/api/layers/{id}/features/{featureId}",
            ResourceFromPath(Action.FEATURE_READ, ProjectResourceType.LAYER, uuidLabel = "Layer id")
        ) {
            val layerId = call.authorizedResourceId()
            val featureId = call.parameters["featureId"]
                ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            call.respond(db.getFeature(layerId, featureId))
        }

        patch(
            "/api/layers/{id}/features/{featureId}",
            ResourceFromPath(Action.FEATURE_WRITE, ProjectResourceType.LAYER, uuidLabel = "Layer id")
        ) {
            val layerId = call.authorizedResourceId()
            val featureId = call.parameters["featureId"]
                ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            val request = call.receive<FeatureUpdateRequest>()
            call.respond(db.updateFeature(layerId, featureId, request, call.auditTrail()))
        }

        get("/api/features/search", ProjectFromQuery(Action.FEATURE_READ)) {
            val params = call.request.queryParameters
            call.respond(
                db.searchFeatures(
                    projectId = call.authorizedProjectId(),
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

        post(
            "/api/features/business-spatial-search",
            CheckedInHandler(Action.FEATURE_READ, "projectId 省略時に既定プロジェクトへフォールバックするためボディ解釈と認可判定が分離できない")
        ) {
            val request = call.receive<BusinessSpatialSearchRequest>()
            val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: db.defaultProjectId()
            call.requireProjectPermission(Action.FEATURE_READ, projectId)
            call.respond(db.searchBusinessSpatialFeatures(request))
        }

        post(
            "/api/features/condition-search",
            CheckedInHandler(Action.FEATURE_READ, "projectId 省略時に既定プロジェクトへフォールバックするためボディ解釈と認可判定が分離できない")
        ) {
            val request = call.receive<ConditionQueryDto>()
            val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: db.defaultProjectId()
            call.requireProjectPermission(Action.FEATURE_READ, projectId)
            call.respond(db.conditionSearchFeatures(request))
        }

        get(
            "/api/features/{layerId}/{featureId}/business-links",
            ResourceFromPath(Action.FEATURE_READ, ProjectResourceType.LAYER, param = "layerId", uuidLabel = "Layer id")
        ) {
            val layerId = call.authorizedResourceId()
            val featureId = call.parameters["featureId"]
                ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            call.respond(db.getBusinessLinks(layerId, featureId))
        }
    }
}
