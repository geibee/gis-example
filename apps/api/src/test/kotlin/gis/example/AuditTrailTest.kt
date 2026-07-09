// AuditTrail (監査 diff) の純粋ロジック検証:
// - update は変更フィールドのみ、create は after 全体 (null 除く)、delete は before 全体
// - 機微フィールド名のマスク、サイズ上限超過の要約化、エントリ数上限
package gis.example

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AuditTrailTest {

    private fun detailOf(trail: AuditTrail): JsonObject =
        Json.parseToJsonElement(trail.detailJsonOrNull() ?: error("detail が null")).jsonObject

    private fun singleChange(trail: AuditTrail): JsonObject {
        val changes = detailOf(trail)["changes"]!!.jsonArray
        assertEquals(1, changes.size)
        return changes[0].jsonObject
    }

    @Test
    fun `記録がなければ detail は null`() {
        assertNull(AuditTrail().detailJsonOrNull())
    }

    @Test
    fun `update は変更のあったフィールドだけを before-after で記録する`() {
        val trail = AuditTrail()
        trail.recordUpdate(
            "land",
            "L-1",
            before = buildJsonObject {
                put("status", "調査中")
                put("memo", JsonNull)
                put("address", "変わらない住所")
            },
            after = buildJsonObject {
                put("status", "完了")
                put("memo", "追記")
                put("address", "変わらない住所")
            }
        )
        val change = singleChange(trail)
        assertEquals("land", change["entityType"]!!.jsonPrimitive.content)
        assertEquals("L-1", change["entityId"]!!.jsonPrimitive.content)
        assertEquals("update", change["operation"]!!.jsonPrimitive.content)
        val fields = change["fields"]!!.jsonObject
        assertEquals(setOf("memo", "status"), fields.keys, "変更のあったフィールドのみ")
        assertEquals("調査中", fields["status"]!!.jsonObject["before"]!!.jsonPrimitive.content)
        assertEquals("完了", fields["status"]!!.jsonObject["after"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, fields["memo"]!!.jsonObject["before"])
        assertEquals("追記", fields["memo"]!!.jsonObject["after"]!!.jsonPrimitive.content)
    }

    @Test
    fun `変更なしの update も fields 空のエントリとして記録される`() {
        val trail = AuditTrail()
        val row = buildJsonObject { put("status", "調査中") }
        trail.recordUpdate("land", "L-1", row, row)
        val change = singleChange(trail)
        assertEquals("update", change["operation"]!!.jsonPrimitive.content)
        assertTrue(change["fields"]!!.jsonObject.isEmpty(), "空 diff でも対象特定のためエントリは残す")
    }

    @Test
    fun `create は after 全体 (null は省略)、delete は before 全体になる`() {
        val createTrail = AuditTrail()
        createTrail.recordCreate(
            "party",
            "P-1",
            buildJsonObject {
                put("name", "銀座開発")
                put("memo", JsonNull)
            }
        )
        val createFields = singleChange(createTrail)["fields"]!!.jsonObject
        assertEquals(setOf("name"), createFields.keys, "null フィールドは create に載せない")
        assertEquals("銀座開発", createFields["name"]!!.jsonObject["after"]!!.jsonPrimitive.content)
        assertFalse("before" in createFields["name"]!!.jsonObject)

        val deleteTrail = AuditTrail()
        deleteTrail.recordDelete("party", "P-1", buildJsonObject { put("name", "銀座開発") })
        val deleteFields = singleChange(deleteTrail)["fields"]!!.jsonObject
        assertEquals("銀座開発", deleteFields["name"]!!.jsonObject["before"]!!.jsonPrimitive.content)
        assertFalse("after" in deleteFields["name"]!!.jsonObject)
    }

    @Test
    fun `機微フィールド名の値はマスクされる`() {
        val trail = AuditTrail()
        trail.recordUpdate(
            "user",
            "U-1",
            before = buildJsonObject { put("apiPassword", "old-secret-value") },
            after = buildJsonObject { put("apiPassword", "new-secret-value") }
        )
        val field = singleChange(trail)["fields"]!!.jsonObject["apiPassword"]!!.jsonObject
        assertEquals(AUDIT_MASKED_VALUE, field["before"]!!.jsonPrimitive.content)
        assertEquals(AUDIT_MASKED_VALUE, field["after"]!!.jsonPrimitive.content)
    }

    @Test
    fun `サイズ上限を超える値は 変更あり (サイズとハッシュ) の要約形になる`() {
        val huge = JsonPrimitive("x".repeat(AUDIT_MAX_VALUE_CHARS + 100))
        val summarized = sanitizeAuditValue("geometry", huge).jsonObject
        assertEquals(true, summarized["truncated"]!!.jsonPrimitive.content.toBoolean())
        assertTrue(summarized["sizeChars"]!!.jsonPrimitive.int > AUDIT_MAX_VALUE_CHARS)
        assertEquals(16, summarized["sha256"]!!.jsonPrimitive.content.length)

        val small = JsonPrimitive("小さい値")
        assertEquals(small, sanitizeAuditValue("geometry", small), "上限内の値はそのまま")
    }

    @Test
    fun `エントリ数の上限を超えた分は件数として記録される`() {
        val trail = AuditTrail()
        repeat(AUDIT_MAX_CHANGES + 5) { index ->
            trail.recordDelete("zone", "Z-$index", buildJsonObject { put("name", "z$index") })
        }
        val detail = detailOf(trail)
        assertEquals(AUDIT_MAX_CHANGES, detail["changes"]!!.jsonArray.size)
        assertEquals(5, detail["omittedChanges"]!!.jsonPrimitive.int)
    }
}
