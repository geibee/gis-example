// system 系ルート (openapi.yaml tag: system): ヘルスチェックとプロジェクト一覧
package gis.example.routes

import gis.example.Database
import gis.example.RouteAuthz.AuthenticatedOnly
import gis.example.SystemRole
import gis.example.appPrincipal
import gis.example.authorizedRoutes
import gis.example.unauthenticatedGet
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import org.slf4j.LoggerFactory

private val healthLogger = LoggerFactory.getLogger("gis.example.Health")

// /health 系だけは認証の外に置く (Application.kt の routing 直下で登録する)。
// liveness と readiness を分離する (issue #18):
// - /health (liveness): プロセスが応答できるかのみ。依存 (DB) には触れない。
//   DB 断で全タスクを再起動の無限ループに落とさないため、liveness に依存チェックを入れない
// - /health/ready (readiness): DB 疎通 (SELECT 1) まで確認する。ALB ターゲットグループの
//   ヘルスチェックはこちらを向け、DB に到達できないタスクをルーティングから外す
fun Route.healthRoutes(db: Database, readinessTimeoutMillis: Long) {
    unauthenticatedGet("/health", "死活監視用 (liveness)。プロセス生存のみを返し依存には触れない") {
        call.respond(mapOf("status" to "ok"))
    }
    unauthenticatedGet("/health/ready", "ALB ヘルスチェック用 (readiness)。DB 疎通を短タイムアウトで確認する") {
        // 疎通確認はリクエストとは別ジョブ (application スコープ) で走らせ、await だけを
        // 打ち切る。withContext を直接 withTimeout で包むと、withContext はブロッキング中の
        // ブロック完了まで戻らないため応答が readinessTimeoutMillis を超えてしまう。
        // 打ち切られた JDBC 呼び出し自体は中断されず、最悪 DATABASE_CONNECTION_TIMEOUT_MS まで
        // IO スレッドを占有するが、応答は必ず readinessTimeoutMillis 以内に返る
        val ping = call.application.async(Dispatchers.IO) {
            runCatching { db.ping() }
        }
        val result = withTimeoutOrNull(readinessTimeoutMillis) { ping.await() }
        if (result?.isSuccess == true) {
            call.respond(mapOf("status" to "ok"))
        } else {
            when (val cause = result?.exceptionOrNull()) {
                null -> healthLogger.warn("readiness check timed out after {} ms", readinessTimeoutMillis)
                else -> healthLogger.warn("readiness check failed", cause)
            }
            call.respond(HttpStatusCode.ServiceUnavailable, mapOf("status" to "unavailable"))
        }
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
