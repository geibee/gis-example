package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
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
import kotlin.test.fail

// 認可 (PEP の配線) を HTTP 層で検証する:
// - ロール別の許可・拒否 (viewer は read のみ、editor は write 可、admin は全部)
// - 非メンバーへの存在秘匿 (個別リソースは 404、projectId 明示は 403)
// - /api/projects のメンバーフィルタ
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuthzIntegrationTest {

    private val defaultProject = "00000000-0000-0000-0000-000000000000"
    private val otherProject = "99999999-9999-9999-9999-999999999999"
    private val parcelsLayerId = "11111111-1111-1111-1111-111111111111"

    private val adminBearer = "Bearer ${OidcTestSupport.token("authz-admin")}"
    private val editorBearer = "Bearer ${OidcTestSupport.token("authz-editor")}"
    private val viewerBearer = "Bearer ${OidcTestSupport.token("authz-viewer")}"
    private val outsiderBearer = "Bearer ${OidcTestSupport.token("authz-outsider")}"

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
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.projects (id, name) VALUES ('$otherProject', 'Other project');

                    INSERT INTO app.users (id, subject, email, system_role)
                    VALUES
                      ('c0000000-0000-4000-8000-000000000001', 'authz-admin', 'authz-admin@gis.example', 'admin'),
                      ('c0000000-0000-4000-8000-000000000002', 'authz-editor', 'authz-editor@gis.example', 'user'),
                      ('c0000000-0000-4000-8000-000000000003', 'authz-viewer', 'authz-viewer@gis.example', 'user'),
                      ('c0000000-0000-4000-8000-000000000004', 'authz-outsider', 'authz-outsider@gis.example', 'user'),
                      ('c0000000-0000-4000-8000-000000000005', 'authz-target', 'authz-target@gis.example', 'user');

                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES
                      ('c0000000-0000-4000-8000-000000000002', '$defaultProject', 'editor'),
                      ('c0000000-0000-4000-8000-000000000003', '$defaultProject', 'viewer');
                    """.trimIndent()
                )
            }
        }
    }

    private fun withApp(block: suspend (HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    @Test
    fun `一覧はメンバーのみ許可され非メンバーは 403、projectId なしは 400`() = withApp { client ->
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/lands?projectId=$defaultProject") { header(HttpHeaders.Authorization, viewerBearer) }.status
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/lands?projectId=$defaultProject") { header(HttpHeaders.Authorization, outsiderBearer) }.status
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            client.get("/api/lands") { header(HttpHeaders.Authorization, editorBearer) }.status,
            "projectId は必須"
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/layers?projectId=$defaultProject") { header(HttpHeaders.Authorization, outsiderBearer) }.status
        )
    }

    @Test
    fun `作成は editor に許可され viewer は 403 になる`() = withApp { client ->
        val body =
            """{"id": "L-AUTHZ-1", "projectId": "$defaultProject", "lotNumber": "authz-1", "address": "authz テスト"}"""
        assertEquals(
            HttpStatusCode.Forbidden,
            client.post("/api/lands") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody(body)
            }.status
        )
        assertEquals(
            HttpStatusCode.Created,
            client.post("/api/lands") {
                header(HttpHeaders.Authorization, editorBearer)
                contentType(ContentType.Application.Json)
                setBody(body)
            }.status
        )
    }

    @Test
    fun `個別リソースは非メンバーに 404 でメンバーのロール不足には 403 になる`() = withApp { client ->
        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/lands/L-IT-1") { header(HttpHeaders.Authorization, outsiderBearer) }.status,
            "非メンバーには存在自体を隠す"
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/lands/L-IT-1") { header(HttpHeaders.Authorization, viewerBearer) }.status
        )
        val patchBody = """{"memo": "authz 更新"}"""
        assertEquals(
            HttpStatusCode.Forbidden,
            client.patch("/api/lands/L-IT-1") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody(patchBody)
            }.status,
            "viewer は読めるが書けない"
        )
        assertEquals(
            HttpStatusCode.OK,
            client.patch("/api/lands/L-IT-1") {
                header(HttpHeaders.Authorization, editorBearer)
                contentType(ContentType.Application.Json)
                setBody(patchBody)
            }.status
        )
        assertEquals(
            HttpStatusCode.NotFound,
            client.delete("/api/lands/L-MISSING") { header(HttpHeaders.Authorization, editorBearer) }.status,
            "存在しない ID は従来どおり 404"
        )
    }

    @Test
    fun `projects 一覧はメンバーシップでフィルタされ admin は全件見える`() = withApp { client ->
        fun projectIds(bodyText: String): Set<String> =
            Json.parseToJsonElement(bodyText).jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }.toSet()

        val outsider = client.get("/api/projects") { header(HttpHeaders.Authorization, outsiderBearer) }
        assertEquals(HttpStatusCode.OK, outsider.status)
        assertEquals(emptySet(), projectIds(outsider.bodyAsText()), "非メンバーには何も列挙しない")

        val viewer = client.get("/api/projects") { header(HttpHeaders.Authorization, viewerBearer) }
        assertEquals(setOf(defaultProject), projectIds(viewer.bodyAsText()))

        val admin = client.get("/api/projects") { header(HttpHeaders.Authorization, adminBearer) }
        assertEquals(setOf(defaultProject, otherProject), projectIds(admin.bodyAsText()))
    }

    @Test
    fun `タイルは viewer が読め非メンバーには存在を隠す`() = withApp { client ->
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/tilejson/$parcelsLayerId") { header(HttpHeaders.Authorization, viewerBearer) }.status
        )
        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/tilejson/$parcelsLayerId") { header(HttpHeaders.Authorization, outsiderBearer) }.status
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/tiles/$parcelsLayerId/15/29104/12902") { header(HttpHeaders.Authorization, viewerBearer) }.status
        )
    }

    @Test
    fun `me は自分のロールとメンバーシップを返す`() = withApp { client ->
        val response = client.get("/api/me") { header(HttpHeaders.Authorization, viewerBearer) }
        assertEquals(HttpStatusCode.OK, response.status)
        val me = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("user", me.getValue("systemRole").jsonPrimitive.content)
        val memberships = me.getValue("memberships").jsonArray.map { it.jsonObject }
        assertEquals(1, memberships.size)
        assertEquals(defaultProject, memberships[0].getValue("projectId").jsonPrimitive.content)
        assertEquals("viewer", memberships[0].getValue("role").jsonPrimitive.content)
    }

    @Test
    fun `管理 API は admin 専用で自分自身の変更は拒否される`() = withApp { client ->
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/users") { header(HttpHeaders.Authorization, editorBearer) }.status,
            "editor でもシステム操作は 403"
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/users") { header(HttpHeaders.Authorization, adminBearer) }.status
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            client.patch("/api/users/c0000000-0000-4000-8000-000000000001") {
                header(HttpHeaders.Authorization, adminBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"isActive": false}""")
            }.status,
            "自分自身の無効化はロックアウト防止のため拒否"
        )
    }

    @Test
    fun `メンバーの付与と剥奪は次のリクエストから即時反映される`() = withApp { client ->
        val targetBearer = "Bearer ${OidcTestSupport.token("authz-target")}"
        val targetUserId = "c0000000-0000-4000-8000-000000000005"

        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/lands?projectId=$otherProject") { header(HttpHeaders.Authorization, targetBearer) }.status,
            "付与前は非メンバー"
        )
        assertEquals(
            HttpStatusCode.OK,
            client.put("/api/projects/$otherProject/members/$targetUserId") {
                header(HttpHeaders.Authorization, adminBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"role": "viewer"}""")
            }.status
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/lands?projectId=$otherProject") { header(HttpHeaders.Authorization, targetBearer) }.status,
            "付与後は viewer として閲覧できる"
        )
        assertEquals(
            HttpStatusCode.NoContent,
            client.delete("/api/projects/$otherProject/members/$targetUserId") {
                header(HttpHeaders.Authorization, adminBearer)
            }.status
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/lands?projectId=$otherProject") { header(HttpHeaders.Authorization, targetBearer) }.status,
            "剥奪後は再び拒否される"
        )
    }

    @Test
    fun `監査ログは mutate 成功と認可拒否を記録し read 成功は記録しない`() {
        // 検証専用のパスで他テストの記録と分離する
        val auditLand = "L-IT-1"
        withApp { client ->
            val patchBody = """{"memo": "audit 検証"}"""
            client.patch("/api/lands/$auditLand") {
                header(HttpHeaders.Authorization, editorBearer)
                contentType(ContentType.Application.Json)
                setBody(patchBody)
            }
            client.patch("/api/lands/$auditLand") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody(patchBody)
            }
            client.get("/api/lands/$auditLand") // トークンなし = 401
            client.get("/api/lands/$auditLand") { header(HttpHeaders.Authorization, viewerBearer) } // read 成功
        }
        // withApp を抜けた時点でサーバは停止済み = ResponseSent フックも完了している
        fun auditCount(where: String): Int = rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.executeQuery("SELECT count(*) FROM app.audit_logs WHERE $where").use { rs ->
                    rs.next()
                    rs.getInt(1)
                }
            }
        }
        val path = "/api/lands/$auditLand"
        check(
            auditCount(
                "subject = 'authz-editor' AND decision = 'allow' AND http_method = 'PATCH' " +
                    "AND path = '$path' AND action = 'BUSINESS_WRITE' AND project_id = '$defaultProject'"
            ) >= 1
        ) { "editor の PATCH 成功が記録されていません" }
        check(
            auditCount(
                "subject = 'authz-viewer' AND decision = 'deny' AND status_code = 403 " +
                    "AND http_method = 'PATCH' AND path = '$path'"
            ) >= 1
        ) { "viewer の 403 拒否が記録されていません" }
        check(
            auditCount("subject IS NULL AND decision = 'deny' AND status_code = 401 AND path = '$path'") >= 1
        ) { "トークンなしの 401 が記録されていません" }
        assertEquals(
            0,
            auditCount("decision = 'allow' AND http_method = 'GET'"),
            "read 成功は記録しない"
        )
    }

    @Test
    fun `admin はメンバーでないプロジェクトも操作できる`() = withApp { client ->
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/lands?projectId=$otherProject") { header(HttpHeaders.Authorization, adminBearer) }.status
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/lands/L-IT-1") { header(HttpHeaders.Authorization, adminBearer) }.status
        )
    }
}
