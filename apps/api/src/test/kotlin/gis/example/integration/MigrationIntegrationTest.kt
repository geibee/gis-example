package gis.example.integration

import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

// Flyway マイグレーションの適用テスト (issue #12 の受け入れ条件):
// - クリーン DB への全適用: 履歴 (flyway_schema_history) が残り、再実行は no-op
// - 既存 DB (Flyway 導入前にテーブル作成済み) への導入: baseline され差分のみ適用される
// - 両経路が同一スキーマ (列・インデックス) に収束する
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class MigrationIntegrationTest {

    private fun rawConnection(): Connection =
        DriverManager.getConnection(IntegrationDb.url, IntegrationDb.user, IntegrationDb.password)

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    // 拡張・スキーマだけがある「空の DB」を作る (compose の initdb と同じ前提)
    private fun resetToEmptyDatabase(connection: Connection) {
        connection.createStatement().use { stmt ->
            stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
            stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
        }
        connection.createStatement().use { stmt ->
            stmt.execute(repoFile("infra/postgres/init.sql"))
        }
    }

    // スキーマの観測可能な形 (列定義とインデックス定義)。収束判定に使う
    private fun schemaSignature(connection: Connection): List<String> = buildList {
        connection.prepareStatement(
            """
            SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
            FROM information_schema.columns
            WHERE table_schema = 'app'
            ORDER BY table_name, column_name
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    add("column: ${rs.getString(1)}.${rs.getString(2)} ${rs.getString(3)} ${rs.getString(4)} ${rs.getString(5)}")
                }
            }
        }
        connection.prepareStatement(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'app' ORDER BY indexname"
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    add("index: ${rs.getString(1)} = ${rs.getString(2)}")
                }
            }
        }
    }

    // (version, type, success) の履歴。version が無い行 (schema 作成マーカ等) は除く
    private fun historyRows(connection: Connection): List<Triple<String, String, Boolean>> =
        connection.prepareStatement(
            """
            SELECT version, type, success
            FROM app.flyway_schema_history
            WHERE version IS NOT NULL
            ORDER BY installed_rank
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(Triple(rs.getString(1), rs.getString(2), rs.getBoolean(3)))
                    }
                }
            }
        }

    @Test
    fun `クリーン DB への全適用と既存 DB の baseline 導入が同一スキーマに収束する`() {
        rawConnection().use { connection ->
            // --- 経路 1: クリーン DB へ全マイグレーションを適用する
            resetToEmptyDatabase(connection)
            IntegrationDb.migrate()

            val cleanHistory = historyRows(connection)
            assertTrue(cleanHistory.all { it.third }, "全マイグレーションが成功しているはず: $cleanHistory")
            val cleanVersions = cleanHistory.filter { it.second == "SQL" }.map { it.first }
            assertTrue("1" in cleanVersions && "2" in cleanVersions, "V1/V2 が適用されるはず: $cleanVersions")
            val cleanSignature = schemaSignature(connection)
            assertTrue(cleanSignature.any { it.startsWith("column: zones.zone_layer_id") }, "テーブルが作られているはず")

            // --- 経路 2: Flyway 導入前の既存 DB (V1 相当のテーブルが履歴なしで存在する)
            resetToEmptyDatabase(connection)
            val v1Sql = this::class.java.getResource("/db/migration/V1__baseline.sql")?.readText()
                ?: fail("V1__baseline.sql がクラスパスにありません")
            connection.createStatement().use { stmt -> stmt.execute(v1Sql) }

            IntegrationDb.migrate()

            val baselinedHistory = historyRows(connection)
            assertTrue(baselinedHistory.all { it.third }, "baseline 導入が成功しているはず: $baselinedHistory")
            assertEquals(
                listOf("1"),
                baselinedHistory.filter { it.second == "BASELINE" }.map { it.first },
                "既存 DB は V1 を baseline として記録するはず"
            )
            val baselinedSqlVersions = baselinedHistory.filter { it.second == "SQL" }.map { it.first }
            assertEquals(
                cleanVersions.filter { it.toInt() > 1 },
                baselinedSqlVersions,
                "既存 DB には baseline より後の差分のみが適用されるはず"
            )

            // --- 受け入れ条件: 両経路のスキーマ (列・インデックス) が一致する
            assertEquals(cleanSignature, schemaSignature(connection))
        }
    }

    @Test
    fun `migrate の再実行は no-op で履歴が増えない`() {
        rawConnection().use { connection ->
            resetToEmptyDatabase(connection)
            IntegrationDb.migrate()
            val first = historyRows(connection)

            IntegrationDb.migrate()
            assertEquals(first, historyRows(connection), "適用済み DB への再実行は履歴を変えないはず")
        }
    }
}
