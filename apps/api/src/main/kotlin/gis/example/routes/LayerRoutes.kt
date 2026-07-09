// レイヤ・結果セット系ルート (openapi.yaml tag: layers)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.auditTrail
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.deleteLayer
import gis.example.deleteResultSet
import gis.example.listAttributeValues
import gis.example.listLayers
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

fun Route.layerRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/layers", ProjectFromQuery(Action.LAYER_READ)) {
            call.respond(db.listLayers(call.authorizedProjectId()))
        }

        get(
            "/api/layers/{id}/attribute-values",
            ResourceFromPath(Action.LAYER_READ, ProjectResourceType.LAYER, uuidLabel = "Layer id")
        ) {
            val layerId = call.authorizedResourceId()
            val field = call.request.queryParameters["field"]
                ?: throw ApiException(HttpStatusCode.BadRequest, "Attribute field is required")
            val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 80
            call.respond(db.listAttributeValues(layerId, field, limit))
        }

        delete(
            "/api/layers/{id}",
            ResourceFromPath(Action.LAYER_WRITE, ProjectResourceType.LAYER, uuidLabel = "Layer id")
        ) {
            db.deleteLayer(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }

        delete(
            "/api/result-sets/{id}",
            ResourceFromPath(Action.LAYER_WRITE, ProjectResourceType.RESULT_SET, uuidLabel = "Result set id")
        ) {
            db.deleteResultSet(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
