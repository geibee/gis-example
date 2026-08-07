package gis.example

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReviewNotificationTest {
    @Test
    fun `通知本文は証跡を含めずレビューへの内部リンクを生成する`() {
        val notification = ClaimedReviewNotification(
            deliveryId = "delivery-1",
            outboxId = "outbox-1",
            channel = ReviewNotificationChannel.TEAMS,
            destination = null,
            eventType = "THREAD_CREATED",
            projectId = "project-1",
            threadId = "thread-1",
            payload = buildJsonObject {
                put("projectName", "道路台帳")
                put("sessionTitle", "第1回レビュー")
                put("perspectiveLabel", "業務フロー")
                put("actorName", "レビュー担当")
                put("body", "検索条件を保持してください")
            },
            attemptCount = 1
        )

        val content = renderReviewNotification(notification, "https://gis.example/")

        assertEquals("[道路台帳] 新しい指摘: 業務フロー", content.title)
        assertTrue(content.text.contains("レビュー担当 · 第1回レビュー"))
        assertTrue(content.text.contains("検索条件を保持してください"))
        assertEquals(
            "https://gis.example/review?projectId=project-1&threadId=thread-1",
            content.link
        )
        assertFalse(content.text.contains("screenshot", ignoreCase = true))
    }

    @Test
    fun `接続先未設定では全チャネルを利用不可として起動できる`() {
        reviewNotificationSenderFromEnv { null }.use { sender ->
            assertEquals(ReviewNotificationCapabilities(), sender.capabilities)
        }
    }

    @Test
    fun `Webhook設定のあるチャネルだけを利用可能にする`() {
        val env = mapOf(
            "REVIEW_TEAMS_WEBHOOK_URL" to "https://teams.example/hook",
            "REVIEW_ISSUE_WEBHOOK_URL" to "https://issues.example/hook"
        )
        reviewNotificationSenderFromEnv(env::get).use { sender ->
            assertFalse(sender.capabilities.email)
            assertTrue(sender.capabilities.teams)
            assertTrue(sender.capabilities.issue)
        }
    }

    @Test
    fun `Issue Webhookへ冪等キーとBearer tokenを付けて一方向送信する`() {
        var requestBody = ""
        var idempotencyKey: String? = null
        var authorization: String? = null
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/issues") { exchange ->
            requestBody = exchange.requestBody.bufferedReader().use { it.readText() }
            idempotencyKey = exchange.requestHeaders.getFirst("Idempotency-Key")
            authorization = exchange.requestHeaders.getFirst("Authorization")
            exchange.responseHeaders.add("Location", "https://issues.example/123")
            exchange.sendResponseHeaders(201, -1)
            exchange.close()
        }
        server.start()
        try {
            val env = mapOf(
                "REVIEW_ISSUE_WEBHOOK_URL" to "http://127.0.0.1:${server.address.port}/issues",
                "REVIEW_ISSUE_WEBHOOK_TOKEN" to "test-token"
            )
            reviewNotificationSenderFromEnv(env::get).use { sender ->
                val reference = sender.send(
                    ClaimedReviewNotification(
                        deliveryId = "delivery-1",
                        outboxId = "outbox-1",
                        channel = ReviewNotificationChannel.ISSUE,
                        destination = null,
                        eventType = "THREAD_CREATED",
                        projectId = "project-1",
                        threadId = "thread-1",
                        payload = buildJsonObject {
                            put("projectName", "道路台帳")
                            put("sessionTitle", "第1回レビュー")
                            put("perspectiveLabel", "業務フロー")
                            put("actorName", "レビュー担当")
                            put("body", "Issue にする指摘")
                        },
                        attemptCount = 1
                    )
                )
                assertEquals("https://issues.example/123", reference)
            }
        } finally {
            server.stop(0)
        }

        assertEquals("outbox-1", idempotencyKey)
        assertEquals("Bearer test-token", authorization)
        assertTrue(requestBody.contains("\"event\":\"review.issue.create\""))
        assertTrue(requestBody.contains("\"idempotencyKey\":\"outbox-1\""))
        assertFalse(requestBody.contains("screenshot", ignoreCase = true))
    }
}
