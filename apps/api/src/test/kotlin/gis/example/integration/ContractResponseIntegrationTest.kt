package gis.example.integration

import gis.example.Database
import gis.example.OpenApiSpecSupport
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

// レスポンス形の契約テスト (issue #22)。全エンドポイントは OpenApiContractSyncTest の
// パス/メソッド突合に任せ、ここでは代表 4 種 (一覧・詳細・作成・エラー形) について
// 「実レスポンス JSON が openapi.yaml のレスポンススキーマに適合する」ことを
// PostGIS 実体 + HTTP 層で検証する。スキーマ検証は OpenApiSpecSupport の薄い実装
// (選択理由はそちらのヘッダコメントを参照)
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ContractResponseIntegrationTest {

    private val defaultProject = "00000000-0000-0000-0000-000000000000"
    private val adminBearer = "Bearer ${OidcTestSupport.token("contract-admin")}"

    private fun rawConnection(): Connection {
        val url = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
        val user = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
        val password = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"
        return DriverManager.getConnection(url, user, password)
    }

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
            // init.sql は拡張・スキーマ作成のみ。テーブル定義は Flyway (db/migration) が適用する
            IntegrationDb.migrate()
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.users (id, subject, email, system_role)
                    VALUES ('c0000000-0000-4000-8000-000000000101', 'contract-admin', 'contract-admin@gis.example', 'admin');
                    """.trimIndent()
                )
            }
        }
    }

    private fun withApp(block: suspend (HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    /** レスポンスボディを openapi.yaml の (method, path, status) スキーマと突合する */
    private suspend fun assertConformsTo(response: HttpResponse, method: String, specPath: String, status: Int) {
        assertEquals(status, response.status.value, "$method $specPath のステータス")
        val body = Json.parseToJsonElement(response.bodyAsText())
        val schema = OpenApiSpecSupport.responseSchema(method, specPath, status)
        val violations = OpenApiSpecSupport.validate(body, schema)
        assertTrue(
            violations.isEmpty(),
            "$method $specPath の $status 応答が openapi.yaml のスキーマに適合しません:\n" +
                violations.joinToString("\n")
        )
    }

    @Test
    fun `一覧 - GET layers の応答は Layer 配列スキーマに適合する`() = withApp { client ->
        val response = client.get("/api/layers?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, adminBearer)
        }
        assertConformsTo(response, "get", "/api/layers", HttpStatusCode.OK.value)
        // 空配列で緑にならないように、フィクスチャの 3 レイヤが実際に載っていることも確認する
        assertEquals(3, Json.parseToJsonElement(response.bodyAsText()).jsonArray.size)
    }

    @Test
    fun `詳細 - GET lands id の応答は Land スキーマに適合する`() = withApp { client ->
        val response = client.get("/api/lands/L-IT-1") {
            header(HttpHeaders.Authorization, adminBearer)
        }
        assertConformsTo(response, "get", "/api/lands/{id}", HttpStatusCode.OK.value)
    }

    @Test
    fun `作成 - POST parties の 201 応答は Party スキーマに適合する`() = withApp { client ->
        val response = client.post("/api/parties") {
            header(HttpHeaders.Authorization, adminBearer)
            contentType(ContentType.Application.Json)
            setBody(
                """{"id": "P-CONTRACT-1", "projectId": "$defaultProject", "name": "契約テスト株式会社", "partyType": "法人"}"""
            )
        }
        assertConformsTo(response, "post", "/api/parties", HttpStatusCode.Created.value)
    }

    @Test
    fun `エラー形 - 400 と 401 の応答は Error スキーマに適合する`() = withApp { client ->
        // 400: projectId 欠落 (BadRequest 共通レスポンス)
        val badRequest = client.get("/api/lands") { header(HttpHeaders.Authorization, adminBearer) }
        assertConformsTo(badRequest, "get", "/api/lands", HttpStatusCode.BadRequest.value)

        // 401: トークンなし (Unauthorized 共通レスポンス)
        val unauthorized = client.get("/api/lands")
        assertConformsTo(unauthorized, "get", "/api/lands", HttpStatusCode.Unauthorized.value)
        val body = Json.parseToJsonElement(unauthorized.bodyAsText()).jsonObject
        assertEquals("Authentication required", body.getValue("error").jsonPrimitive.content)
    }
}
