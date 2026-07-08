// 土地 CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.LandListQuery
import gis.example.ProjectResourceType
import gis.example.createLand
import gis.example.deleteLand
import gis.example.getLand
import gis.example.listLands
import gis.example.readRequiredUuid
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import gis.example.updateLand
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

fun Route.landRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/lands") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.BUSINESS_READ, projectId)
        val result = db.listLands(
            LandListQuery(
                projectId = projectId,
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

    post("/api/lands") {
        val body = call.receive<JsonObject>()
        call.requireProjectPermission(Action.BUSINESS_WRITE, readRequiredUuid(body, "projectId"))
        call.respond(HttpStatusCode.Created, db.createLand(body))
    }

    get("/api/lands/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
        call.requireResourcePermission(db, Action.BUSINESS_READ, ProjectResourceType.LAND, id)
        call.respond(db.getLand(id) ?: throw ApiException(HttpStatusCode.NotFound, "Land not found"))
    }

    patch("/api/lands/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.LAND, id)
        call.respond(db.updateLand(id, call.receive<JsonObject>()))
    }

    delete("/api/lands/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.LAND, id)
        db.deleteLand(id)
        call.respond(HttpStatusCode.NoContent)
    }
}
