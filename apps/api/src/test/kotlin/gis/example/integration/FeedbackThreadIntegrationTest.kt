package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.readBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
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
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

// コメント投稿と証跡 (docs/prototype-review.md Phase 2) を HTTP 層で検証する:
// - レビュー対象者 (viewer) が投稿でき、コンテキスト (対象・観点・証跡) が保存される
// - 「今回選べない観点」「受付中でないセッション」への投稿はサーバ側でも拒否される
// - 証跡画像は公開されず、認可を通した経路でのみ取得できる
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class FeedbackThreadIntegrationTest {

    private val defaultProject = "00000000-0000-0000-0000-000000000000"

    private val editorBearer = "Bearer ${OidcTestSupport.token("feedback-editor")}"
    private val viewerBearer = "Bearer ${OidcTestSupport.token("feedback-viewer")}"
    private val outsiderBearer = "Bearer ${OidcTestSupport.token("feedback-outsider")}"

    // 1x1 の最小 PNG (証跡そのものの中身は本テストの関心ではない)
    private val pngBytes: ByteArray = java.util.Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )

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
                    INSERT INTO app.users (id, subject, email, display_name, system_role)
                    VALUES
                      ('e0000000-0000-4000-8000-000000000001', 'feedback-editor', 'fe@gis.example', '開発担当', 'user'),
                      ('e0000000-0000-4000-8000-000000000002', 'feedback-viewer', 'fv@gis.example', '顧客レビュアー', 'user'),
                      ('e0000000-0000-4000-8000-000000000003', 'feedback-outsider', 'fo@gis.example', '部外者', 'user');

                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES
                      ('e0000000-0000-4000-8000-000000000001', '$defaultProject', 'editor'),
                      ('e0000000-0000-4000-8000-000000000002', '$defaultProject', 'viewer');
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

    private suspend fun createSession(client: HttpClient, status: String = "open"): String {
        val response = client.post("/api/review-sessions") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "projectId": "$defaultProject",
                  "title": "コメント投稿の検証",
                  "status": "$status",
                  "perspectives": [
                    {"code": "BUSINESS_FLOW", "status": "ACTIVE"},
                    {"code": "UI_DESIGN", "status": "FUTURE"}
                  ],
                  "scopes": [{"pageId": "/lands", "description": "案件一覧"}]
                }
                """.trimIndent()
            )
        }
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        return body(response.bodyAsText()).getValue("id").jsonPrimitive.content
    }

    private suspend fun postThread(
        client: HttpClient,
        sessionId: String,
        bearer: String,
        metadata: String,
        screenshot: ByteArray? = null
    ): HttpResponse = client.post("/api/review-sessions/$sessionId/threads") {
        header(HttpHeaders.Authorization, bearer)
        setBody(
            MultiPartFormDataContent(
                formData {
                    append("metadata", metadata)
                    if (screenshot != null) {
                        append(
                            "screenshot",
                            screenshot,
                            Headers.build {
                                append(HttpHeaders.ContentType, "image/png")
                                append(HttpHeaders.ContentDisposition, "filename=\"evidence.png\"")
                            }
                        )
                    }
                }
            )
        )
    }

    private val uiTargetMetadata = """
        {
          "perspectiveCode": "BUSINESS_FLOW",
          "body": "この項目は必要ですか？",
          "targetType": "UI_ELEMENT",
          "target": {
            "type": "UI_ELEMENT",
            "feedbackTargetId": "contract-expiration-date",
            "relativeX": 0.63,
            "relativeY": 0.41
          },
          "pageId": "/lands",
          "route": "/lands?projectId=$defaultProject",
          "viewportWidth": 1440,
          "viewportHeight": 900,
          "scrollX": 0,
          "scrollY": 300,
          "pixelRatio": 2,
          "frontendVersion": "git-abcdef",
          "capturedAt": "2026-08-12T10:15:00+09:00"
        }
    """.trimIndent()

    @Test
    fun `レビュー対象者がコンテキストと証跡つきでコメントを投稿できる`() = withApp { client ->
        val sessionId = createSession(client)
        val response = postThread(client, sessionId, viewerBearer, uiTargetMetadata, pngBytes)
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())

        val thread = body(response.bodyAsText())
        assertEquals("BUSINESS_FLOW", thread.getValue("perspectiveCode").jsonPrimitive.content)
        assertEquals("業務フロー", thread.getValue("perspectiveLabel").jsonPrimitive.content)
        assertEquals("UI_ELEMENT", thread.getValue("targetType").jsonPrimitive.content)
        assertEquals("OPEN", thread.getValue("status").jsonPrimitive.content)
        assertEquals("顧客レビュアー", thread.getValue("createdByName").jsonPrimitive.content)
        assertEquals(
            "contract-expiration-date",
            thread.getValue("targetMetadata").jsonObject.getValue("feedbackTargetId").jsonPrimitive.content,
            "コメント対象の安定 ID がそのまま保存される"
        )
        assertNotNull(
            thread["reviewScopeId"]?.jsonPrimitive?.contentOrNull(),
            "投稿時の画面 (pageId) が ReviewScope に引き当てられる"
        )

        val messages = thread.getValue("messages").jsonArray.map { it.jsonObject }
        assertEquals(1, messages.size)
        assertEquals("この項目は必要ですか？", messages[0].getValue("body").jsonPrimitive.content)

        val evidence = thread.getValue("evidence").jsonObject
        assertEquals(1440, evidence.getValue("viewportWidth").jsonPrimitive.content.toInt())
        assertEquals(300, evidence.getValue("scrollY").jsonPrimitive.content.toInt())
        assertEquals("git-abcdef", evidence.getValue("frontendVersion").jsonPrimitive.content)
        assertEquals(pngBytes.size.toLong(), evidence.getValue("byteSize").jsonPrimitive.content.toLong())
        assertNull(evidence["screenshotPath"], "保存先のパスは公開しない")
    }

    @Test
    fun `証跡画像は認可を通した経路でのみ取得できる`() = withApp { client ->
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata, pngBytes).bodyAsText())
            .getValue("id").jsonPrimitive.content

        val evidence = client.get("/api/threads/$threadId/evidence") {
            header(HttpHeaders.Authorization, editorBearer)
        }
        assertEquals(HttpStatusCode.OK, evidence.status)
        assertEquals(ContentType.Image.PNG, evidence.contentType()?.withoutParameters())
        assertTrue(pngBytes.contentEquals(evidence.readBytes()), "保存した PNG がそのまま返る")
        assertEquals(
            "private, no-store",
            evidence.headers[HttpHeaders.CacheControl],
            "証跡には個人情報が写り得るため共有キャッシュに残さない"
        )

        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/threads/$threadId/evidence") {
                header(HttpHeaders.Authorization, outsiderBearer)
            }.status,
            "非メンバーには存在自体を隠す"
        )
    }

    @Test
    fun `今回選べない観点への投稿はサーバ側でも拒否される`() = withApp { client ->
        val sessionId = createSession(client)
        val futureMetadata = uiTargetMetadata.replace("\"BUSINESS_FLOW\"", "\"UI_DESIGN\"")

        val response = postThread(client, sessionId, viewerBearer, futureMetadata, pngBytes)
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue("UI_DESIGN" in response.bodyAsText(), response.bodyAsText())

        val unlisted = uiTargetMetadata.replace("\"BUSINESS_FLOW\"", "\"ERROR_HANDLING\"")
        assertEquals(
            HttpStatusCode.BadRequest,
            postThread(client, sessionId, viewerBearer, unlisted, pngBytes).status,
            "セッションの観点に含まれない code も拒否する"
        )
    }

    @Test
    fun `受付中でないセッションへは投稿できない`() = withApp { client ->
        val draftSession = createSession(client, status = "draft")

        val response = postThread(client, draftSession, viewerBearer, uiTargetMetadata, pngBytes)
        assertEquals(HttpStatusCode.Conflict, response.status, response.bodyAsText())
        assertEquals(
            0,
            threadCount(draftSession),
            "拒否された投稿でスレッドが作られていない"
        )
    }

    @Test
    fun `証跡なしでも指摘は残せる`() = withApp { client ->
        val sessionId = createSession(client)
        val metadata = """
            {
              "perspectiveCode": "BUSINESS_FLOW",
              "body": "検索後の流れが分かりにくい",
              "targetType": "SCREEN_POSITION",
              "target": {"type": "SCREEN_POSITION", "relativeX": 0.5, "relativeY": 0.5}
            }
        """.trimIndent()

        val response = postThread(client, sessionId, viewerBearer, metadata)
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        assertNull(body(response.bodyAsText())["evidence"]?.jsonPrimitive?.contentOrNull())
    }

    @Test
    fun `不正な投稿は 400 で拒否される`() = withApp { client ->
        val sessionId = createSession(client)

        assertEquals(
            HttpStatusCode.BadRequest,
            postThread(client, sessionId, viewerBearer, """{"perspectiveCode": "BUSINESS_FLOW"}""").status,
            "body / targetType / target は必須"
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            postThread(
                client,
                sessionId,
                viewerBearer,
                """{"perspectiveCode":"BUSINESS_FLOW","body":"x","targetType":"NOT_A_TYPE","target":{}}"""
            ).status
        )
        assertEquals(
            HttpStatusCode.BadRequest,
            postThread(
                client,
                sessionId,
                viewerBearer,
                // スクリーンショットを添付する場合はビューポートサイズが必須
                """{"perspectiveCode":"BUSINESS_FLOW","body":"x","targetType":"SCREEN_POSITION",""" +
                    """"target":{},"route":"/lands"}""",
                pngBytes
            ).status
        )
    }

    @Test
    fun `投稿元の画面を記録し、画面ごとに絞り込める (コメントピン用)`() = withApp { client ->
        val sessionId = createSession(client)
        postThread(client, sessionId, viewerBearer, uiTargetMetadata, pngBytes)
        // 対象外の画面 (ReviewScope に無い) からの投稿も pageId は記録する
        val outOfScope = uiTargetMetadata.replace("\"pageId\": \"/lands\"", "\"pageId\": \"/parties\"")
        postThread(client, sessionId, viewerBearer, outOfScope, pngBytes)

        fun pageIds(bodyText: String) =
            Json.parseToJsonElement(bodyText).jsonArray.map { it.jsonObject["pageId"]?.jsonPrimitive?.content }

        val all = client.get("/api/review-sessions/$sessionId/threads") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(listOf("/parties", "/lands"), pageIds(all.bodyAsText()), "新しい順で両方返る")

        val filtered = client.get("/api/review-sessions/$sessionId/threads?pageId=/lands") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(HttpStatusCode.OK, filtered.status)
        assertEquals(listOf("/lands"), pageIds(filtered.bodyAsText()))

        val outOfScopeThread = Json.parseToJsonElement(
            client.get("/api/review-sessions/$sessionId/threads?pageId=/parties") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.bodyAsText()
        ).jsonArray.single().jsonObject
        assertNull(
            outOfScopeThread["reviewScopeId"]?.jsonPrimitive?.contentOrNull(),
            "レビュー対象外の画面では ReviewScope に紐づかないが pageId は残る"
        )
    }

    @Test
    fun `スレッド一覧と詳細はメンバーのみ読める`() = withApp { client ->
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata, pngBytes).bodyAsText())
            .getValue("id").jsonPrimitive.content

        val listed = client.get("/api/review-sessions/$sessionId/threads") {
            header(HttpHeaders.Authorization, editorBearer)
        }
        assertEquals(HttpStatusCode.OK, listed.status)
        val threads = Json.parseToJsonElement(listed.bodyAsText()).jsonArray.map { it.jsonObject }
        assertTrue(threads.any { it.getValue("id").jsonPrimitive.content == threadId })
        assertEquals(
            "この項目は必要ですか？",
            threads.first { it.getValue("id").jsonPrimitive.content == threadId }
                .getValue("messages").jsonArray.first().jsonObject.getValue("body").jsonPrimitive.content,
            "一覧でも本文をまとめて返す (N+1 を避ける)"
        )

        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/threads/$threadId") { header(HttpHeaders.Authorization, outsiderBearer) }.status
        )
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/threads/$threadId") { header(HttpHeaders.Authorization, viewerBearer) }.status
        )
    }

    private fun threadCount(sessionId: String): Int = rawConnection().use { connection ->
        connection.prepareStatement(
            "SELECT count(*) FROM app.feedback_threads WHERE review_session_id = ?::uuid"
        ).use { stmt ->
            stmt.setString(1, sessionId)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content
