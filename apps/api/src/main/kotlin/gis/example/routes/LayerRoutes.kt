// レイヤ・結果セット系ルート (openapi.yaml tag: layers)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.deleteLayer
import gis.example.deleteResultSet
import gis.example.listAttributeValues
import gis.example.listLayers
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get

fun Route.layerRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/layers") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.LAYER_READ, projectId)
        call.respond(db.listLayers(projectId))
    }

    get("/api/layers/{id}/attribute-values") {
        val layerId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
            "Layer id"
        )
        val field = call.request.queryParameters["field"]
            ?: throw ApiException(HttpStatusCode.BadRequest, "Attribute field is required")
        val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 80
        call.requireResourcePermission(db, Action.LAYER_READ, ProjectResourceType.LAYER, layerId)
        call.respond(db.listAttributeValues(layerId, field, limit))
    }

    delete("/api/layers/{id}") {
        val id = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
            "Layer id"
        )
        call.requireResourcePermission(db, Action.LAYER_WRITE, ProjectResourceType.LAYER, id)
        db.deleteLayer(id)
        call.respond(HttpStatusCode.NoContent)
    }

    delete("/api/result-sets/{id}") {
        val id = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Result set id is required"),
            "Result set id"
        )
        call.requireResourcePermission(db, Action.LAYER_WRITE, ProjectResourceType.RESULT_SET, id)
        db.deleteResultSet(id)
        call.respond(HttpStatusCode.NoContent)
    }
}
