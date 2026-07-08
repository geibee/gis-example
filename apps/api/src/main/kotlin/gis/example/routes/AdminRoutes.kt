// システム管理系ルート (openapi.yaml tag: admin): ユーザー管理・プロジェクトメンバー管理 (system admin 専用)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.MemberPutRequest
import gis.example.UserPatchRequest
import gis.example.appPrincipal
import gis.example.deleteProjectMember
import gis.example.listProjectMembers
import gis.example.listUsers
import gis.example.putProjectMember
import gis.example.requireSystemPermission
import gis.example.updateUser
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.put

fun Route.adminRoutes(deps: AppDependencies) {
    val db = deps.db

    get("/api/users") {
        call.requireSystemPermission(Action.USER_ADMIN)
        call.respond(db.listUsers())
    }

    patch("/api/users/{id}") {
        call.requireSystemPermission(Action.USER_ADMIN)
        val id = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "User id is required"),
            "User id"
        )
        // 自分自身の降格・無効化は禁止する (管理者のロックアウト防止)
        if (id == call.appPrincipal().userId) {
            throw ApiException(HttpStatusCode.BadRequest, "Cannot change your own role or active status")
        }
        call.respond(db.updateUser(id, call.receive<UserPatchRequest>()))
    }

    get("/api/projects/{id}/members") {
        call.requireSystemPermission(Action.MEMBER_ADMIN)
        val projectId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Project id is required"),
            "Project id"
        )
        if (!db.projectExists(projectId)) {
            throw ApiException(HttpStatusCode.NotFound, "Project not found")
        }
        call.respond(db.listProjectMembers(projectId))
    }

    put("/api/projects/{id}/members/{userId}") {
        call.requireSystemPermission(Action.MEMBER_ADMIN)
        val projectId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Project id is required"),
            "Project id"
        )
        val userId = requireUuid(
            call.parameters["userId"] ?: throw ApiException(HttpStatusCode.BadRequest, "User id is required"),
            "User id"
        )
        val request = call.receive<MemberPutRequest>()
        call.respond(db.putProjectMember(projectId, userId, request.role))
    }

    delete("/api/projects/{id}/members/{userId}") {
        call.requireSystemPermission(Action.MEMBER_ADMIN)
        val projectId = requireUuid(
            call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Project id is required"),
            "Project id"
        )
        val userId = requireUuid(
            call.parameters["userId"] ?: throw ApiException(HttpStatusCode.BadRequest, "User id is required"),
            "User id"
        )
        db.deleteProjectMember(projectId, userId)
        call.respond(HttpStatusCode.NoContent)
    }
}
