// system 系ルート (openapi.yaml tag: system): ヘルスチェックとプロジェクト一覧
package gis.example.routes

import gis.example.SystemRole
import gis.example.appPrincipal
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get

// /health だけは認証の外に置く (Application.kt の routing 直下で登録する)
fun Route.healthRoutes() {
    get("/health") {
        call.respond(mapOf("status" to "ok"))
    }
}

fun Route.projectRoutes(deps: AppDependencies) {
    get("/api/projects") {
        // 非 admin にはメンバーであるプロジェクトのみ返す (テナント列挙の防止)
        val principal = call.appPrincipal()
        val projects = deps.db.listProjects()
        call.respond(
            if (principal.systemRole == SystemRole.ADMIN) projects
            else projects.filter { it.id in principal.memberships }
        )
    }
}
