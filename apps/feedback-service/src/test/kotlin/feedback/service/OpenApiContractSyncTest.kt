package feedback.service

import com.zaxxer.hikari.HikariDataSource
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.PathSegmentConstantRouteSelector
import io.ktor.server.routing.PathSegmentOptionalParameterRouteSelector
import io.ktor.server.routing.PathSegmentParameterRouteSelector
import io.ktor.server.routing.RootRouteSelector
import io.ktor.server.routing.Route
import io.ktor.server.routing.TrailingSlashRouteSelector
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import org.yaml.snakeyaml.Yaml
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OpenApiContractSyncTest {
    private val contractExemptRoutes = mapOf(
        "GET /health/live" to "コンテナ orchestrator 専用 liveness。公開 Feedback API の versioning 対象外",
        "GET /health/ready" to "コンテナ orchestrator 専用 readiness。公開 Feedback API の versioning 対象外"
    )

    private val permissionExemptRoutes = mapOf(
        "GET /capabilities" to "SDK の互換交渉に使うため OpenAPI で明示的に unauthenticated",
        "GET /me" to "認証主体自身の membership 一覧であり workspace resource permission の判定前"
    )

    @Test
    fun `専用 OpenAPI と routing tree は双方向に一致する`() {
        val implemented = implementedOperations()
        val documented = documentedOperations()
        assertEquals(emptySet(), implemented - documented - contractExemptRoutes.keys, "契約にない route があります")
        assertEquals(emptySet(), documented - implemented, "実装されていない契約 operation があります")
        assertTrue(contractExemptRoutes.values.all { it.isNotBlank() })
    }

    @Test
    fun `全 resource route に permission と scope が一意に宣言される`() {
        val documented = documentedOperations()
        val policyOperations = feedbackRoutePolicies.map { "${it.method} ${it.path}" }
        assertEquals(policyOperations.size, policyOperations.toSet().size, "route policy が重複しています")
        assertEquals(
            documented - permissionExemptRoutes.keys,
            policyOperations.toSet(),
            "全 resource route に feedback permission と resource scope を宣言してください"
        )
        assertTrue(permissionExemptRoutes.values.all { it.isNotBlank() })
    }

    private fun documentedOperations(): Set<String> {
        val path = Path.of("..", "..", "contracts", "feedback", "openapi.yaml")
        @Suppress("UNCHECKED_CAST")
        val root = Files.newBufferedReader(path).use { Yaml().load<Map<String, Any?>>(it) }
        @Suppress("UNCHECKED_CAST")
        val paths = root.getValue("paths") as Map<String, Map<String, Any?>>
        val methods = setOf("get", "post", "put", "patch", "delete")
        return paths.flatMapTo(mutableSetOf()) { (routePath, item) ->
            item.keys.filter { it in methods }.map { method ->
                "${method.uppercase()} ${normalizePath(routePath)}"
            }
        }
    }

    private fun implementedOperations(): Set<String> {
        lateinit var operations: Set<String>
        testApplication {
            application {
                install(Authentication) {
                    bearer(FEEDBACK_AUTH_NAME) {
                        authenticate { UserIdPrincipal("contract-test") }
                    }
                    bearer(FEEDBACK_EXCHANGE_AUTH_NAME) {
                        authenticate { UserIdPrincipal("contract-test-exchange") }
                    }
                }
                val root = routing {
                    val database = FeedbackDatabase(HikariDataSource())
                    healthRoutes(database)
                    feedbackRoutes(
                        FeedbackDependencies(
                            database,
                            LocalEvidenceStorage(Path.of(System.getProperty("java.io.tmpdir"), "feedback-route-test")),
                            1024,
                            "evidence/",
                            120,
                            NotificationCipher(ByteArray(32) { 1 }),
                            LocalEvidenceStorage(Path.of(System.getProperty("java.io.tmpdir"), "feedback-export-route-test"))
                        )
                    )
                }
                operations = collectOperations(root)
            }
        }
        return operations
    }

    private fun collectOperations(root: Route): Set<String> {
        val operations = mutableSetOf<String>()
        fun visit(route: Route) {
            val selector = route.selector
            if (selector is HttpMethodRouteSelector) {
                operations += "${selector.method.value.uppercase()} ${normalizePath(pathOf(route))}"
            }
            route.children.forEach(::visit)
        }
        visit(root)
        return operations
    }

    private fun pathOf(route: Route): String {
        val segments = mutableListOf<String>()
        var current: Route? = route
        while (current != null) {
            when (val selector = current.selector) {
                is PathSegmentConstantRouteSelector -> segments += selector.value
                is PathSegmentParameterRouteSelector -> segments += "{}"
                is PathSegmentOptionalParameterRouteSelector -> segments += "{}"
                is HttpMethodRouteSelector, is RootRouteSelector, is TrailingSlashRouteSelector -> Unit
                else -> Unit // authenticate の selector は path を構成しない
            }
            current = current.parent
        }
        return "/" + segments.asReversed().joinToString("/")
    }

    private fun normalizePath(path: String): String =
        Regex("\\{[^}]+}").replace(path.removePrefix("/feedback/v1"), "{}")
}
