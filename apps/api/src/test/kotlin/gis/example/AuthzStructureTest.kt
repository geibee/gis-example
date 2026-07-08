package gis.example

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.auth.authentication
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// 認可の構造的強制 (fail-closed) を検証する:
// - 起動時検証: 認可宣言なしで登録されたルート (生の get) があると起動に失敗する
// - 実行時ガード: 認可判定マーカーのない 2xx 応答は 500 に置き換えられ、内容が漏れない
// - 宣言 DSL: 宣言された Action がハンドラ実行前に PDP で判定される
// DB 接続は不要 (接続しない限り HikariDataSource は繋ぎにいかない)
class AuthzStructureTest {

    private fun dummyDb() = Database(HikariDataSource())

    private fun principalOf(role: SystemRole) = AppPrincipal(
        userId = "00000000-0000-4000-8000-00000000000a",
        subject = "authz-structure-test",
        email = null,
        displayName = null,
        systemRole = role,
        memberships = emptyMap()
    )

    // ---------------------------------------------------------------- 起動時検証

    @Test
    fun `認可宣言のない生ルートがあると起動時検証が失敗する`() = testApplication {
        application {
            val root = routing {
                unauthenticatedGet("/health", "テスト用の公開ルート") { call.respondText("ok") }
                authorizedRoutes(dummyDb()) {
                    get("/declared", RouteAuthz.AuthenticatedOnly("テスト用")) { call.respondText("ok") }
                }
                // わざと素の get で登録する = 認可宣言の呼び忘れを再現する
                get("/rogue") { call.respondText("認可宣言なし") }
            }
            val failure = assertFailsWith<IllegalStateException> { validateAuthorizedRoutes(root) }
            assertTrue("rogue" in failure.message.orEmpty(), "違反ルートのパスが列挙される: ${failure.message}")
        }
        startApplication()
    }

    @Test
    fun `全ルートが宣言済みなら起動時検証を通過する`() = testApplication {
        application {
            val root = routing {
                unauthenticatedGet("/health", "テスト用の公開ルート") { call.respondText("ok") }
                authorizedRoutes(dummyDb()) {
                    get("/declared", RouteAuthz.SystemAction(Action.USER_ADMIN)) { call.respondText("ok") }
                }
            }
            validateAuthorizedRoutes(root)
        }
        startApplication()
    }

    // ---------------------------------------------------------------- 実行時ガード

    private fun ApplicationTestBuilder.guardedApp(role: SystemRole?) {
        application {
            install(ContentNegotiation) { json() }
            install(StatusPages) {
                exception<ApiException> { call, cause ->
                    call.respond(cause.status, ErrorResponse(cause.message))
                }
            }
            if (role != null) {
                // 認証済み状態を模す (OIDC を通さず principal を直接置く)
                intercept(ApplicationCallPipeline.Plugins) {
                    call.authentication.principal(principalOf(role))
                }
            }
            routing {
                install(authzGuardPlugin(null))
                authorizedRoutes(dummyDb()) {
                    // CheckedInHandler なのにハンドラが PEP (call.require*) を呼び忘れたバグの再現
                    get("/forgotten", RouteAuthz.CheckedInHandler(Action.PROJECT_READ, "テスト用: 呼び忘れの再現")) {
                        call.respondText("認可なしで通ってはいけない応答")
                    }
                    // 宣言 DSL がハンドラ前に PDP 判定するルート
                    get("/checked", RouteAuthz.SystemAction(Action.USER_ADMIN)) {
                        call.respondText("ok")
                    }
                }
            }
        }
    }

    @Test
    fun `認可判定なしの 2xx 応答は 500 に置き換えられ内容が漏れない`() = testApplication {
        guardedApp(SystemRole.ADMIN)
        val response = client.get("/forgotten")
        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertFalse("通ってはいけない" in body, "元の応答内容を漏らさない: $body")
        assertTrue("Internal server error" in body)
    }

    @Test
    fun `宣言された Action は PDP で判定され admin は許可される`() = testApplication {
        guardedApp(SystemRole.ADMIN)
        val response = client.get("/checked")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("ok", response.bodyAsText())
    }

    @Test
    fun `宣言された Action は PDP で判定され権限のないユーザーは 403 になる`() = testApplication {
        guardedApp(SystemRole.USER)
        val response = client.get("/checked")
        assertEquals(HttpStatusCode.Forbidden, response.status)
    }
}
