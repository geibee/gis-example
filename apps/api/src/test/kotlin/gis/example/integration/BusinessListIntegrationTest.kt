package gis.example.integration

import gis.example.BuildingListQuery
import gis.example.Database
import gis.example.LandListQuery
import gis.example.PartyListQuery
import gis.example.ZoneListQuery
import gis.example.getBuilding
import gis.example.getLand
import gis.example.getParty
import gis.example.getZone
import gis.example.listBuildings
import gis.example.listLands
import gis.example.listParties
import gis.example.listZones
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
import kotlin.test.fail

// 一覧 API (lands / buildings / parties / zones) のページネーションと
// 一括取得 (N+1 解消) が単体取得と同じ結果を返すことを PostGIS 実体で検証する
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class BusinessListIntegrationTest {

    private val projectId = "00000000-0000-0000-0000-000000000000"
    private val parcelsLayerId = "11111111-1111-1111-1111-111111111111"

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
            // init.sql は拡張・スキーマ作成のみ。テーブル定義は Flyway (db/migration) が適用する
            IntegrationDb.migrate()
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
            // 一覧検証用の追加データ。it_parcels の P1/P2/P3 に土地・建物・区域を紐づける
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.lands (id, project_id, lot_number, address, land_use, status, source_layer_id, source_feature_id)
                    VALUES
                      ('L-IT-2', '$projectId', '2-2-2', '中央区テスト2丁目', '宅地', '調査中', '$parcelsLayerId', '2'),
                      ('L-IT-3', '$projectId', '3-3-3', '中央区テスト3丁目', '商業地', '取得済', '$parcelsLayerId', '3'),
                      ('L-IT-9', '$projectId', '9-9-9', '中央区テスト9丁目', NULL, '調査中', NULL, NULL);

                    INSERT INTO app.buildings (id, project_id, land_id, name, status, source_layer_id, source_feature_id)
                    VALUES
                      ('B-IT-1', '$projectId', 'L-IT-1', 'テストビルA', '調査中', '$parcelsLayerId', '1'),
                      ('B-IT-2', '$projectId', NULL, 'テストビルB', '調査中', '$parcelsLayerId', '3');

                    INSERT INTO app.parties (id, project_id, name, party_type, tags)
                    VALUES ('P-IT-2', '$projectId', 'テスト管理株式会社', '法人', '{管理}');

                    INSERT INTO app.party_relationships (project_id, party_id, target_type, target_id, relation_type)
                    VALUES
                      ('$projectId', 'P-IT-2', 'building', 'B-IT-1', '管理会社'),
                      ('$projectId', 'P-IT-2', 'land', 'L-IT-2', '所有者');

                    INSERT INTO app.zones (id, project_id, name, zone_type, status, zone_layer_id, zone_feature_id, source_layer_id, source_feature_id)
                    VALUES
                      ('Z-IT-1', '$projectId', '区域1', '検討', '有効', '$parcelsLayerId', '1', '$parcelsLayerId', '1'),
                      ('Z-IT-2', '$projectId', '区域2', NULL, '有効', '$parcelsLayerId', '2', '$parcelsLayerId', '2'),
                      ('Z-IT-3', '$projectId', '区域3', NULL, '有効', '$parcelsLayerId', '3', '$parcelsLayerId', '3');
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

    private fun landQuery(limit: Int? = null, offset: Int = 0) = LandListQuery(
        projectId = projectId, q = null, status = null, landUse = null,
        partyType = null, relationType = null, linkedOnly = false,
        sourceLayerId = null, bbox = null, intersectsLayerId = null,
        intersectsFeatureId = null, distanceMeters = null, limit = limit, offset = offset
    )

    // ---------------------------------------------------------- ページネーション

    @Test
    fun `lands の limit と offset はページを切り出し totalCount は全件のまま`() {
        val all = db.listLands(landQuery())
        assertEquals(4, all.totalCount, "土地は L-IT-1,2,3,9 の 4 件")
        assertEquals(listOf("L-IT-1", "L-IT-2", "L-IT-3", "L-IT-9"), all.items.map { it.id })

        val firstPage = db.listLands(landQuery(limit = 2))
        assertEquals(4, firstPage.totalCount, "limit 適用後も総件数は変わらない")
        assertEquals(all.items.take(2), firstPage.items)

        val secondPage = db.listLands(landQuery(limit = 2, offset = 2))
        assertEquals(4, secondPage.totalCount)
        assertEquals(all.items.drop(2), secondPage.items)
    }

    @Test
    fun `zones の一覧はページネーションでも総件数を保つ`() {
        val page = db.listZones(
            ZoneListQuery(
                projectId = projectId, q = null, status = null, zoneType = null,
                linkedOnly = false, zoneLayerId = null, sourceLayerId = null,
                limit = 1, offset = 1
            )
        )
        assertEquals(3, page.totalCount, "区域は Z-IT-1..3 の 3 件")
        assertEquals(listOf("Z-IT-2"), page.items.map { it.id })
    }

    // ---------------------------------------------------------- 一括取得と単体取得の等価性

    @Test
    fun `lands 一覧の一括取得 (建物リンクと関係者) は単体取得と一致する`() {
        val listed = db.listLands(landQuery()).items
        for (land in listed) {
            val single = assertNotNull(db.getLand(land.id), "getLand(${land.id})")
            assertEquals(single.buildings, land.buildings, "land=${land.id} の建物リンク")
            assertEquals(single.relationships, land.relationships, "land=${land.id} の関係者")
        }
    }

    @Test
    fun `buildings 一覧の一括取得は単体取得と一致する`() {
        val listed = db.listBuildings(
            BuildingListQuery(
                projectId = projectId, q = null, landId = null, status = null,
                buildingUse = null, partyType = null, relationType = null,
                linkedOnly = false, sourceLayerId = null, bbox = null,
                intersectsLayerId = null, intersectsFeatureId = null, distanceMeters = null
            )
        ).items
        assertEquals(listOf("B-IT-1", "B-IT-2"), listed.map { it.id })
        for (building in listed) {
            val single = assertNotNull(db.getBuilding(building.id), "getBuilding(${building.id})")
            assertEquals(single.relationships, building.relationships, "building=${building.id} の関係者")
        }
    }

    @Test
    fun `parties 一覧の一括取得は単体取得と一致する`() {
        val listed = db.listParties(
            PartyListQuery(
                projectId = projectId, q = null, partyType = null,
                relationType = null, linkedOnly = false, targetType = null
            )
        ).items
        assertEquals(listOf("P-IT-1", "P-IT-2"), listed.map { it.id })
        for (party in listed) {
            val single = assertNotNull(db.getParty(party.id), "getParty(${party.id})")
            assertEquals(single.relationships, party.relationships, "party=${party.id} の関係")
        }
    }

    // ---------------------------------------------------------- 区域件数の一括カウント

    @Test
    fun `zones 一覧の一括カウントは単体取得の空間検索結果と一致する`() {
        val listed = db.listZones(
            ZoneListQuery(
                projectId = projectId, q = null, status = null, zoneType = null,
                linkedOnly = false, zoneLayerId = null, sourceLayerId = null
            )
        ).items
        assertEquals(listOf("Z-IT-1", "Z-IT-2", "Z-IT-3"), listed.map { it.id })

        // P1 は土地 L-IT-1 + 建物 B-IT-1、P2 は L-IT-2 のみ、P3 は L-IT-3 + B-IT-2
        val expected = mapOf(
            "Z-IT-1" to (1 to 1),
            "Z-IT-2" to (1 to 0),
            "Z-IT-3" to (1 to 1)
        )
        for (zone in listed) {
            val (landCount, buildingCount) = assertNotNull(expected[zone.id])
            assertEquals(landCount, zone.landCount, "zone=${zone.id} の土地件数")
            assertEquals(buildingCount, zone.buildingCount, "zone=${zone.id} の建物件数")

            // 単体取得 (従来の空間検索パス) と同じ件数になることを相互検証する
            val single = assertNotNull(db.getZone(zone.id), "getZone(${zone.id})")
            assertEquals(single.landCount, zone.landCount, "zone=${zone.id} 一覧と詳細の土地件数")
            assertEquals(single.buildingCount, zone.buildingCount, "zone=${zone.id} 一覧と詳細の建物件数")
        }
    }
}
