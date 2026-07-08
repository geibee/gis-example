// 区域 CRUD・区域レイヤ生成ルート (openapi.yaml tag: zones)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.CheckedInHandler
import gis.example.RouteAuthz.ProjectFromBodyField
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.ZoneLayerFromImportRequest
import gis.example.ZoneListQuery
import gis.example.auditTrail
import gis.example.authorizedJsonBody
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createZone
import gis.example.createZoneLayerFromImport
import gis.example.deleteZone
import gis.example.getZone
import gis.example.getZonePartySummary
import gis.example.listZones
import gis.example.requireResourcePermission
import gis.example.updateZone
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.zoneRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/zones", ProjectFromQuery(Action.BUSINESS_READ)) {
            val params = call.request.queryParameters
            val result = db.listZones(
                ZoneListQuery(
                    projectId = call.authorizedProjectId(),
                    q = params["q"],
                    status = params["status"],
                    zoneType = params["zoneType"],
                    linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                    zoneLayerId = optionalUuid(params["zoneLayerId"], "zoneLayerId"),
                    sourceLayerId = params["sourceLayerId"],
                    limit = parseListLimit(params["limit"]),
                    offset = parseListOffset(params["offset"])
                )
            )
            call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
            call.respond(result.items)
        }

        post("/api/zones", ProjectFromBodyField(Action.BUSINESS_WRITE)) {
            call.respond(HttpStatusCode.Created, db.createZone(call.authorizedJsonBody(), call.auditTrail()))
        }

        get("/api/zones/{id}", ResourceFromPath(Action.BUSINESS_READ, ProjectResourceType.ZONE)) {
            val id = call.authorizedResourceId()
            call.respond(db.getZone(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
        }

        get("/api/zones/{id}/party-summary", ResourceFromPath(Action.BUSINESS_READ, ProjectResourceType.ZONE)) {
            val id = call.authorizedResourceId()
            call.respond(db.getZonePartySummary(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
        }

        patch("/api/zones/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.ZONE)) {
            call.respond(db.updateZone(call.authorizedResourceId(), call.receive<JsonObject>(), call.auditTrail()))
        }

        delete("/api/zones/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.ZONE)) {
            db.deleteZone(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }

        post(
            "/api/zone-layers/from-import",
            CheckedInHandler(Action.LAYER_WRITE, "対象 layerId がボディにあり trim・空文字検証と認可判定が分離できない")
        ) {
            val request = call.receive<ZoneLayerFromImportRequest>()
            val layerId = request.layerId.trim().takeIf { it.isNotEmpty() }
                ?: throw ApiException(HttpStatusCode.BadRequest, "layerId is required")
            call.requireResourcePermission(db, Action.LAYER_WRITE, ProjectResourceType.LAYER, layerId)
            call.respond(HttpStatusCode.Created, db.createZoneLayerFromImport(request, call.auditTrail()))
        }
    }
}
