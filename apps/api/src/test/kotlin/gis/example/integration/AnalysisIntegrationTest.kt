package gis.example.integration

import gis.example.AnalysisJobRequest
import gis.example.ConditionQueryConditionDto
import gis.example.ConditionQueryDto
import gis.example.Database
import gis.example.claimPendingAnalysisJob
import gis.example.conditionSearchFeatures
import gis.example.createAnalysisJob
import gis.example.executeClaimedAnalysisJob
import gis.example.getAnalysisJob
import gis.example.getLayer
import gis.example.getMvtTile
import gis.example.validateAnalysisRequest
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

// PostGIS 実体に対する統合テスト (gradle integrationTest で実行)。
// fail-closed: DATABASE_URL 未設定や DB 未起動ならスキップではなく失敗する
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AnalysisIntegrationTest {

    private val projectId = "00000000-0000-0000-0000-000000000000"
    private val parcelsLayerId = "11111111-1111-1111-1111-111111111111"
    private val pointsLayerId = "22222222-2222-2222-2222-222222222222"
    private val adjacentLayerId = "33333333-3333-3333-3333-333333333333"

    private lateinit var db: Database

    private fun rawConnection(): Connection {
        val url = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
        val user = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
        val password = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"
        return DriverManager.getConnection(url, user, password)
    }

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    @BeforeAll
    fun setUpSchema() {
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
                stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
            }
            connection.createStatement().use { stmt ->
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
        }
        db = Database.fromEnv()
    }

    @AfterAll
    fun tearDown() {
        db.close()
    }

    private fun conditionQuery(vararg conditions: ConditionQueryConditionDto, keyword: String? = null) =
        ConditionQueryDto(
            projectId = projectId,
            targetLayerIds = listOf(parcelsLayerId),
            keyword = keyword,
            conditions = conditions.toList(),
            limit = 100
        )

    private fun previewFeatureIds(query: ConditionQueryDto): List<String> =
        db.conditionSearchFeatures(query).map { it.featureId }.sorted()

    // 分析ジョブを同期実行して完了状態を返す (ポーラーを介さず直接 claim / execute する)
    private fun runAnalysisJob(request: AnalysisJobRequest): gis.example.AnalysisJobDto {
        validateAnalysisRequest(db, request)
        val created = db.createAnalysisJob(request)
        var executed = false
        while (true) {
            val claimed = db.claimPendingAnalysisJob() ?: break
            db.executeClaimedAnalysisJob(claimed)
            if (claimed.id == created.id) executed = true
        }
        assertTrue(executed, "作成したジョブが claim されませんでした")
        return assertNotNull(db.getAnalysisJob(created.id))
    }

    // ---------------------------------------------------------- 空間演算子の境界ケース

    @Test
    fun `intersects は辺で接するだけのポリゴンも一致とみなす`() {
        val ids = previewFeatureIds(
            conditionQuery(
                ConditionQueryConditionDto(type = "spatial", layerId = adjacentLayerId, spatialOperator = "intersects")
            )
        )
        // P1 は it_adjacent と辺 x=100 を共有 (touch)。P2 は東辺 x=200 で接する。P3 は孤立
        assertEquals(listOf("1", "2"), ids)
    }

    @Test
    fun `dwithin は距離ちょうどを含み わずかに小さい距離では外れる`() {
        // 駅C は P1 の東辺からちょうど 50m
        val at50 = previewFeatureIds(
            conditionQuery(
                ConditionQueryConditionDto(
                    type = "spatial", layerId = pointsLayerId,
                    spatialOperator = "dwithin", distanceMeters = 50.0
                )
            )
        )
        assertTrue("1" in at50, "距離ちょうど 50m の駅C が P1 にヒットするはず")

        val at49 = previewFeatureIds(
            conditionQuery(
                ConditionQueryConditionDto(
                    type = "spatial", layerId = pointsLayerId,
                    spatialOperator = "dwithin", distanceMeters = 49.999
                )
            )
        )
        // P1 内部の駅A で依然ヒットするため、P3 が外れていることで判定する
        assertTrue("3" !in at49, "49.999m で孤立ポリゴン P3 がヒットしてはいけない")
    }

    @Test
    fun `contains は内部の点を持つポリゴンだけを返す`() {
        val ids = previewFeatureIds(
            conditionQuery(
                ConditionQueryConditionDto(type = "spatial", layerId = pointsLayerId, spatialOperator = "contains")
            )
        )
        // 駅A∈P1, 駅B∈P2。駅C (P1 の外) はどのポリゴンにも含まれない
        assertEquals(listOf("1", "2"), ids)
    }

    // ---------------------------------------------------------- プレビューと分析ジョブの一致

    @Test
    fun `プレビューと condition_search 分析ジョブが同じ集合を返す`() {
        val query = conditionQuery(
            ConditionQueryConditionDto(type = "attribute", field = "zoning_name", operator = "LIKE", value = kotlinx.serialization.json.JsonPrimitive("商業")),
            ConditionQueryConditionDto(type = "spatial", layerId = pointsLayerId, spatialOperator = "intersects"),
            ConditionQueryConditionDto(type = "business", sourceTypes = listOf("land"), partyQuery = "銀座開発", relationType = "売買事業者")
        )
        val previewIds = previewFeatureIds(query)
        assertEquals(listOf("1"), previewIds, "属性+空間+業務の複合条件で P1 だけに絞られるはず")

        val job = runAnalysisJob(
            AnalysisJobRequest(projectId = projectId, name = "一致検証", operation = "condition_search", conditionQuery = query)
        )
        assertEquals("succeeded", job.status, "error: ${job.errorMessage}")
        assertEquals(previewIds.size.toLong(), job.resultCount)

        val resultLayerId = assertNotNull(job.resultLayerId)
        val layer = assertNotNull(db.getLayer(resultLayerId))
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.executeQuery(
                    "SELECT array_agg(source_feature_id ORDER BY source_feature_id) FROM gis_data.\"${layer.tableName}\""
                ).use { rs ->
                    rs.next()
                    @Suppress("UNCHECKED_CAST")
                    val ids = (rs.getArray(1).array as Array<String>).toList()
                    assertEquals(previewIds, ids, "実体化された feature 集合がプレビューと一致するはず")
                }
            }
        }
    }

    // ---------------------------------------------------------- 結果レイヤの契約とタイル配信

    @Test
    fun `結果レイヤはレイヤ契約を満たし MVT を配信できる`() {
        val job = runAnalysisJob(
            AnalysisJobRequest(
                projectId = projectId, name = "契約検証", operation = "condition_search",
                conditionQuery = conditionQuery(
                    ConditionQueryConditionDto(type = "attribute", field = "zoning_name", operator = "=", value = kotlinx.serialization.json.JsonPrimitive("商業地域"))
                )
            )
        )
        assertEquals("succeeded", job.status, "error: ${job.errorMessage}")
        val layer = assertNotNull(db.getLayer(assertNotNull(job.resultLayerId)))

        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                // レイヤ契約: SRID=3857, 全ジオメトリ valid, GiST インデックスあり, 属性登録済み
                stmt.executeQuery(
                    """
                    SELECT
                        bool_and(ST_SRID(geom) = 3857) AS srid_ok,
                        bool_and(ST_IsValid(geom)) AS valid_ok,
                        count(*) AS cnt
                    FROM gis_data."${layer.tableName}"
                    """.trimIndent()
                ).use { rs ->
                    rs.next()
                    assertTrue(rs.getBoolean("srid_ok"), "全ジオメトリが SRID 3857 であるべき")
                    assertTrue(rs.getBoolean("valid_ok"), "全ジオメトリが ST_IsValid であるべき")
                    assertEquals(2, rs.getLong("cnt"), "商業地域は P1 と P3 の 2 件")
                }
                stmt.executeQuery(
                    """
                    SELECT count(*) FROM pg_indexes
                    WHERE schemaname = 'gis_data' AND tablename = '${layer.tableName}' AND indexdef LIKE '%USING gist%'
                    """.trimIndent()
                ).use { rs ->
                    rs.next()
                    assertTrue(rs.getInt(1) >= 1, "GiST インデックスが張られているべき")
                }
            }
        }
        assertTrue(layer.attributes.any { it.name == "zoning_name" }, "元レイヤの属性が引き継がれ登録されているべき")

        // タイル配信: ジオメトリを覆う z15 タイルは非空、遠方タイルは空
        val nearTile = db.getMvtTile(layer.id, 15, 16384, 16383)
        assertTrue(nearTile.isNotEmpty(), "対象範囲の z15 タイルは非空のはず")
        assertTrue(
            String(nearTile, Charsets.ISO_8859_1).contains(layer.tileSourceId),
            "MVT にレイヤ名 (tile_source_id) が含まれるはず"
        )
        val farTile = db.getMvtTile(layer.id, 15, 0, 0)
        assertTrue(farTile.isEmpty(), "対象範囲外のタイルは空のはず")
    }

    // ---------------------------------------------------------- 失敗系のトランザクション保証

    @Test
    fun `実行時エラーのジョブは failed になり孤児テーブルを残さない`() {
        val before = countGisDataTables()
        // 存在しない属性は createAnalysisJob の検証を通過し、実行時に失敗する
        val created = db.createAnalysisJob(
            AnalysisJobRequest(
                projectId = projectId, name = "失敗検証", operation = "condition_search",
                conditionQuery = conditionQuery(
                    ConditionQueryConditionDto(type = "attribute", field = "no_such_field", operator = "=", value = kotlinx.serialization.json.JsonPrimitive("x"))
                )
            )
        )
        while (true) {
            val claimed = db.claimPendingAnalysisJob() ?: break
            db.executeClaimedAnalysisJob(claimed)
        }
        val job = assertNotNull(db.getAnalysisJob(created.id))
        assertEquals("failed", job.status)
        assertTrue(assertNotNull(job.errorMessage).contains("no_such_field"))
        assertEquals(before, countGisDataTables(), "ロールバックにより結果テーブルが残らないはず")
    }

    private fun countGisDataTables(): Int = rawConnection().use { connection ->
        connection.createStatement().use { stmt ->
            stmt.executeQuery("SELECT count(*) FROM pg_tables WHERE schemaname = 'gis_data'").use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }
}
