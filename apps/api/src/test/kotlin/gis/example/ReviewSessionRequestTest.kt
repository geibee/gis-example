package gis.example

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

// レビューセッションのリクエスト検証 (DB 不要の純粋ロジック)。
// 「今回何を見てもらうか」を決める入力なので、曖昧な値を黙って受け入れないことを固定する
class ReviewSessionRequestTest {

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text) as JsonObject

    @Test
    fun `観点は code と status を持ち guidance は任意`() {
        val inputs = readPerspectiveInputs(
            json(
                """
                {"perspectives": [
                  {"code": "BUSINESS_FLOW", "status": "ACTIVE"},
                  {"code": "UI_DESIGN", "status": "FUTURE", "guidance": "次回のデザインレビューで確認します"}
                ]}
                """.trimIndent()
            )
        )

        assertEquals(2, inputs.size)
        assertEquals(ReviewPerspectiveInput("BUSINESS_FLOW", "ACTIVE", null), inputs[0])
        assertEquals(
            ReviewPerspectiveInput("UI_DESIGN", "FUTURE", "次回のデザインレビューで確認します"),
            inputs[1]
        )
    }

    @Test
    fun `観点の status は ACTIVE FUTURE OUT_OF_SCOPE のみ受け付ける`() {
        val exc = assertFailsWith<ApiException> {
            readPerspectiveInputs(json("""{"perspectives": [{"code": "BUSINESS_FLOW", "status": "active"}]}"""))
        }

        assertEquals(io.ktor.http.HttpStatusCode.BadRequest, exc.status)
        assertTrue("OUT_OF_SCOPE" in exc.message, "許容値をメッセージに含める: ${exc.message}")
    }

    @Test
    fun `同じ観点を二重に指定した作成は拒否する`() {
        val exc = assertFailsWith<ApiException> {
            readPerspectiveInputs(
                json(
                    """
                    {"perspectives": [
                      {"code": "BUSINESS_FLOW", "status": "ACTIVE"},
                      {"code": "BUSINESS_FLOW", "status": "FUTURE"}
                    ]}
                    """.trimIndent()
                )
            )
        }

        assertTrue("BUSINESS_FLOW" in exc.message, exc.message)
    }

    @Test
    fun `perspectives キーが無ければ空リスト (全置換の対象外)`() {
        assertEquals(emptyList(), readPerspectiveInputs(json("""{"title": "第1回レビュー"}""")))
    }

    @Test
    fun `対象画面の reviewable は既定 true で明示的な false を保持する`() {
        val inputs = readScopeInputs(
            json(
                """
                {"scopes": [
                  {"pageId": "/lands", "description": "案件一覧"},
                  {"pageId": "/admin", "reviewable": false}
                ]}
                """.trimIndent()
            )
        )

        assertEquals(ReviewScopeInput("/lands", "案件一覧", true), inputs[0])
        assertEquals(ReviewScopeInput("/admin", null, false), inputs[1])
    }

    @Test
    fun `同じ画面を二重に指定した作成は拒否する`() {
        val exc = assertFailsWith<ApiException> {
            readScopeInputs(json("""{"scopes": [{"pageId": "/lands"}, {"pageId": "/lands"}]}"""))
        }

        assertTrue("/lands" in exc.message, exc.message)
    }

    @Test
    fun `セッションの status は draft open closed のみ受け付ける`() {
        assertEquals("open", readReviewSessionStatus(json("""{"status": "open"}""")))
        assertNull(readReviewSessionStatus(json("""{"title": "第1回レビュー"}""")))
        assertFailsWith<ApiException> { readReviewSessionStatus(json("""{"status": "OPEN"}""")) }
    }

    @Test
    fun `レビュー期間の終了が開始より前なら拒否する`() {
        requireValidPeriod("2026-08-10T09:00:00+09:00", "2026-08-20T18:00:00+09:00")
        requireValidPeriod("2026-08-10T09:00:00+09:00", null)
        requireValidPeriod(null, null)

        val exc = assertFailsWith<ApiException> {
            requireValidPeriod("2026-08-20T09:00:00+09:00", "2026-08-10T09:00:00+09:00")
        }
        assertEquals(io.ktor.http.HttpStatusCode.BadRequest, exc.status)
    }

    @Test
    fun `期間はオフセットのない日時を受け付けない (ローカル時刻の解釈揺れを持ち込まない)`() {
        assertEquals(
            "2026-08-10T09:00:00+09:00",
            readOptionalTimestamp(json("""{"startAt": "2026-08-10T09:00:00+09:00"}"""), "startAt")
        )
        assertFailsWith<ApiException> {
            readOptionalTimestamp(json("""{"startAt": "2026-08-10 09:00:00"}"""), "startAt")
        }
        assertFailsWith<ApiException> {
            readOptionalTimestamp(json("""{"startAt": "2026-08-10"}"""), "startAt")
        }
    }
}
