package feedback.service

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ValidationTest {
    private val manifest = buildJsonObject {
        put("schemaVersion", "1")
        put("applicationKey", "consumer-app")
        put("displayName", "Consumer App")
        put("manifestVersion", "2026-08-09")
        put("routes", buildJsonArray {
            add(buildJsonObject {
                put("pageKey", "orders.detail")
                put("template", "/orders/{orderId}")
                put("label", "注文詳細")
                put("parameters", buildJsonObject {
                    put("orderId", buildJsonObject { put("persistence", "hash") })
                })
                put("queryParameters", buildJsonObject {
                    put("tab", buildJsonObject { put("persistence", "store") })
                    put("token", buildJsonObject { put("persistence", "discard") })
                })
            })
        })
    }

    @Test
    fun `manifest は route parameter と policy の一致を検証する`() {
        assertEquals(manifest, validateManifest("consumer-app", manifest))
        val invalid = JsonObject(manifest + ("applicationKey" to JsonPrimitive("other-app")))
        assertFailsWith<FeedbackApiException> { validateManifest("consumer-app", invalid) }
    }

    @Test
    fun `location は allowlist だけを保存し hash と discard を適用する`() {
        val location = buildJsonObject {
            put("schemaVersion", "1")
            put("pageKey", "orders.detail")
            put("routeTemplate", "/orders/{orderId}")
            put("pathParameters", buildJsonObject { put("orderId", "secret-order") })
            put("queryParameters", buildJsonObject {
                put("tab", "history")
                put("token", "never-store")
                put("unknown", "discard-me")
            })
        }
        val sanitized = sanitizeLocation(location, manifest)
        val path = sanitized.getValue("pathParameters") as JsonObject
        val query = sanitized.getValue("queryParameters") as JsonObject
        assertTrue(path.getValue("orderId").toString().contains("sha256:"))
        assertEquals(JsonPrimitive("history"), query["tab"])
        assertFalse("token" in query)
        assertFalse("unknown" in query)
    }

    @Test
    fun `target は variant ごとの範囲と未知 field を拒否する`() {
        val valid = buildJsonObject {
            put("schemaVersion", "1")
            put("kind", "map-position")
            put("longitude", 139.7)
            put("latitude", 35.6)
        }
        assertEquals(valid, validateTarget(valid))
        assertFailsWith<FeedbackApiException> {
            validateTarget(JsonObject(valid + ("latitude" to JsonPrimitive(91))))
        }
        assertFailsWith<FeedbackApiException> {
            validateTarget(JsonObject(valid + ("projectId" to JsonPrimitive("host-coupling"))))
        }
    }

    @Test
    fun `evidence は magic bytes と size を検証する`() {
        val png = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0)
        val input = EvidenceCreateRequest(
            contentType = "image/png",
            dataBase64 = java.util.Base64.getEncoder().encodeToString(png),
            viewportWidth = 100,
            viewportHeight = 100,
            pixelRatio = 1.0,
            capturedAt = "2026-08-09T00:00:00Z"
        )
        assertTrue(decodeEvidence(input, 100).contentEquals(png))
        assertFailsWith<FeedbackApiException> { decodeEvidence(input, 1) }
    }
}
