// 建物 CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.BuildingListQuery
import gis.example.ProjectResourceType
import gis.example.createBuilding
import gis.example.deleteBuilding
import gis.example.getBuilding
import gis.example.listBuildings
import gis.example.readRequiredUuid
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import gis.example.updateBuilding
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

fun Route.buildingRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/buildings") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.BUSINESS_READ, projectId)
        val result = db.listBuildings(
            BuildingListQuery(
                projectId = projectId,
                q = params["q"],
                landId = params["landId"],
                status = params["status"],
                buildingUse = params["buildingUse"],
                partyType = params["partyType"],
                relationType = params["relationType"],
                linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                sourceLayerId = optionalUuid(params["sourceLayerId"], "sourceLayerId"),
                bbox = params["bbox"],
                intersectsLayerId = optionalUuid(params["intersectsLayerId"], "intersectsLayerId"),
                intersectsFeatureId = params["intersectsFeatureId"],
                distanceMeters = params["distanceMeters"]?.toDoubleOrNull(),
                limit = parseListLimit(params["limit"]),
                offset = parseListOffset(params["offset"])
            )
        )
        call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
        call.respond(result.items)
    }

    post("/api/buildings") {
        val body = call.receive<JsonObject>()
        call.requireProjectPermission(Action.BUSINESS_WRITE, readRequiredUuid(body, "projectId"))
        call.respond(HttpStatusCode.Created, db.createBuilding(body))
    }

    get("/api/buildings/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
        call.requireResourcePermission(db, Action.BUSINESS_READ, ProjectResourceType.BUILDING, id)
        call.respond(db.getBuilding(id) ?: throw ApiException(HttpStatusCode.NotFound, "Building not found"))
    }

    patch("/api/buildings/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.BUILDING, id)
        call.respond(db.updateBuilding(id, call.receive<JsonObject>()))
    }

    delete("/api/buildings/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.BUILDING, id)
        db.deleteBuilding(id)
        call.respond(HttpStatusCode.NoContent)
    }
}
