package feedback.service

import java.nio.file.Path
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class FeedbackOpenApiSpecSupportTest {
    @Test
    fun `必須フィールド欠落と追加フィールドを拒否する`() {
        val schema = FeedbackOpenApiSpecSupport.responseSchema("get", "/capabilities", 200, "application/json")
        val invalid = buildJsonObject {
            put("apiVersion", "1.0")
            put("unexpected", true)
        }

        val violations = FeedbackOpenApiSpecSupport.validate(invalid, schema)

        assertTrue(violations.any { "必須フィールド" in it })
        assertTrue(violations.any { "未定義フィールド" in it })
    }

    @Test
    fun `未対応のJSON Schema keywordを黙って無視しない`() {
        val schema = FeedbackOpenApiSpecSupport.SchemaNode(
            definition = mapOf("type" to "object", "unevaluatedProperties" to false),
            document = emptyMap(),
            source = Path.of("schema.json")
        )

        assertFailsWith<IllegalArgumentException> {
            FeedbackOpenApiSpecSupport.validate(buildJsonObject {}, schema)
        }
    }
}
