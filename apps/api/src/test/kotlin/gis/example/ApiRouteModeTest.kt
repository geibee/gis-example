package gis.example

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ApiRouteModeTest {
    @Test
    fun `未指定とfullは通常APIになる`() {
        assertEquals(ApiRouteMode.FULL, parseApiRouteMode(null))
        assertEquals(ApiRouteMode.FULL, parseApiRouteMode(" full "))
    }

    @Test
    fun `review-sidecarだけを専用モードとして受け付ける`() {
        assertEquals(ApiRouteMode.REVIEW_SIDECAR, parseApiRouteMode("REVIEW-SIDECAR"))
        assertFailsWith<IllegalStateException> { parseApiRouteMode("proxy") }
    }
}
