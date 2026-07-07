package gis.example

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

// createAnalysisJob が app.analysis_jobs.criteria に保存する JSON を
// executeClaimedAnalysisJob が読み戻すラウンドトリップの契約テスト
class AnalysisJobCriteriaTest {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    @Test
    fun `condition_search の criteria がラウンドトリップする`() {
        val request = AnalysisJobRequest(
            projectId = "00000000-0000-0000-0000-000000000000",
            name = "条件検索テスト",
            operation = "condition_search",
            conditionQuery = ConditionQueryDto(
                projectId = "00000000-0000-0000-0000-000000000000",
                targetLayerIds = listOf("11111111-1111-1111-1111-111111111111"),
                keyword = "商業",
                conditions = listOf(
                    ConditionQueryConditionDto(
                        type = "spatial",
                        comparisonTarget = "business",
                        spatialOperator = "dwithin",
                        distanceMeters = 50.0
                    )
                ),
                limit = 100
            )
        )
        val decoded = json.decodeFromString<AnalysisJobRequest>(json.encodeToString(request))
        assertEquals(request, decoded)
    }

    @Test
    fun `未知のキーを含む criteria も読める`() {
        // 将来フィールドが増えた旧ジョブが残っていても executor が落ちないこと
        val decoded = json.decodeFromString<AnalysisJobRequest>(
            """{"operation":"and_filter","targetLayerId":"abc","futureField":123}"""
        )
        assertEquals("and_filter", decoded.operation)
        assertNotNull(decoded.targetLayerId)
    }
}
