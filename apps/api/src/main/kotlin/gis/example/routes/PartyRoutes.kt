// 関係者・関係リンク CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.PartyListQuery
import gis.example.ProjectResourceType
import gis.example.createParty
import gis.example.createPartyRelationship
import gis.example.deleteParty
import gis.example.deletePartyRelationship
import gis.example.getParty
import gis.example.listParties
import gis.example.readRequiredUuid
import gis.example.requireProjectPermission
import gis.example.requireResourcePermission
import gis.example.updateParty
import gis.example.updatePartyRelationship
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

fun Route.partyRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/parties") {
        val params = call.request.queryParameters
        val projectId = requireUuid(
            params["projectId"] ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required"),
            "projectId"
        )
        call.requireProjectPermission(Action.BUSINESS_READ, projectId)
        val result = db.listParties(
            PartyListQuery(
                projectId = projectId,
                q = params["q"],
                partyType = params["partyType"],
                relationType = params["relationType"],
                linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                targetType = params["targetType"],
                limit = parseListLimit(params["limit"]),
                offset = parseListOffset(params["offset"])
            )
        )
        call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
        call.respond(result.items)
    }

    post("/api/parties") {
        val body = call.receive<JsonObject>()
        call.requireProjectPermission(Action.BUSINESS_WRITE, readRequiredUuid(body, "projectId"))
        call.respond(HttpStatusCode.Created, db.createParty(body))
    }

    get("/api/parties/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
        call.requireResourcePermission(db, Action.BUSINESS_READ, ProjectResourceType.PARTY, id)
        call.respond(db.getParty(id) ?: throw ApiException(HttpStatusCode.NotFound, "Party not found"))
    }

    patch("/api/parties/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.PARTY, id)
        call.respond(db.updateParty(id, call.receive<JsonObject>()))
    }

    delete("/api/parties/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.PARTY, id)
        db.deleteParty(id)
        call.respond(HttpStatusCode.NoContent)
    }

    post("/api/party-relationships") {
        val body = call.receive<JsonObject>()
        call.requireProjectPermission(Action.BUSINESS_WRITE, readRequiredUuid(body, "projectId"))
        call.respond(HttpStatusCode.Created, db.createPartyRelationship(body))
    }

    patch("/api/party-relationships/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Relationship id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.PARTY_RELATIONSHIP, id)
        call.respond(db.updatePartyRelationship(id, call.receive<JsonObject>()))
    }

    delete("/api/party-relationships/{id}") {
        val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Relationship id is required")
        call.requireResourcePermission(db, Action.BUSINESS_WRITE, ProjectResourceType.PARTY_RELATIONSHIP, id)
        db.deletePartyRelationship(id)
        call.respond(HttpStatusCode.NoContent)
    }
}
