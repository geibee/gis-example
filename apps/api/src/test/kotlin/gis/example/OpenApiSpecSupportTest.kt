// OpenApiSpecSupport (契約テスト用の薄いスキーマ検証) 自体の健全性テスト。
// バリデータが「何も検査せず常に適合」に退化すると契約テストが空洞化するため、
// 違反を実際に検出できることを openapi.yaml の実スキーマ (Error / Layer) で確認する
package gis.example

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertTrue

class OpenApiSpecSupportTest {

    private fun errorSchema() = OpenApiSpecSupport.responseSchema("get", "/api/lands", 400)

    @Test
    fun `適合する JSON は違反なしになる`() {
        val violations = OpenApiSpecSupport.validate(
            Json.parseToJsonElement("""{"error": "bad request"}"""),
            errorSchema()
        )
        assertTrue(violations.isEmpty(), "違反なしのはずが: $violations")
    }

    @Test
    fun `必須フィールドの欠落を検出する`() {
        val violations = OpenApiSpecSupport.validate(Json.parseToJsonElement("""{}"""), errorSchema())
        assertTrue(violations.any { "error" in it }, "必須 'error' の欠落を検出する: $violations")
    }

    @Test
    fun `型違反を検出する`() {
        val violations = OpenApiSpecSupport.validate(
            Json.parseToJsonElement("""{"error": 123}"""),
            errorSchema()
        )
        assertTrue(violations.isNotEmpty(), "error は string 型でなければならない: $violations")
    }

    @Test
    fun `$ref 先 (配列 items) の違反を検出する`() {
        // GET /api/layers の 200 は Layer 配列。必須フィールドをほぼ欠いた要素は違反になる
        val schema = OpenApiSpecSupport.responseSchema("get", "/api/layers", 200)
        val violations = OpenApiSpecSupport.validate(
            Json.parseToJsonElement("""[{"id": "x"}]"""),
            schema
        )
        assertTrue(violations.any { "projectId" in it }, "Layer の必須フィールド欠落を検出する: $violations")
    }
}
