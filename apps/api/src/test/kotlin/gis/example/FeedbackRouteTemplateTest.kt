package gis.example

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FeedbackRouteTemplateTest {
    @Test
    fun `IDごとの実URLをルートテンプレートへ照合する`() {
        assertTrue(reviewRouteTemplateMatches("/zones/{id}", "/zones/Z-2"))
        assertTrue(reviewRouteTemplateMatches("/projects/{projectId}/lands/{id}", "/projects/p1/lands/L-1"))
        assertTrue(reviewRouteTemplateMatches("/zones/{id}", "/zones/Z-2?tab=history"))
    }

    @Test
    fun `異なる階層と空パラメータは照合しない`() {
        assertFalse(reviewRouteTemplateMatches("/zones/{id}", "/zones"))
        assertFalse(reviewRouteTemplateMatches("/zones/{id}", "/zones/Z-2/history"))
        assertFalse(reviewRouteTemplateMatches("/zones/{id}/history", "/zones/Z-2"))
    }
}
