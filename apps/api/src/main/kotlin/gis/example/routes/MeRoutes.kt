// 自分自身の情報 (openapi.yaml tag: admin の /api/me)
package gis.example.routes

import gis.example.MeDto
import gis.example.MembershipDto
import gis.example.SystemRole
import gis.example.appPrincipal
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get

fun Route.meRoutes() {
    get("/api/me") {
        val principal = call.appPrincipal()
        call.respond(
            MeDto(
                userId = principal.userId,
                subject = principal.subject,
                email = principal.email,
                displayName = principal.displayName,
                systemRole = if (principal.systemRole == SystemRole.ADMIN) "admin" else "user",
                memberships = principal.memberships.map { (projectId, role) ->
                    MembershipDto(projectId = projectId, role = role.name.lowercase())
                }.sortedBy { it.projectId }
            )
        )
    }
}
