// Database 本体: HikariCP 接続プールの生成・破棄と projects 系クエリ、
// および分割された各クエリファイルが共有するトップレベル宣言 (databaseJson など) を持つ
package gis.example

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.serialization.json.Json

data class LandListQuery(
    val projectId: String?,
    val q: String?,
    val status: String?,
    val landUse: String?,
    val partyType: String?,
    val relationType: String?,
    val linkedOnly: Boolean,
    val sourceLayerId: String?,
    val bbox: String?,
    val intersectsLayerId: String?,
    val intersectsFeatureId: String?,
    val distanceMeters: Double?
)

data class BuildingListQuery(
    val projectId: String?,
    val q: String?,
    val landId: String?,
    val status: String?,
    val buildingUse: String?,
    val partyType: String?,
    val relationType: String?,
    val linkedOnly: Boolean,
    val sourceLayerId: String?,
    val bbox: String?,
    val intersectsLayerId: String?,
    val intersectsFeatureId: String?,
    val distanceMeters: Double?
)

data class PartyListQuery(
    val projectId: String?,
    val q: String?,
    val partyType: String?,
    val relationType: String?,
    val linkedOnly: Boolean,
    val targetType: String?
)

data class ZoneListQuery(
    val projectId: String?,
    val q: String?,
    val status: String?,
    val zoneType: String?,
    val linkedOnly: Boolean,
    val zoneLayerId: String?,
    val sourceLayerId: String?
)

internal const val SOURCE_ZONE_BUFFER_METERS = 1000.0

internal val databaseJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}

internal val databaseLogger = org.slf4j.LoggerFactory.getLogger(Database::class.java)

// 生成系 (分析ジョブ・区域レイヤ生成) は重い空間演算を含むため、
// セッション既定の statement_timeout とは別の上限を使う (0 は無制限)
internal val heavyStatementTimeoutMillis: Long =
    (System.getenv("HEAVY_STATEMENT_TIMEOUT_MS") ?: "0").toLong()

// トランザクション内でのみ有効 (SET LOCAL)。値は toLong 済みの数値のみ埋め込む
internal fun setLocalStatementTimeout(connection: java.sql.Connection, timeoutMillis: Long) {
    connection.createStatement().use { it.execute("SET LOCAL statement_timeout = $timeoutMillis") }
}

class Database(internal val dataSource: HikariDataSource) : AutoCloseable {
    companion object {
        fun fromEnv(): Database {
            // 既定パスワードへのフォールバックはしない (本番で弱い資格情報のまま起動させない)
            val databasePassword = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD")
                ?: error("DATABASE_PASSWORD (または PGPASSWORD) が未設定です")
            val config = HikariConfig().apply {
                jdbcUrl = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
                username = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
                password = databasePassword
                maximumPoolSize = (System.getenv("DATABASE_POOL_SIZE") ?: "10").toInt()
                poolName = "web-gis-api"
                connectionTimeout = (System.getenv("DATABASE_CONNECTION_TIMEOUT_MS") ?: "10000").toLong()
                // DB/LB 側のアイドル切断より短くしてコネクションを入れ替える
                maxLifetime = (System.getenv("DATABASE_MAX_LIFETIME_MS") ?: "1500000").toLong()
                leakDetectionThreshold = (System.getenv("DATABASE_LEAK_DETECTION_MS") ?: "60000").toLong()
                // 暴走クエリでプールが枯渇しないようセッション既定の statement_timeout を設定する。
                // 重い生成系処理はトランザクション内で SET LOCAL により HEAVY_STATEMENT_TIMEOUT_MS へ差し替える
                connectionInitSql =
                    "SET statement_timeout = ${(System.getenv("DATABASE_STATEMENT_TIMEOUT_MS") ?: "30000").toLong()}"
            }
            return Database(HikariDataSource(config))
        }
    }

    override fun close() {
        dataSource.close()
    }

    fun listProjects(): List<ProjectDto> = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT id::text, name, created_at::text
            FROM app.projects
            ORDER BY created_at
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            ProjectDto(
                                id = rs.getString("id"),
                                name = rs.getString("name"),
                                createdAt = rs.getString("created_at")
                            )
                        )
                    }
                }
            }
        }
    }

    fun defaultProjectId(): String = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT id::text
            FROM app.projects
            ORDER BY created_at
            LIMIT 1
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                if (!rs.next()) {
                    throw ApiException(io.ktor.http.HttpStatusCode.InternalServerError, "No project exists")
                }
                rs.getString(1)
            }
        }
    }

    fun projectExists(projectId: String): Boolean = dataSource.connection.use { connection ->
        connection.prepareStatement("SELECT 1 FROM app.projects WHERE id = ?::uuid").use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { it.next() }
        }
    }
}

fun quoteIdent(value: String): String {
    require(value.isNotBlank()) { "Identifier must not be blank" }
    return "\"" + value.replace("\"", "\"\"") + "\""
}

data class ClaimedAnalysisJob(
    val id: String,
    val projectId: String,
    val name: String,
    val criteriaJson: String
)
