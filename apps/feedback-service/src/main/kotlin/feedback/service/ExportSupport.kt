package feedback.service

import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class FeedbackExportRow(
    val threadId: String,
    val displayNumber: Int,
    val sessionId: String,
    val status: String,
    val perspectiveCode: String,
    val pageKey: String,
    val routeTemplate: String,
    val targetKind: String,
    val reporterName: String,
    val messageCount: Int,
    val latestMessage: String,
    val deepLink: String,
    val evidenceAvailable: Boolean,
    val createdAt: String,
    val updatedAt: String
)

private val formulaPrefix = Regex("^[\\u0000-\\u0020]*[=+\\-@]")

/** CSV/XLSXの文字列セルが式として評価されないよう、危険な先頭文字へapostropheを付ける。 */
internal fun escapeSpreadsheetValue(value: String): String =
    if (formulaPrefix.containsMatchIn(value)) "'$value" else value

internal fun renderFeedbackExport(
    format: String,
    locale: String,
    timezone: String,
    rows: List<FeedbackExportRow>
): ByteArray {
    val labels = if (locale.lowercase().startsWith("ja")) {
        listOf(
            "スレッドID", "番号", "セッションID", "状態", "観点", "ページ", "ルート", "対象種別",
            "投稿者", "メッセージ数", "最新メッセージ", "対象アプリへのリンク", "証跡", "作成日時", "更新日時"
        )
    } else {
        listOf(
            "Thread ID", "Number", "Session ID", "Status", "Perspective", "Page", "Route", "Target",
            "Reporter", "Messages", "Latest message", "Application link", "Evidence", "Created at", "Updated at"
        )
    }
    val formatter = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss VV").withZone(ZoneId.of(timezone))
    val values = buildList {
        add(labels)
        rows.forEach { row ->
            add(
                listOf(
                    row.threadId,
                    row.displayNumber.toString(),
                    row.sessionId,
                    row.status,
                    row.perspectiveCode,
                    row.pageKey,
                    row.routeTemplate,
                    row.targetKind,
                    row.reporterName,
                    row.messageCount.toString(),
                    row.latestMessage,
                    row.deepLink,
                    row.evidenceAvailable.toString(),
                    formatter.format(Instant.parse(row.createdAt)),
                    formatter.format(Instant.parse(row.updatedAt))
                ).map(::escapeSpreadsheetValue)
            )
        }
    }
    return when (format) {
        "csv" -> renderCsv(values)
        "xlsx" -> renderXlsx(values)
        else -> error("未対応のexport formatです: $format")
    }
}

internal fun buildFeedbackDeepLink(
    baseUrl: String,
    deepLinkThreadParameter: String,
    manifest: JsonObject,
    location: JsonObject,
    threadId: String
): String {
    val pageKey = location.getValue("pageKey").jsonPrimitive.content
    val routeTemplate = location.getValue("routeTemplate").jsonPrimitive.content
    val route = manifest.getValue("routes").jsonArray.map { it.jsonObject }.firstOrNull { candidate ->
        candidate.getValue("pageKey").jsonPrimitive.content == pageKey &&
            (candidate.getValue("template").jsonPrimitive.content == routeTemplate ||
                candidate["aliases"]?.jsonArray?.any { it.jsonPrimitive.content == routeTemplate } == true)
    }
    val fallback = baseUrl.trimEnd('/') + "/"
    if (route == null) return appendQuery(fallback, mapOf(deepLinkThreadParameter to threadId))
    val pathValues = location["pathParameters"]?.jsonObject ?: JsonObject(emptyMap())
    val policies = route["parameters"]?.jsonObject ?: JsonObject(emptyMap())
    var path = routeTemplate
    Regex("\\{([A-Za-z_][A-Za-z0-9_]*)}").findAll(routeTemplate).forEach { match ->
        val name = match.groupValues[1]
        val persistence = policies[name]?.jsonObject?.get("persistence")?.jsonPrimitive?.content
        val value = pathValues[name]?.jsonPrimitive?.content
        if (persistence != "store" || value == null || value.startsWith("sha256:")) {
            return appendQuery(fallback, mapOf(deepLinkThreadParameter to threadId))
        }
        path = path.replace(match.value, encodeUrlPart(value))
    }
    val queryPolicies = route["queryParameters"]?.jsonObject ?: JsonObject(emptyMap())
    val queryValues = location["queryParameters"]?.jsonObject ?: JsonObject(emptyMap())
    val query = buildMap {
        queryValues.forEach { (name, value) ->
            if (queryPolicies[name]?.jsonObject?.get("persistence")?.jsonPrimitive?.content == "store") {
                put(name, value.jsonPrimitive.content)
            }
        }
        put(deepLinkThreadParameter, threadId)
    }
    return appendQuery(baseUrl.trimEnd('/') + path, query)
}

private fun appendQuery(url: String, values: Map<String, String>): String =
    url + (if ('?' in url) "&" else "?") + values.entries.joinToString("&") { (name, value) ->
        "${encodeUrlPart(name)}=${encodeUrlPart(value)}"
    }

private fun encodeUrlPart(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")

private fun renderCsv(rows: List<List<String>>): ByteArray {
    val text = rows.joinToString("\r\n", postfix = "\r\n") { row ->
        row.joinToString(",") { value -> "\"${value.replace("\"", "\"\"")}\"" }
    }
    return byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + text.toByteArray(StandardCharsets.UTF_8)
}

private fun renderXlsx(rows: List<List<String>>): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { zip ->
        zip.writeEntry(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
              <Default Extension="xml" ContentType="application/xml"/>
              <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
              <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
            </Types>""".trimIndent()
        )
        zip.writeEntry(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
            </Relationships>""".trimIndent()
        )
        zip.writeEntry(
            "xl/workbook.xml",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
              <sheets><sheet name="Feedback" sheetId="1" r:id="rId1"/></sheets>
            </workbook>""".trimIndent()
        )
        zip.writeEntry(
            "xl/_rels/workbook.xml.rels",
            """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
            </Relationships>""".trimIndent()
        )
        val sheet = buildString {
            append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>")
            append("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>")
            rows.forEachIndexed { rowIndex, row ->
                append("<row r=\"${rowIndex + 1}\">")
                row.forEachIndexed { columnIndex, value ->
                    append("<c r=\"${columnName(columnIndex)}${rowIndex + 1}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">")
                    append(escapeXml(value))
                    append("</t></is></c>")
                }
                append("</row>")
            }
            append("</sheetData></worksheet>")
        }
        zip.writeEntry("xl/worksheets/sheet1.xml", sheet)
    }
    return output.toByteArray()
}

private fun ZipOutputStream.writeEntry(name: String, content: String) {
    putNextEntry(ZipEntry(name))
    write(content.toByteArray(StandardCharsets.UTF_8))
    closeEntry()
}

private fun columnName(index: Int): String {
    var value = index + 1
    return buildString {
        while (value > 0) {
            insert(0, ('A'.code + (value - 1) % 26).toChar())
            value = (value - 1) / 26
        }
    }
}

private fun escapeXml(value: String): String = value
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;")
