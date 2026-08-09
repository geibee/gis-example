package feedback.service

import com.sun.net.httpserver.HttpServer
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.net.InetSocketAddress
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.io.TempDir

class ConnectorRuntimeTest {
    @TempDir
    lateinit var temporaryDirectory: Path

    @Test
    fun `署名と時刻ずれを検証しdelivery IDを永続的に冪等化する`() = testApplication {
        val now = Instant.parse("2026-08-09T00:00:00Z")
        val settings = settings()
        val calls = AtomicInteger()
        val storePath = temporaryDirectory.resolve("delivery-ids.log")
        application {
            connectorRuntimeModule(
                settings,
                ReferenceConnectorDispatcher { calls.incrementAndGet() },
                FileDeliveryIdStore(storePath, 100),
                now = { now }
            )
        }
        val delivery = fixture()
        val raw = serviceJson.encodeToString(ConnectorDeliveryRequestV1.serializer(), delivery)

        assertEquals(HttpStatusCode.Unauthorized, send(raw, now.minusSeconds(301).epochSecond, settings.sharedSecret).status)
        assertEquals(HttpStatusCode.Unauthorized, send(raw, now.epochSecond, "wrong-secret").status)
        assertEquals(
            HttpStatusCode.BadRequest,
            send(raw, now.epochSecond, settings.sharedSecret, "00000000-0000-4000-8000-000000000099").status
        )
        val unknownField = delivery.copy(event = buildJsonObject {
            delivery.event.forEach { (key, value) -> put(key, value) }
            put("token", "外部へ出してはいけない値")
        })
        val unknownRaw = serviceJson.encodeToString(ConnectorDeliveryRequestV1.serializer(), unknownField)
        assertEquals(HttpStatusCode.BadRequest, send(unknownRaw, now.epochSecond, settings.sharedSecret).status)

        val accepted = send(raw, now.epochSecond, settings.sharedSecret)
        assertEquals(HttpStatusCode.Accepted, accepted.status)
        assertContains(accepted.bodyAsText(), "\"status\":\"accepted\"")
        val duplicate = send(raw, now.epochSecond, settings.sharedSecret)
        assertEquals(HttpStatusCode.OK, duplicate.status)
        assertContains(duplicate.bodyAsText(), "\"status\":\"duplicate\"")
        assertEquals(1, calls.get())

        val restarted = FileDeliveryIdStore(storePath, 100)
        assertTrue(restarted.contains(delivery.deliveryId), "再起動後もdelivery IDを保持する")
    }

    @Test
    fun `同じdelivery IDの並行要求を一度だけ外部送信する`() = testApplication {
        val now = Instant.parse("2026-08-09T00:00:00Z")
        val settings = settings()
        val calls = AtomicInteger()
        val firstDispatch = CountDownLatch(1)
        val release = CountDownLatch(1)
        application {
            connectorRuntimeModule(
                settings,
                ReferenceConnectorDispatcher {
                    calls.incrementAndGet()
                    firstDispatch.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                },
                FileDeliveryIdStore(temporaryDirectory.resolve("concurrent-delivery-ids.log"), 100),
                now = { now }
            )
        }
        val raw = serviceJson.encodeToString(ConnectorDeliveryRequestV1.serializer(), fixture())
        coroutineScope {
            val first = async(Dispatchers.Default) { send(raw, now.epochSecond, settings.sharedSecret) }
            assertTrue(firstDispatch.await(5, TimeUnit.SECONDS))
            val second = async(Dispatchers.Default) { send(raw, now.epochSecond, settings.sharedSecret) }
            delay(100)
            assertEquals(1, calls.get(), "同じdeliveryを並行dispatchしない")
            release.countDown()
            assertEquals(setOf(HttpStatusCode.Accepted, HttpStatusCode.OK), setOf(first.await().status, second.await().status))
        }
        assertEquals(1, calls.get())
    }

