// 関係者・関係リンク CRUD ルート (openapi.yaml tag: business)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.PartyListQuery
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.ProjectFromBodyField
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.auditTrail
import gis.example.authorizedJsonBody
import gis.example.authorizedProjectId
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createParty
import gis.example.createPartyRelationship
import gis.example.deleteParty
import gis.example.deletePartyRelationship
import gis.example.getParty
import gis.example.listParties
import gis.example.updateParty
import gis.example.updatePartyRelationship
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.json.JsonObject

fun Route.partyRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get("/api/parties", ProjectFromQuery(Action.BUSINESS_READ)) {
            val params = call.request.queryParameters
            val result = db.listParties(
                PartyListQuery(
                    projectId = call.authorizedProjectId(),
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

        post("/api/parties", ProjectFromBodyField(Action.BUSINESS_WRITE)) {
            call.respond(HttpStatusCode.Created, db.createParty(call.authorizedJsonBody(), call.auditTrail()))
        }

        get("/api/parties/{id}", ResourceFromPath(Action.BUSINESS_READ, ProjectResourceType.PARTY)) {
            val id = call.authorizedResourceId()
            call.respond(db.getParty(id) ?: throw ApiException(HttpStatusCode.NotFound, "Party not found"))
        }

        patch("/api/parties/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.PARTY)) {
            call.respond(db.updateParty(call.authorizedResourceId(), call.receive<JsonObject>(), call.auditTrail()))
        }

        delete("/api/parties/{id}", ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.PARTY)) {
            db.deleteParty(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }

        post("/api/party-relationships", ProjectFromBodyField(Action.BUSINESS_WRITE)) {
            call.respond(HttpStatusCode.Created, db.createPartyRelationship(call.authorizedJsonBody(), call.auditTrail()))
        }

        patch(
            "/api/party-relationships/{id}",
            ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.PARTY_RELATIONSHIP)
        ) {
            call.respond(db.updatePartyRelationship(call.authorizedResourceId(), call.receive<JsonObject>(), call.auditTrail()))
        }

        delete(
            "/api/party-relationships/{id}",
            ResourceFromPath(Action.BUSINESS_WRITE, ProjectResourceType.PARTY_RELATIONSHIP)
        ) {
            db.deletePartyRelationship(call.authorizedResourceId(), call.auditTrail())
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
