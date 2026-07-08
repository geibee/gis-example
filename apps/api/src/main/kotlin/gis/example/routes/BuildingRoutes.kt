// 建物 CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.BuildingListQuery
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.ProjectFromBodyField
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.auditTrail
import gis.example.authorizedJsonBody
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createBuilding
import gis.example.deleteBuilding
import gis.example.getBuilding
import gis.example.listBuildings
import gis.example.updateBuilding
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.buildingRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/buildings", ProjectFromQuery(Action.BUSINESS_READ)) {
            val params = call.request.queryParameters
            val result = db.listBuildings(
                BuildingListQuery(
                    projectId = call.authorizedProjectId(),
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

        post("/api/buildings", ProjectFromBodyField(Action.BUSINESS_WRITE)) {
            call.respond(HttpStatusCode.Created, db.createBuilding(call.authorizedJsonBody(), call.auditTrail()))
        }

        get("/api/buildings/{id}", ResourceFromPath(Action.BUSINESS_READ, ProjectResourceType.BUILDING)) {
            val id = call.authorizedResourceId()
            call.respond(db.getBuilding(id) ?: throw ApiException(HttpStatusCode.NotFound, "Building not found"))
        }

        patch("/api/buildings/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.BUILDING)) {
            call.respond(db.updateBuilding(call.authorizedResourceId(), call.receive<JsonObject>(), call.auditTrail()))
        }

        delete("/api/buildings/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.BUILDING)) {
            db.deleteBuilding(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
