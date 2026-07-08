// 土地 CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.LandListQuery
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.ProjectFromBodyField
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.authorizedJsonBody
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createLand
import gis.example.deleteLand
import gis.example.getLand
import gis.example.listLands
import gis.example.updateLand
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.landRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/lands", ProjectFromQuery(Action.BUSINESS_READ)) {
            val params = call.request.queryParameters
            val result = db.listLands(
                LandListQuery(
                    projectId = call.authorizedProjectId(),
                    q = params["q"],
                    status = params["status"],
                    landUse = params["landUse"],
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

        post("/api/lands", ProjectFromBodyField(Action.BUSINESS_WRITE)) {
            call.respond(HttpStatusCode.Created, db.createLand(call.authorizedJsonBody()))
        }

        get("/api/lands/{id}", ResourceFromPath(Action.BUSINESS_READ, ProjectResourceType.LAND)) {
            val id = call.authorizedResourceId()
            call.respond(db.getLand(id) ?: throw ApiException(HttpStatusCode.NotFound, "Land not found"))
        }

        patch("/api/lands/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.LAND)) {
            call.respond(db.updateLand(call.authorizedResourceId(), call.receive<JsonObject>()))
        }

        delete("/api/lands/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.LAND)) {
            db.deleteLand(call.authorizedResourceId())
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
