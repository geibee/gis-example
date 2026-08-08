package feedback.service

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Instant
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WebhookDispatcherTest {
    private val secret = "fixture-signing-secret-32-characters"

    @Test
    fun `ローカルHTTP fixtureへ署名付きで送り本文と証跡を既定除外する`() {
        val received = mutableMapOf<String, String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/webhook") { exchange ->
            received["body"] = exchange.requestBody.readAllBytes().toString(Charsets.UTF_8)
            received["delivery"] = exchange.requestHeaders.getFirst("X-Feedback-Delivery-Id")
            received["timestamp"] = exchange.requestHeaders.getFirst("X-Feedback-Timestamp")
            received["signature"] = exchange.requestHeaders.getFirst("X-Feedback-Signature")
            exchange.sendResponseHeaders(204, -1)
            exchange.close()
        }
        server.start()
        try {
            val dispatcher = WebhookDispatcher(
                signingSecret = secret,
                allowLocalDestinations = true,
                now = { Instant.ofEpochSecond(1_786_233_600) }
            )
            val result = dispatcher.dispatch(
                ClaimedDelivery(
                    id = "delivery-1",
                    payload = """{"eventType":"feedback.thread.created.v1","body":"secret body","evidenceUrl":"https://private.invalid/evidence","threadId":"thread-1"}""",
                    attempt = 1,
                    endpoint = "http://127.0.0.1:${server.address.port}/webhook",
                    includeBody = false,
                    includeEvidence = false,
                    retryCycle = 0
                )
            )
            assertEquals(204, result.responseStatus)
            assertNull(result.error)
            val body = received.getValue("body")
            assertContains(body, "feedback.thread.created.v1")
            assertFalse(body.contains("secret body"))
            assertFalse(body.contains("evidence"))
            assertEquals("delivery-1", received["delivery"])
            assertEquals(
                "v1=${hmac(secret, "1786233600.$body")}",
                received["signature"]
            )
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `local宛先は明示fixture設定なしでは拒否する`() {
        val dispatcher = WebhookDispatcher(signingSecret = secret)
        val result = dispatcher.dispatch(
            ClaimedDelivery(
                id = "delivery-1",
                payload = "{}",
                attempt = 1,
                endpoint = "http://127.0.0.1:9/webhook",
                includeBody = false,
                includeEvidence = false,
                retryCycle = 0
            )
        )
        assertNotNull(result.error)
        assertContains(requireNotNull(result.error), "https")
    }

    private fun hmac(key: String, value: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return mac.doFinal(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
