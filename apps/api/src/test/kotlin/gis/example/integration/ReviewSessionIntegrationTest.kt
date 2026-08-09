package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

// レビューセッション API (docs/prototype-review.md Phase 1) を HTTP 層で検証する:
// - ガイドの読み取りは viewer にも許可、開設・観点変更は editor のみ (REVIEW_READ / REVIEW_MANAGE)
// - FUTURE / OUT_OF_SCOPE の観点も「行として」返る (UI がグレーアウト表示できる)
// - perspectives / scopes はキー指定時のみ全置換される
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ReviewSessionIntegrationTest {

    private val defaultProject = "00000000-0000-0000-0000-000000000000"

    private val editorBearer = "Bearer ${OidcTestSupport.token("review-editor")}"
    private val viewerBearer = "Bearer ${OidcTestSupport.token("review-viewer")}"
    private val outsiderBearer = "Bearer ${OidcTestSupport.token("review-outsider")}"

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
                    VALUES
                      ('d0000000-0000-4000-8000-000000000001', 'review-editor', 'review-editor@gis.example', 'user'),
                      ('d0000000-0000-4000-8000-000000000002', 'review-viewer', 'review-viewer@gis.example', 'user'),
                      ('d0000000-0000-4000-8000-000000000003', 'review-outsider', 'review-outsider@gis.example', 'user');

                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES
                      ('d0000000-0000-4000-8000-000000000001', '$defaultProject', 'editor'),
                      ('d0000000-0000-4000-8000-000000000002', '$defaultProject', 'viewer');
                    """.trimIndent()
                )
            }
        }
    }

    private fun withApp(block: suspend (HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    private fun body(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun JsonObject.perspective(code: String): JsonObject =
        getValue("perspectives").jsonArray.map { it.jsonObject }
            .single { it.getValue("code").jsonPrimitive.content == code }

    private val createBody = """
        {
          "projectId": "$defaultProject",
          "title": "第1回 業務フローレビュー",
          "description": "案件検索から詳細確認までの流れを確認してください",
          "status": "open",
          "startAt": "2026-08-10T09:00:00+09:00",
          "endAt": "2026-08-20T18:00:00+09:00",
          "perspectives": [
            {"code": "BUSINESS_FLOW", "status": "ACTIVE"},
            {"code": "MAP_OPERATION", "status": "ACTIVE"},
            {"code": "UI_DESIGN", "status": "FUTURE", "guidance": "次回のデザインレビューで確認します"},
            {"code": "PERFORMANCE", "status": "OUT_OF_SCOPE", "guidance": "性能検証フェーズで確認します"}
          ],
          "scopes": [
            {"pageId": "lands.list", "route": "/lands", "description": "案件一覧"},
            {"pageId": "lands.detail", "route": "/lands/land-1", "description": "案件詳細"},
            {"pageId": "lands.detail", "route": "/lands/land-2", "description": "別案件詳細"},
            {"pageId": "admin.users", "route": "/admin", "description": "管理画面", "reviewable": false}
          ]
        }
    """.trimIndent()

    private suspend fun createSession(client: HttpClient): JsonObject {
        val response = client.post("/api/review-sessions") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody(createBody)
        }
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        return body(response.bodyAsText())
    }

    @Test
    fun `レビュー観点マスタはDBの表示順で返り viewer も読める`() = withApp { client ->
        val response = client.get("/api/review-perspectives?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        val perspectives = Json.parseToJsonElement(response.bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals("BUSINESS_FLOW", perspectives.first().getValue("code").jsonPrimitive.content)
        assertEquals("業務フロー", perspectives.first().getValue("label").jsonPrimitive.content)
        assertTrue(
            perspectives.zipWithNext().all { (left, right) ->
                left.getValue("displayOrder").jsonPrimitive.content.toInt() <=
                    right.getValue("displayOrder").jsonPrimitive.content.toInt()
            }
        )

        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/review-perspectives?projectId=$defaultProject") {
                header(HttpHeaders.Authorization, outsiderBearer)
            }.status
        )
    }

    @Test
    fun `作成したセッションは観点と対象画面を含めて返り viewer も読める`() = withApp { client ->
        val created = createSession(client)
        val id = created.getValue("id").jsonPrimitive.content

        assertEquals("open", created.getValue("status").jsonPrimitive.content)
        assertEquals("ACTIVE", created.perspective("BUSINESS_FLOW").getValue("status").jsonPrimitive.content)
        assertEquals(
            "次回のデザインレビューで確認します",
            created.perspective("UI_DESIGN").getValue("guidance").jsonPrimitive.content,
            "FUTURE の観点も理由付きで返し、UI がグレーアウト表示できるようにする"
        )
        assertEquals(
            "デザイン・配色",
            created.perspective("UI_DESIGN").getValue("label").jsonPrimitive.content,
            "表示ラベルはマスタ (app.review_perspectives) から解決する"
        )
        assertEquals(
            listOf("lands.list", "lands.detail", "lands.detail", "admin.users"),
            created.getValue("scopes").jsonArray.map { it.jsonObject.getValue("pageId").jsonPrimitive.content },
            "対象画面はリクエストの並び順を保持する"
        )
        assertEquals(
            listOf("/lands", "/lands/land-1", "/lands/land-2", "/admin"),
            created.getValue("scopes").jsonArray.map { it.jsonObject.getValue("route").jsonPrimitive.content }
        )
        assertEquals(
            false,
            created.getValue("scopes").jsonArray.map { it.jsonObject }
                .single { it.getValue("pageId").jsonPrimitive.content == "admin.users" }
                .getValue("reviewable").jsonPrimitive.content.toBoolean()
        )

        val fetched = client.get("/api/review-sessions/$id") { header(HttpHeaders.Authorization, viewerBearer) }
        assertEquals(HttpStatusCode.OK, fetched.status, "レビュー対象者 (viewer) はガイドを読める")
        assertEquals(4, body(fetched.bodyAsText()).getValue("perspectives").jsonArray.size)

        val listed = client.get("/api/review-sessions?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(HttpStatusCode.OK, listed.status)
        val sessions = Json.parseToJsonElement(listed.bodyAsText()).jsonArray.map { it.jsonObject }
        assertTrue(sessions.any { it.getValue("id").jsonPrimitive.content == id })
        assertTrue(
            sessions.all { it.getValue("perspectives").jsonArray.isNotEmpty() },
            "一覧でも観点を返す (N+1 を避けて一括取得する)"
        )
    }

    @Test
    fun `開設と観点変更は editor のみで viewer は 403 になる`() = withApp { client ->
        assertEquals(
            HttpStatusCode.Forbidden,
            client.post("/api/review-sessions") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody(createBody)
            }.status,
            "レビュー対象者はセッションを開設できない"
        )

        val id = createSession(client).getValue("id").jsonPrimitive.content
        assertEquals(
            HttpStatusCode.Forbidden,
            client.patch("/api/review-sessions/$id") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"status": "closed"}""")
            }.status
        )
        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/review-sessions/$id") { header(HttpHeaders.Authorization, outsiderBearer) }.status,
            "非メンバーには存在自体を隠す"
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/review-sessions?projectId=$defaultProject") {
                header(HttpHeaders.Authorization, outsiderBearer)
            }.status
        )
    }

    @Test
    fun `観点はキー指定時のみ全置換され、指定しなければ保持される`() = withApp { client ->
        val id = createSession(client).getValue("id").jsonPrimitive.content

        val titleOnly = client.patch("/api/review-sessions/$id") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"title": "第1回 業務フローレビュー (改)"}""")
        }
        assertEquals(HttpStatusCode.OK, titleOnly.status, titleOnly.bodyAsText())
        assertEquals(
            4,
            body(titleOnly.bodyAsText()).getValue("perspectives").jsonArray.size,
            "perspectives を指定しない更新では観点を保持する"
        )

        val replaced = client.patch("/api/review-sessions/$id") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"perspectives": [{"code": "USABILITY", "status": "ACTIVE"}], "scopes": []}""")
        }
        assertEquals(HttpStatusCode.OK, replaced.status, replaced.bodyAsText())
        val after = body(replaced.bodyAsText())
        assertEquals(
            listOf("USABILITY"),
            after.getValue("perspectives").jsonArray.map { it.jsonObject.getValue("code").jsonPrimitive.content }
        )
        assertEquals(0, after.getValue("scopes").jsonArray.size, "空配列の指定は全削除を意味する")
    }

    @Test
    fun `不正な入力は 400 で拒否される`() = withApp { client ->
        fun post(body: String) = """{"projectId": "$defaultProject", "title": "検証", $body}"""

        suspend fun status(body: String) = client.post("/api/review-sessions") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody(body)
        }.status

        assertEquals(
            HttpStatusCode.BadRequest,
            status(post(""""perspectives": [{"code": "NOT_A_PERSPECTIVE", "status": "ACTIVE"}]""")),
            "マスタに無い観点は受け付けない"
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            status(post(""""perspectives": [{"code": "BUSINESS_FLOW", "status": "active"}]""")),
            "観点の status は大文字の allowlist のみ"
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            status(post(""""startAt": "2026-08-20T09:00:00+09:00", "endAt": "2026-08-10T09:00:00+09:00"""")),
            "終了が開始より前の期間は受け付けない"
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            status(post(""""scopes": [{"pageId": "/lands"}, {"pageId": "/lands"}]""")),
            "同じ画面の重複指定は受け付けない"
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            client.get("/api/review-sessions/not-a-uuid") { header(HttpHeaders.Authorization, editorBearer) }.status
        )
    }

    @Test
    fun `作成と更新は監査ログに変更内容として記録される`() {
        var sessionId = ""
        withApp { client ->
            sessionId = createSession(client).getValue("id").jsonPrimitive.content
            client.patch("/api/review-sessions/$sessionId") {
                header(HttpHeaders.Authorization, editorBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"status": "closed"}""")
            }
        }
        val detail = rawConnection().use { connection ->
            connection.prepareStatement(
                """
                SELECT detail::text
                FROM app.audit_logs
                WHERE http_method = 'PATCH' AND path = '/api/review-sessions/$sessionId' AND decision = 'allow'
                ORDER BY occurred_at DESC
                LIMIT 1
                """.trimIndent()
            ).use { stmt ->
                stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
            }
        }
        assertTrue(detail != null && "review_session" in detail, "更新の監査 diff が記録されていません: $detail")
        assertTrue("closed" in detail, "変更後の状態が diff に含まれていません: $detail")
        assertNull(
            rawConnection().use { connection ->
                connection.prepareStatement(
                    "SELECT 1 FROM app.audit_logs WHERE http_method = 'GET' AND decision = 'allow' LIMIT 1"
                ).use { stmt -> stmt.executeQuery().use { rs -> if (rs.next()) 1 else null } }
            },
            "read 成功は監査ログに記録しない"
        )
    }
}
