package gis.example.integration

import gis.example.AuditTrail
import gis.example.BusinessEntityImportRequest
import gis.example.Database
import gis.example.getBuilding
import gis.example.getLand
import gis.example.importBuildingsFromLayer
import gis.example.importLandsFromLayer
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

// worker が作成したレイヤを Kotlin 側で業務テーブルへ同期する境界を PostGIS 実体で検証する。
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class BusinessImportIntegrationTest {
    private val projectId = "00000000-0000-0000-0000-000000000000"
    private val layerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val pointLayerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private lateinit var db: Database

    private fun rawConnection(): Connection =
        DriverManager.getConnection(IntegrationDb.url, IntegrationDb.user, IntegrationDb.password)

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
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
            IntegrationDb.migrate()
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    CREATE TABLE gis_data.business_import_source (
                        fid bigint PRIMARY KEY,
                        parcel_no text,
                        landuse text,
                        area_m2 double precision,
                        building_id text,
                        floors integer,
                        usage text,
                        geom geometry(Geometry, 3857)
                    );
                    INSERT INTO gis_data.business_import_source VALUES
                      (1, 'A-001', 'residential', 1200, 'B-001', 4, 'house',
                       ST_GeomFromText('POLYGON((0 0,100 0,100 100,0 100,0 0))', 3857)),
                      (2, 'A-002', 'commercial', 900, 'B-002', 9, 'office',
                       ST_GeomFromText('POINT(200 200)', 3857));

                    CREATE TABLE gis_data.business_import_points AS
                    SELECT fid, parcel_no, geom
                    FROM gis_data.business_import_source
                    WHERE GeometryType(geom) = 'POINT';

                    INSERT INTO app.layers (
                        id, project_id, name, table_name, geometry_type, source_srid,
                        row_count, tile_source_id
                    ) VALUES (
                        '$layerId', '$projectId', '業務取込元', 'business_import_source',
                        'GEOMETRY', 3857, 2, 'business_import_source'
                    ), (
                        '$pointLayerId', '$projectId', 'ポイント取込元', 'business_import_points',
                        'POINT', 3857, 1, 'business_import_points'
                    );
                    INSERT INTO app.layer_attributes (layer_id, name, data_type, ordinal_position, is_geometry)
                    SELECT '$layerId', column_name,
                           CASE WHEN udt_name = 'geometry' THEN 'geometry' ELSE data_type END,
                           ordinal_position, udt_name = 'geometry'
                    FROM information_schema.columns
                    WHERE table_schema = 'gis_data' AND table_name = 'business_import_source';

                    INSERT INTO app.layer_attributes (layer_id, name, data_type, ordinal_position, is_geometry)
                    SELECT '$pointLayerId', column_name,
                           CASE WHEN udt_name = 'geometry' THEN 'geometry' ELSE data_type END,
                           ordinal_position, udt_name = 'geometry'
                    FROM information_schema.columns
                    WHERE table_schema = 'gis_data' AND table_name = 'business_import_points';
                    """.trimIndent()
                )
            }
        }
        db = Database.fromEnv()
    }

    @AfterAll
    fun tearDown() {
        db.close()
    }

    @Test
    fun `ポリゴン属性を土地へ同期し再実行では更新になる`() {
        val request = BusinessEntityImportRequest(projectId = projectId, layerId = layerId)
        val first = db.importLandsFromLayer(request, AuditTrail())
        assertEquals(1, first.createdCount)
        assertEquals(0, first.updatedCount)
        assertEquals(1, first.skippedCount)

        val id = "L-${layerId.replace("-", "")}-1"
        val land = assertNotNull(db.getLand(id))
        assertEquals("A-001", land.lotNumber)
        assertEquals("A-001", land.address, "所在地が無い場合は地番を使う")
        assertEquals("residential", land.landUse)
        assertEquals(1200.0, land.areaSqm)
        assertEquals(layerId, land.sourceLayerId)
        assertEquals("1", land.sourceFeatureId)

        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("UPDATE app.lands SET status = '確認済' WHERE id = '$id'")
            }
        }
        val second = db.importLandsFromLayer(request, AuditTrail())
        assertEquals(0, second.createdCount)
        assertEquals(1, second.updatedCount)
        assertEquals(1, second.skippedCount)
        assertEquals("確認済", assertNotNull(db.getLand(id)).status, "属性に status が無い再取込では業務ステータスを保持する")
    }

    @Test
    fun `ポリゴン属性を建物へ同期する`() {
        val result = db.importBuildingsFromLayer(
            BusinessEntityImportRequest(projectId = projectId, layerId = layerId),
            AuditTrail()
        )
        assertEquals(1, result.createdCount)
        assertEquals(0, result.updatedCount)
        assertEquals(1, result.skippedCount)

        val id = "B-${layerId.replace("-", "")}-1"
        val building = assertNotNull(db.getBuilding(id))
        assertEquals("B-001", building.name)
        assertEquals(4, building.floors)
        assertEquals("house", building.buildingUse)
        assertEquals(layerId, building.sourceLayerId)
        assertEquals("1", building.sourceFeatureId)
        assertTrue(building.landId == null)
    }

    @Test
    fun `ポリゴンが無いレイヤは全件スキップとして返す`() {
        val result = db.importLandsFromLayer(
            BusinessEntityImportRequest(projectId = projectId, layerId = pointLayerId),
            AuditTrail()
        )
        assertEquals(0, result.createdCount)
        assertEquals(0, result.updatedCount)
        assertEquals(1, result.skippedCount)
    }
}
