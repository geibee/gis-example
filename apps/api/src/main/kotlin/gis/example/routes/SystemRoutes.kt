// system 系ルート (openapi.yaml tag: system): ヘルスチェックとプロジェクト一覧
package gis.example.routes

import gis.example.RouteAuthz.AuthenticatedOnly
import gis.example.SystemRole
import gis.example.appPrincipal
import gis.example.authorizedRoutes
import gis.example.unauthenticatedGet
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route

// /health だけは認証の外に置く (Application.kt の routing 直下で登録する)
fun Route.healthRoutes() {
    unauthenticatedGet("/health", "死活監視用。認証なしで公開する唯一のルート") {
        call.respond(mapOf("status" to "ok"))
    }
}

fun Route.projectRoutes(deps: AppDependencies) = authorizedRoutes(deps.db) {
    get("/api/projects", AuthenticatedOnly("メンバーシップで結果をフィルタして返すため全認証ユーザーが呼べる")) {
        // 非 admin にはメンバーであるプロジェクトのみ返す (テナント列挙の防止)
        val principal = call.appPrincipal()
        val projects = deps.db.listProjects()
        call.respond(
            if (principal.systemRole == SystemRole.ADMIN) projects
            else projects.filter { it.id in principal.memberships }
        )
    }
}
