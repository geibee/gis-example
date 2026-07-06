package gis.example

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

// SQL 識別子クォートの Level 1 (決定的) テスト。
// 動的 SQL 全体のインジェクション境界はこの関数に依存している
class QuoteIdentTest {
    @Test
    fun `通常の識別子をダブルクォートで囲む`() {
        assertEquals("\"geom\"", quoteIdent("geom"))
    }

    @Test
    fun `識別子内のダブルクォートをエスケープする`() {
        assertEquals(
            "\"x\"\"; DROP TABLE app.layers; --\"",
            quoteIdent("x\"; DROP TABLE app.layers; --")
        )
    }

    @Test
    fun `日本語識別子をそのまま扱える`() {
        assertEquals("\"区域名\"", quoteIdent("区域名"))
    }

    @Test
    fun `空白のみの識別子を拒否する`() {
        assertFailsWith<IllegalArgumentException> { quoteIdent("  ") }
    }
}
