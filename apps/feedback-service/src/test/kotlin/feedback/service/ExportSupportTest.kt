package feedback.service

import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ExportSupportTest {
    @Test
    fun `CSVとXLSXの文字列をformulaとして出力しない`() {
        val row = sampleRow(latestMessage = "=HYPERLINK(\"https://attacker.invalid\")")
        val csv = renderFeedbackExport("csv", "ja-JP", "Asia/Tokyo", listOf(row)).toString(Charsets.UTF_8)
        assertContains(csv, "'=HYPERLINK")

        val xlsx = renderFeedbackExport("xlsx", "ja-JP", "Asia/Tokyo", listOf(row))
        assertTrue(xlsx.copyOfRange(0, 2).contentEquals(byteArrayOf('P'.code.toByte(), 'K'.code.toByte())))
        val sheet = unzipEntry(xlsx, "xl/worksheets/sheet1.xml")
        assertContains(sheet, "&apos;=HYPERLINK")
        assertFalse(sheet.contains("<f>"))
    }

    @Test
    fun `deep linkは登録environmentとmanifestのstore parameterだけから組み立てる`() {
        val manifest = manifest("store")
        val location = JsonObject(
            mapOf(
                "pageKey" to JsonPrimitive("orders.detail"),
                "routeTemplate" to JsonPrimitive("/orders/{id}"),
                "pathParameters" to JsonObject(mapOf("id" to JsonPrimitive("O 1"))),
                "queryParameters" to JsonObject(
                    mapOf("tab" to JsonPrimitive("history"), "secret" to JsonPrimitive("sha256:deadbeef"))
                )
            )
        )
        assertEquals(
            "https://consumer.example/orders/O%201?tab=history&feedbackThread=thread-1",
            buildFeedbackDeepLink(
                "https://consumer.example",
                "feedbackThread",
                manifest,
                location,
                "thread-1"
            )
        )
    }

    @Test
    fun `hash化したpath parameterはlinkへ漏らさずapplication rootへ戻す`() {
        val location = JsonObject(
            mapOf(
                "pageKey" to JsonPrimitive("orders.detail"),
                "routeTemplate" to JsonPrimitive("/orders/{id}"),
                "pathParameters" to JsonObject(mapOf("id" to JsonPrimitive("sha256:secret")))
            )
        )
        val link = buildFeedbackDeepLink(
            "https://consumer.example/app",
            "thread",
            manifest("hash"),
            location,
            "thread-1"
        )
        assertEquals("https://consumer.example/app/?thread=thread-1", link)
        assertFalse(link.contains("secret"))
    }

    private fun sampleRow(latestMessage: String) = FeedbackExportRow(
        threadId = "thread-1",
        displayNumber = 1,
        sessionId = "session-1",
        status = "open",
        perspectiveCode = "quality",
        pageKey = "orders.detail",
        routeTemplate = "/orders/{id}",
        targetKind = "ui-element",
        reporterName = "利用者",
        messageCount = 1,
        latestMessage = latestMessage,
        deepLink = "https://consumer.example/orders/O-1?feedbackThread=thread-1",
        evidenceAvailable = true,
        createdAt = "2026-08-09T00:00:00Z",
        updatedAt = "2026-08-09T00:00:00Z"
    )

    private fun manifest(pathPersistence: String): JsonObject = JsonObject(
        mapOf(
            "routes" to kotlinx.serialization.json.JsonArray(
                listOf(
                    JsonObject(
                        mapOf(
                            "pageKey" to JsonPrimitive("orders.detail"),
                            "template" to JsonPrimitive("/orders/{id}"),
                            "parameters" to JsonObject(
                                mapOf("id" to JsonObject(mapOf("persistence" to JsonPrimitive(pathPersistence))))
                            ),
                            "queryParameters" to JsonObject(
                                mapOf(
                                    "tab" to JsonObject(mapOf("persistence" to JsonPrimitive("store"))),
                                    "secret" to JsonObject(mapOf("persistence" to JsonPrimitive("hash")))
                                )
                            )
                        )
                    )
                )
            )
        )
    )

    private fun unzipEntry(bytes: ByteArray, expected: String): String {
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: error("$expected がありません")
                if (entry.name == expected) return zip.readAllBytes().toString(Charsets.UTF_8)
            }
        }
    }
}
