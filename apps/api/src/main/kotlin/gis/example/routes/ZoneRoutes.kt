// 区域 CRUD・区域レイヤ生成ルート (openapi.yaml tag: zones)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.ZoneLayerFromImportRequest
import gis.example.ZoneListQuery
import gis.example.createZone
import gis.example.createZoneLayerFromImport
import gis.example.deleteZone
import gis.example.getZone
import gis.example.getZonePartySummary
import gis.example.listZones
import gis.example.readRequiredUuid
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import gis.example.updateZone
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import kotlinx.serialization.json.JsonObject

fun Route.zoneRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/zones") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.BUSINESS_READ, projectId)
        val result = db.listZones(
            ZoneListQuery(
                projectId = projectId,
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

    post("/api/zones") {
        val body = call.receive<JsonObject>()
        call.requireProjectPermission(Action.BUSINESS_WRITE, readRequiredUuid(body, "projectId"))
        call.respond(HttpStatusCode.Created, db.createZone(body))
    }

    get("/api/zones/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
        call.requireResourcePermission(db, Action.BUSINESS_READ, ProjectResourceType.ZONE, id)
        call.respond(db.getZone(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
    }

    get("/api/zones/{id}/party-summary") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
        call.requireResourcePermission(db, Action.BUSINESS_READ, ProjectResourceType.ZONE, id)
        call.respond(db.getZonePartySummary(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
    }

    patch("/api/zones/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.ZONE, id)
        call.respond(db.updateZone(id, call.receive<JsonObject>()))
    }

    delete("/api/zones/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.ZONE, id)
        db.deleteZone(id)
        call.respond(HttpStatusCode.NoContent)
    }

    post("/api/zone-layers/from-import") {
        val request = call.receive<ZoneLayerFromImportRequest>()
        val layerId = request.layerId.trim().takeIf { it.isNotEmpty() }
            ?: throw ApiException(HttpStatusCode.BadRequest, "layerId is required")
        call.requireResourcePermission(db, Action.LAYER_WRITE, ProjectResourceType.LAYER, layerId)
        call.respond(HttpStatusCode.Created, db.createZoneLayerFromImport(request))
    }
}
