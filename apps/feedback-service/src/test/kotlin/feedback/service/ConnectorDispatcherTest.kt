package feedback.service

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConnectorDispatcherTest {
    @Test
    fun `登録時にconnector descriptorとの不一致を拒否する`() {
        val descriptor = ConnectorManifestV1(
            connectorKey = "teams",
            displayName = "Teams",
            supportedEvents = listOf("feedback.message.created.v1")
        )
        validateConnectorManifest("teams", listOf("feedback.message.created.v1"), descriptor)
        assertFailsWith<IllegalArgumentException> {
            validateConnectorManifest("slack", listOf("feedback.message.created.v1"), descriptor)
        }
        assertFailsWith<IllegalArgumentException> {
            validateConnectorManifest("teams", listOf("feedback.thread.created.v1"), descriptor)
        }
    }

    @Test
    fun `protocol envelopeをdelivery固有署名付きで別プロセスへ送る`() {
        val body = AtomicReference<String>()
        val signature = AtomicReference<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/connector/v1/deliveries") { exchange ->
                body.set(exchange.requestBody.use { it.readAllBytes().decodeToString() })
                signature.set(exchange.requestHeaders.getFirst("X-Feedback-Signature"))
                val response = """{"kind":"delivery-result","protocolVersion":"1","deliveryId":"00000000-0000-4000-8000-000000000001","status":"accepted","receivedAt":"2026-08-09T00:00:01Z"}"""
                exchange.sendResponseHeaders(202, response.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(response.toByteArray()) }
                exchange.close()
            }
            start()
        }
        try {
            val secret = "connector-test-signing-secret-32chars"
            val result = ConnectorHttpDispatcher(
                allowLocalDestinations = true,
                now = { Instant.ofEpochSecond(1_700_000_000) }
            ).dispatch(
                ClaimedConnectorDelivery(
                    id = "00000000-0000-4000-8000-000000000001",
                    eventId = "00000000-0000-4000-8000-000000000002",
                    event = buildJsonObject {
                        put("eventId", "00000000-0000-4000-8000-000000000002")
                        put("eventType", "feedback.message.created.v1")
                        put("occurredAt", "2026-08-09T00:00:00Z")
                        put("body", "secret body")
                    },
                    attempt = 1,
                    retryCycle = 0,
                    destinationRef = "review-channel",
                    includeBody = false,
                    deliveryUrl = "http://127.0.0.1:${server.address.port}/connector/v1/deliveries",
                    signingSecret = secret,
                    tenantId = "tenant-id",
                    allowedHosts = setOf("127.0.0.1")
                )
            )
            assertEquals(202, result.responseStatus)
            val sent = assertNotNull(body.get())
            assertTrue("secret body" !in sent)
            assertTrue("review-channel" in sent)
            val envelope = serviceJson.parseToJsonElement(sent).jsonObject
            assertEquals("delivery-request", envelope.getValue("kind").jsonPrimitive.content)
            assertEquals("00000000-0000-4000-8000-000000000002", envelope.getValue("eventId").jsonPrimitive.content)
            assertEquals("2026-08-09T00:00:00Z", envelope.getValue("occurredAt").jsonPrimitive.content)
            assertEquals(
                "v1=${connectorHmacSha256(secret, "1700000000.$sent")}",
                signature.get()
            )
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `allowlist外hostとretry分類を拒否する`() {
        assertFailsWith<IllegalArgumentException> {
            validateConnectorDestination(
                "https://example.invalid/connector/v1/deliveries",
                setOf("connector.internal"),
                allowLocalDestinations = false,
                allowPrivateDestinations = false
            )
        }
        assertTrue(isRetryableConnectorResponse(null))
        assertTrue(isRetryableConnectorResponse(408))
        assertTrue(isRetryableConnectorResponse(429))
        assertTrue(isRetryableConnectorResponse(503))
        assertFalse(isRetryableConnectorResponse(400))
        assertFalse(isRetryableConnectorResponse(404))
        assertFalse(isRetryableConnectorResponse(202))
    }

    @Test
    fun `timeoutと429だけを再試行し恒久4xxを停止する`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/timeout") { exchange ->
                Thread.sleep(200)
                runCatching { exchange.sendResponseHeaders(204, -1) }
                exchange.close()
            }
            createContext("/rate-limited") { exchange ->
                exchange.sendResponseHeaders(429, -1)
                exchange.close()
            }
            createContext("/bad-request") { exchange ->
                exchange.sendResponseHeaders(400, -1)
                exchange.close()
            }
            start()
        }
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            val timeout = ConnectorHttpDispatcher(
                allowLocalDestinations = true,
                requestTimeout = Duration.ofMillis(20)
            ).dispatch(delivery("$base/timeout"))
            val rateLimited = ConnectorHttpDispatcher(allowLocalDestinations = true)
                .dispatch(delivery("$base/rate-limited"))
            val badRequest = ConnectorHttpDispatcher(allowLocalDestinations = true)
                .dispatch(delivery("$base/bad-request"))
            assertEquals(null, timeout.responseStatus)
            assertTrue(isRetryableConnectorResponse(timeout.responseStatus))
            assertEquals(429, rateLimited.responseStatus)
            assertTrue(isRetryableConnectorResponse(rateLimited.responseStatus))
            assertEquals(400, badRequest.responseStatus)
            assertFalse(isRetryableConnectorResponse(badRequest.responseStatus))
        } finally {
            server.stop(0)
        }
    }

    private fun delivery(url: String) = ClaimedConnectorDelivery(
        id = "00000000-0000-4000-8000-000000000041",
        eventId = "00000000-0000-4000-8000-000000000042",
        event = buildJsonObject {
            put("eventId", "00000000-0000-4000-8000-000000000042")
            put("eventType", "feedback.message.created.v1")
            put("occurredAt", "2026-08-09T00:00:00Z")
        },
        attempt = 1,
        retryCycle = 0,
        destinationRef = "review-channel",
        includeBody = false,
        deliveryUrl = url,
        signingSecret = "connector-test-signing-secret-32chars",
        tenantId = "tenant-id",
        allowedHosts = setOf("127.0.0.1")
    )
}
