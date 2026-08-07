package gis.example.integration

import gis.example.Database
import gis.example.ClaimedReviewNotification
import gis.example.ReviewNotificationCapabilities
import gis.example.ReviewNotificationSender
import gis.example.ReviewNotificationWorker
import gis.example.ReviewNotificationWorkerSettings
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
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

// コメント投稿・返信・状態管理と証跡 (docs/prototype-review.md Phase 2〜4) を HTTP 層で検証する:
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

    private suspend fun createSession(
        client: HttpClient,
        status: String = "open",
        projectId: String = defaultProject
    ): String {
        val response = client.post("/api/review-sessions") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "projectId": "$projectId",
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

    private suspend fun postMessage(
        client: HttpClient,
        threadId: String,
        bearer: String,
        text: String
    ): HttpResponse = client.post("/api/threads/$threadId/messages") {
        header(HttpHeaders.Authorization, bearer)
        contentType(ContentType.Application.Json)
        setBody("""{"body":"$text"}""")
    }

    private suspend fun patchStatus(
        client: HttpClient,
        threadId: String,
        bearer: String,
        status: String
    ): HttpResponse = client.patch("/api/threads/$threadId/status") {
        header(HttpHeaders.Authorization, bearer)
        contentType(ContentType.Application.Json)
        setBody("""{"status":"$status"}""")
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

        val evidenceCallId = "feedback-evidence-${System.nanoTime()}"
        val evidence = client.get("/api/threads/$threadId/evidence") {
            header(HttpHeaders.Authorization, editorBearer)
            header(HttpHeaders.XRequestId, evidenceCallId)
        }
        assertEquals(HttpStatusCode.OK, evidence.status)
        assertEquals(ContentType.Image.PNG, evidence.contentType()?.withoutParameters())
        assertTrue(pngBytes.contentEquals(evidence.readBytes()), "保存した PNG がそのまま返る")
        assertEquals(
            "private, no-store",
            evidence.headers[HttpHeaders.CacheControl],
            "証跡には個人情報が写り得るため共有キャッシュに残さない"
        )
        rawConnection().use { connection ->
            connection.prepareStatement(
                "SELECT action, decision FROM app.audit_logs WHERE call_id = ?"
            ).use { stmt ->
                stmt.setString(1, evidenceCallId)
                stmt.executeQuery().use { rs ->
                    assertTrue(rs.next(), "機微な証跡閲覧成功は監査ログへ残るはず")
                    assertEquals("REVIEW_READ", rs.getString(1))
                    assertEquals("allow", rs.getString(2))
                }
            }
        }

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

    @Test
    fun `レビュー対象者が OPEN のスレッドへ返信できる`() = withApp { client ->
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata).bodyAsText())
            .getValue("id").jsonPrimitive.content

        val reply = postMessage(client, threadId, viewerBearer, "確認結果を追記します")
        assertEquals(HttpStatusCode.Created, reply.status, reply.bodyAsText())
        val message = body(reply.bodyAsText())
        assertEquals(threadId, message.getValue("threadId").jsonPrimitive.content)
        assertEquals("顧客レビュアー", message.getValue("authorName").jsonPrimitive.content)
        assertEquals("確認結果を追記します", message.getValue("body").jsonPrimitive.content)

        val detail = client.get("/api/threads/$threadId") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        val messages = body(detail.bodyAsText()).getValue("messages").jsonArray.map { it.jsonObject }
        assertEquals(2, messages.size)
        assertEquals("確認結果を追記します", messages.last().getValue("body").jsonPrimitive.content)
    }

    @Test
    fun `レビュー更新と通知outboxが同時に確定しIssueはスレッド作成時だけ生成される`() = withApp { client ->
        rawConnection().use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO app.review_notification_settings (
                    project_id, email_enabled, teams_enabled, issue_enabled
                ) VALUES (?::uuid, true, true, true)
                ON CONFLICT (project_id) DO UPDATE SET
                    email_enabled = true, teams_enabled = true, issue_enabled = true, updated_at = now()
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, defaultProject)
                stmt.executeUpdate()
            }
        }
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata).bodyAsText())
            .getValue("id").jsonPrimitive.content
        assertEquals(HttpStatusCode.Created, postMessage(client, threadId, viewerBearer, "通知対象の返信").status)
        assertEquals(HttpStatusCode.OK, patchStatus(client, threadId, editorBearer, "RESOLVED").status)

        rawConnection().use { connection ->
            connection.prepareStatement(
                """
                SELECT o.event_type, d.channel, d.destination, o.payload::text
                FROM app.review_notification_outbox AS o
                JOIN app.review_notification_deliveries AS d ON d.outbox_id = o.id
                WHERE o.thread_id = ?::uuid
                ORDER BY o.created_at, d.channel, d.destination
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, threadId)
                stmt.executeQuery().use { rs ->
                    val deliveries = buildList {
                        while (rs.next()) {
                            add(listOf(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)))
                        }
                    }
                    assertEquals(7, deliveries.size)
                    assertEquals(1, deliveries.count { it[1] == "ISSUE" }, "Issue はスレッドにつき1件")
                    assertEquals(3, deliveries.count { it[1] == "TEAMS" })
                    assertEquals(3, deliveries.count { it[1] == "EMAIL" })
                    assertEquals(
                        2,
                        deliveries.count { it[2] == "fe@gis.example" },
                        "投稿者本人を除き、作成と返信は editor へ送る"
                    )
                    assertEquals(
                        1,
                        deliveries.count { it[2] == "fv@gis.example" },
                        "editor による解決は viewer へ送る"
                    )
                    assertTrue(deliveries.all { "screenshot" !in it[3] }, "外部通知へ証跡情報を含めない")
                }
            }
            connection.prepareStatement(
                """
                UPDATE app.review_notification_settings
                SET email_enabled = false, teams_enabled = false, issue_enabled = false, updated_at = now()
                WHERE project_id = ?::uuid
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, defaultProject)
                stmt.executeUpdate()
            }
        }
        val sent = mutableListOf<ClaimedReviewNotification>()
        val sender = object : ReviewNotificationSender {
            override val capabilities = ReviewNotificationCapabilities(email = true, teams = true, issue = true)
            override fun send(notification: ClaimedReviewNotification): String {
                sent += notification
                return "external-test-id"
            }
        }
        Database.fromEnv().use { notificationDb ->
            val worker = ReviewNotificationWorker(
                notificationDb,
                sender,
                ReviewNotificationWorkerSettings(pollIntervalMillis = 1, maxAttempts = 5, leaseSeconds = 120)
            )
            assertTrue(worker.pollOnce(), "outbox から1件を claim して配信する")
        }
        assertEquals(1, sent.size)
        rawConnection().use { connection ->
            connection.prepareStatement(
                """
                SELECT count(*)
                FROM app.review_notification_deliveries AS d
                JOIN app.review_notification_outbox AS o ON o.id = d.outbox_id
                WHERE o.thread_id = ?::uuid
                  AND d.status = 'SUCCEEDED'
                  AND d.external_reference = 'external-test-id'
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, threadId)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    assertEquals(1, rs.getInt(1), "外部受理後に delivery を成功状態へ確定する")
                }
            }
        }
    }

    @Test
    fun `通知設定はメンバーが参照できeditorだけが変更できる`() = withApp { client ->
        val viewerRead = client.get("/api/review-notifications?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(HttpStatusCode.OK, viewerRead.status, viewerRead.bodyAsText())
        val settings = body(viewerRead.bodyAsText())
        assertEquals(false, settings.getValue("emailAvailable").jsonPrimitive.content.toBoolean())
        assertNull(settings["teamsWebhookUrl"], "Webhook URL は API へ公開しない")

        val viewerPatch = client.patch("/api/review-notifications?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, viewerBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"emailEnabled":false,"teamsEnabled":false,"issueEnabled":false}""")
        }
        assertEquals(HttpStatusCode.Forbidden, viewerPatch.status)

        val unavailable = client.patch("/api/review-notifications?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"emailEnabled":false,"teamsEnabled":true,"issueEnabled":false}""")
        }
        assertEquals(HttpStatusCode.Conflict, unavailable.status, unavailable.bodyAsText())

        val outsiderRead = client.get("/api/review-notifications?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, outsiderBearer)
        }
        assertEquals(HttpStatusCode.Forbidden, outsiderRead.status)
    }

    @Test
    fun `editor が Resolve と Reopen を行い viewer の状態変更を拒否する`() = withApp { client ->
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata).bodyAsText())
            .getValue("id").jsonPrimitive.content

        assertEquals(
            HttpStatusCode.Forbidden,
            patchStatus(client, threadId, viewerBearer, "RESOLVED").status,
            "メンバーでも viewer は状態を変更できない"
        )
        val resolved = patchStatus(client, threadId, editorBearer, "RESOLVED")
        assertEquals(HttpStatusCode.OK, resolved.status, resolved.bodyAsText())
        assertEquals("RESOLVED", body(resolved.bodyAsText()).getValue("status").jsonPrimitive.content)

        val replyToResolved = postMessage(client, threadId, viewerBearer, "解決後の追記")
        assertEquals(HttpStatusCode.Conflict, replyToResolved.status, replyToResolved.bodyAsText())

        val reopened = patchStatus(client, threadId, editorBearer, "OPEN")
        assertEquals(HttpStatusCode.OK, reopened.status, reopened.bodyAsText())
        assertEquals("OPEN", body(reopened.bodyAsText()).getValue("status").jsonPrimitive.content)
        assertEquals(
            HttpStatusCode.Created,
            postMessage(client, threadId, viewerBearer, "再開後の追記").status
        )
    }

    @Test
    fun `返信と状態変更の不正入力および非メンバーを拒否する`() = withApp { client ->
        val sessionId = createSession(client)
        val threadId = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata).bodyAsText())
            .getValue("id").jsonPrimitive.content

        assertEquals(HttpStatusCode.BadRequest, postMessage(client, threadId, viewerBearer, " ").status)
        assertEquals(HttpStatusCode.BadRequest, patchStatus(client, threadId, editorBearer, "CLOSED").status)
        assertEquals(
            HttpStatusCode.NotFound,
            postMessage(client, threadId, outsiderBearer, "閲覧できない返信").status,
            "非メンバーにはスレッドの存在自体を隠す"
        )
        assertEquals(
            HttpStatusCode.NotFound,
            patchStatus(client, threadId, outsiderBearer, "RESOLVED").status
        )
    }

    @Test
    fun `投稿者本人だけがコメントを編集でき全版を履歴で確認できる`() = withApp { client ->
        val sessionId = createSession(client)
        val createdThread = body(postThread(client, sessionId, viewerBearer, uiTargetMetadata).bodyAsText())
        val messageId = createdThread.getValue("messages").jsonArray.single().jsonObject
            .getValue("id").jsonPrimitive.content

        val updateCallId = "feedback-message-update-${System.nanoTime()}"
        val updated = client.patch("/api/messages/$messageId") {
            header(HttpHeaders.Authorization, viewerBearer)
            header(HttpHeaders.XRequestId, updateCallId)
            contentType(ContentType.Application.Json)
            setBody("""{"body":"項目名を契約終了日に変更してください"}""")
        }
        assertEquals(HttpStatusCode.OK, updated.status, updated.bodyAsText())
        assertEquals(
            "項目名を契約終了日に変更してください",
            body(updated.bodyAsText()).getValue("body").jsonPrimitive.content
        )
        assertNotNull(body(updated.bodyAsText())["editedAt"]?.jsonPrimitive?.contentOrNull())

        val historyResponse = client.get("/api/messages/$messageId/history") {
            header(HttpHeaders.Authorization, viewerBearer)
        }
        assertEquals(HttpStatusCode.OK, historyResponse.status, historyResponse.bodyAsText())
        val history = Json.parseToJsonElement(historyResponse.bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals(listOf(2, 1), history.map { it.getValue("version").jsonPrimitive.content.toInt() })
        assertEquals(true, history[0].getValue("current").jsonPrimitive.content.toBoolean())
        assertEquals("この項目は必要ですか？", history[1].getValue("body").jsonPrimitive.content)

        assertEquals(
            HttpStatusCode.Forbidden,
            client.patch("/api/messages/$messageId") {
                header(HttpHeaders.Authorization, editorBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"body":"他人による上書き"}""")
            }.status,
            "同じプロジェクトの editor でも投稿者本人でなければ編集できない"
        )
        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/messages/$messageId/history") {
                header(HttpHeaders.Authorization, outsiderBearer)
            }.status,
            "非メンバーにはメッセージの存在自体を隠す"
        )

        rawConnection().use { connection ->
            connection.prepareStatement("SELECT detail::text FROM app.audit_logs WHERE call_id = ?").use { stmt ->
                stmt.setString(1, updateCallId)
                stmt.executeQuery().use { rs ->
                    assertTrue(rs.next(), "コメント編集の監査差分が残るはず")
                    val detail = rs.getString(1)
                    assertTrue("この項目は必要ですか？" in detail, detail)
                    assertTrue("項目名を契約終了日に変更してください" in detail, detail)
                }
            }
        }
    }

    @Test
    fun `証跡保存期間を継承上書きし期限切れを遮断して削除できる`() = withApp { client ->
        val sessionId = createSession(client)
        val expiredMetadata = uiTargetMetadata.replace(
            "2026-08-12T10:15:00+09:00",
            "2020-01-01T10:15:00+09:00"
        )
        val threadId = body(
            postThread(client, sessionId, viewerBearer, expiredMetadata, pngBytes).bodyAsText()
        ).getValue("id").jsonPrimitive.content
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/threads/$threadId/evidence") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.status,
            "保存方針未設定では従来どおり保持する"
        )

        assertEquals(
            HttpStatusCode.Forbidden,
            client.patch("/api/review-retention?projectId=$defaultProject") {
                header(HttpHeaders.Authorization, viewerBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"defaultEvidenceRetentionDays":1}""")
            }.status
        )
        val policyUpdate = client.patch("/api/review-retention?projectId=$defaultProject") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"defaultEvidenceRetentionDays":1}""")
        }
        assertEquals(HttpStatusCode.OK, policyUpdate.status, policyUpdate.bodyAsText())
        assertEquals(
            1,
            body(policyUpdate.bodyAsText()).getValue("defaultEvidenceRetentionDays").jsonPrimitive.content.toInt()
        )

        val sessionUpdate = client.patch("/api/review-sessions/$sessionId") {
            header(HttpHeaders.Authorization, editorBearer)
            contentType(ContentType.Application.Json)
            setBody("""{"evidenceRetentionDays":2}""")
        }
        assertEquals(HttpStatusCode.OK, sessionUpdate.status, sessionUpdate.bodyAsText())
        val updatedSession = body(sessionUpdate.bodyAsText())
        assertEquals(2, updatedSession.getValue("evidenceRetentionDays").jsonPrimitive.content.toInt())
        assertEquals(2, updatedSession.getValue("effectiveEvidenceRetentionDays").jsonPrimitive.content.toInt())

        assertEquals(
            HttpStatusCode.NotFound,
            client.get("/api/threads/$threadId/evidence") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.status,
            "期限切れ証跡は物理削除前でも配信しない"
        )
        val threadAfterExpiry = body(
            client.get("/api/threads/$threadId") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.bodyAsText()
        )
        assertNull(threadAfterExpiry["evidence"]?.jsonPrimitive?.contentOrNull())

        val policy = body(
            client.get("/api/review-retention?projectId=$defaultProject") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.bodyAsText()
        )
        assertTrue(policy.getValue("expiredEvidenceCount").jsonPrimitive.content.toLong() >= 1)
        assertEquals(
            HttpStatusCode.Forbidden,
            client.post("/api/review-retention/purge?projectId=$defaultProject&limit=10") {
                header(HttpHeaders.Authorization, viewerBearer)
            }.status
        )

        val purge = client.post("/api/review-retention/purge?projectId=$defaultProject&limit=10") {
            header(HttpHeaders.Authorization, editorBearer)
        }
        assertEquals(HttpStatusCode.OK, purge.status, purge.bodyAsText())
        assertTrue(body(purge.bodyAsText()).getValue("purgedEvidenceCount").jsonPrimitive.content.toInt() >= 1)
        rawConnection().use { connection ->
            connection.prepareStatement(
                "SELECT evidence_id FROM app.feedback_threads WHERE id = ?::uuid"
            ).use { stmt ->
                stmt.setString(1, threadId)
                stmt.executeQuery().use { rs ->
                    assertTrue(rs.next())
                    assertNull(rs.getString(1), "物理削除後はスレッドの証跡参照も外れる")
                }
            }
        }
    }

    @Test
    fun `管理画面用にプロジェクト横断検索とセッション観点別集計ができる`() = withApp { client ->
        val managementProject = "50000000-0000-4000-8000-000000000005"
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.projects (id, name)
                    VALUES ('$managementProject', 'Phase 5 管理画面テスト')
                    ON CONFLICT (id) DO NOTHING;

                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES ('e0000000-0000-4000-8000-000000000001', '$managementProject', 'editor')
                    ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role;
                    """.trimIndent()
                )
            }
        }
        val sessionId = createSession(client, projectId = managementProject)
        val withEvidenceId = body(
            postThread(client, sessionId, editorBearer, uiTargetMetadata, pngBytes).bodyAsText()
        ).getValue("id").jsonPrimitive.content
        val resolvedMetadata = uiTargetMetadata.replace("この項目は必要ですか？", "phase five resolved comment")
        val resolvedId = body(
            postThread(client, sessionId, editorBearer, resolvedMetadata).bodyAsText()
        ).getValue("id").jsonPrimitive.content
        assertEquals(HttpStatusCode.OK, patchStatus(client, resolvedId, editorBearer, "RESOLVED").status)

        val search = client.get(
            "/api/threads?projectId=$managementProject&reviewSessionId=$sessionId" +
                "&status=RESOLVED&perspectiveCode=BUSINESS_FLOW&hasEvidence=false&q=resolved"
        ) {
            header(HttpHeaders.Authorization, editorBearer)
        }
        assertEquals(HttpStatusCode.OK, search.status, search.bodyAsText())
        assertEquals("1", search.headers["X-Total-Count"])
        val searched = Json.parseToJsonElement(search.bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals(listOf(resolvedId), searched.map { it.getValue("id").jsonPrimitive.content })

        val evidenceSearch = client.get(
            "/api/threads?projectId=$managementProject&reviewSessionId=$sessionId&hasEvidence=true"
        ) {
            header(HttpHeaders.Authorization, editorBearer)
        }
        val evidenceThreads = Json.parseToJsonElement(evidenceSearch.bodyAsText()).jsonArray.map { it.jsonObject }
        assertEquals(listOf(withEvidenceId), evidenceThreads.map { it.getValue("id").jsonPrimitive.content })

        val summaryResponse = client.get("/api/threads/summary?projectId=$managementProject") {
            header(HttpHeaders.Authorization, editorBearer)
        }
        assertEquals(HttpStatusCode.OK, summaryResponse.status, summaryResponse.bodyAsText())
        val summary = body(summaryResponse.bodyAsText())
        assertEquals(2, summary.getValue("totalCount").jsonPrimitive.content.toInt())
        assertEquals(1, summary.getValue("openCount").jsonPrimitive.content.toInt())
        assertEquals(1, summary.getValue("resolvedCount").jsonPrimitive.content.toInt())
        assertEquals(1, summary.getValue("withEvidenceCount").jsonPrimitive.content.toInt())
        val sessionSummary = summary.getValue("sessions").jsonArray.single().jsonObject
        assertEquals(sessionId, sessionSummary.getValue("reviewSessionId").jsonPrimitive.content)
        assertEquals(2, sessionSummary.getValue("totalCount").jsonPrimitive.content.toInt())
        val perspectiveSummary = summary.getValue("perspectives").jsonArray.single().jsonObject
        assertEquals("BUSINESS_FLOW", perspectiveSummary.getValue("perspectiveCode").jsonPrimitive.content)
        assertEquals(2, perspectiveSummary.getValue("totalCount").jsonPrimitive.content.toInt())

        assertEquals(
            HttpStatusCode.BadRequest,
            client.get("/api/threads?projectId=$managementProject&hasEvidence=maybe") {
                header(HttpHeaders.Authorization, editorBearer)
            }.status
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            client.get("/api/threads/summary?projectId=$managementProject") {
                header(HttpHeaders.Authorization, outsiderBearer)
            }.status,
            "projectId 明示操作の非メンバー拒否は 403"
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