    @Test
    fun `4参照コネクタが共通fixtureを処理しdestinationとsecretを分離する`() {
        val requestsA = mutableListOf<String>()
        val requestsB = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/a") { exchange ->
                requestsA += exchange.requestBody.readAllBytes().decodeToString()
                exchange.sendResponseHeaders(204, -1)
                exchange.close()
            }
            createContext("/b") { exchange ->
                requestsB += exchange.requestBody.readAllBytes().decodeToString()
                exchange.sendResponseHeaders(204, -1)
                exchange.close()
            }
            start()
        }
        try {
            val settings = settings(
                destinations = mapOf(
                    "review-a" to "http://127.0.0.1:${server.address.port}/a",
                    "review-b" to "http://127.0.0.1:${server.address.port}/b"
                )
            )
            val delivery = fixture(destinationRef = "review-a")
            listOf(::webhookPayload, ::teamsPayload, ::slackPayload).forEach { renderer ->
                HttpReferenceConnector(settings, renderer).dispatch(delivery)
            }
            assertEquals(3, requestsA.size)
            assertTrue(requestsB.isEmpty())
            requestsA.forEach { body ->
                assertFalse(body.contains(settings.sharedSecret))
                assertFalse(body.contains("objectKey"))
                assertFalse(body.contains("evidenceUrl"))
            }
            assertContains(requestsA[0], "許可された本文")
            assertContains(requestsA[1], "Feedback notification")
            assertContains(requestsA[2], "deep.example")
            assertFailsWith<IllegalArgumentException> {
                HttpReferenceConnector(settings, ::webhookPayload).dispatch(delivery.copy(destinationRef = "unknown"))
            }

            val sentMail = mutableListOf<MailDelivery>()
            val smtp = SmtpSettings("smtp.internal", 587, "user", "smtp-secret", "feedback@example.invalid")
            SmtpReferenceConnector(
                settings.copy(destinations = mapOf("review-a" to "a@example.invalid", "review-b" to "b@example.invalid")),
                smtp,
                MailSender(sentMail::add)
            ).dispatch(delivery)
            assertEquals(listOf("a@example.invalid"), sentMail.single().to)
            assertContains(sentMail.single().body, "許可された本文")
            assertFalse(sentMail.single().body.contains("smtp-secret"))
        } finally {
            server.stop(0)
        }
    }

    private suspend fun io.ktor.server.testing.ApplicationTestBuilder.send(
        raw: String,
        timestamp: Long,
        secret: String,
        deliveryId: String = fixture().deliveryId
    ) = client.post("/connector/v1/deliveries") {
        contentType(ContentType.Application.Json)
        header("X-Feedback-Delivery-Id", deliveryId)
        header("X-Feedback-Timestamp", timestamp.toString())
        header("X-Feedback-Signature", "v1=${connectorHmacSha256(secret, "$timestamp.$raw")}")
        setBody(raw)
    }

    private fun settings(destinations: Map<String, String> = mapOf("review-a" to "https://connector.example.invalid")) =
        ConnectorRuntimeSettings(
            port = 8091,
            provider = "webhook",
            displayName = "Webhook",
            sharedSecret = "runtime-test-shared-secret-32chars",
            destinations = destinations,
            allowLocalHttp = true,
            idempotencyFile = temporaryDirectory.resolve("unused.log")
        )

    private fun fixture(destinationRef: String = "review-a") = ConnectorDeliveryRequestV1(
        kind = "delivery-request",
        protocolVersion = "1",
        deliveryId = "00000000-0000-4000-8000-000000000031",
        eventId = "00000000-0000-4000-8000-000000000032",
        destinationRef = destinationRef,
        occurredAt = "2026-08-09T00:00:00Z",
        event = buildJsonObject {
            put("schemaVersion", "1")
            put("eventId", "00000000-0000-4000-8000-000000000032")
            put("requestId", "connector-runtime-test")
            put("eventType", "feedback.message.created.v1")
            put("occurredAt", "2026-08-09T00:00:00Z")
            put("tenantKey", "tenant-a")
            put("applicationKey", "app-a")
            put("environmentKey", "production")
            put("externalWorkspaceKey", "workspace-a")
            put("sessionId", "00000000-0000-4000-8000-000000000033")
            put("threadId", "00000000-0000-4000-8000-000000000034")
            put("actor", buildJsonObject {
                put("principalId", "principal-a")
                put("displayName", "テスト担当者")
            })
            put("body", "許可された本文")
            put("deepLink", "https://deep.example/thread")
        }
    )
}
