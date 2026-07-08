// 観測性 (issue #18) の統合テスト:
// - /health (liveness) と /health/ready (readiness、DB 疎通込み) が実 DB で 200 を返す
// - callId がレスポンスヘッダに付与され、監査ログ (app.audit_logs.call_id) に記録される
package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.fail

@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ObservabilityIntegrationTest {

    private fun rawConnection(): Connection =
        DriverManager.getConnection(IntegrationDb.url, IntegrationDb.user, IntegrationDb.password)

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    @BeforeAll
    fun setUpSchema() {
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
                stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
            }
            connection.createStatement().use { stmt ->
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
            IntegrationDb.migrate()
        }
    }

    private fun withApp(block: suspend (io.ktor.client.HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    @Test
    fun `liveness と readiness が実 DB で 200 を返す`() = withApp { client ->
        assertEquals(HttpStatusCode.OK, client.get("/health").status)
        assertEquals(HttpStatusCode.OK, client.get("/health/ready").status, "DB 疎通込みの readiness も 200 のはず")
    }

    @Test
    fun `callId がレスポンスヘッダに付与され監査ログの call_id に残る`() = withApp { client ->
        val suppliedCallId = "obs-it-${System.nanoTime()}"
        // 認証なしの保護 API → 401 (deny) が監査ログに記録される経路で callId の統合を検証する
        val response = client.get("/api/projects") {
            header(HttpHeaders.XRequestId, suppliedCallId)
        }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertEquals(suppliedCallId, response.headers[HttpHeaders.XRequestId], "受信した X-Request-Id を反映するはず")

        val recorded = rawConnection().use { connection ->
            connection.prepareStatement(
                "SELECT decision, status_code FROM app.audit_logs WHERE call_id = ?"
            ).use { stmt ->
                stmt.setString(1, suppliedCallId)
                stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) to rs.getInt(2) else null }
            }
        }
        assertNotNull(recorded, "監査ログに call_id が記録されるはず")
        assertEquals("deny" to 401, recorded)
    }
}
