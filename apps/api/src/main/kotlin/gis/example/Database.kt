package gis.example

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Types
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID

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

class Database(private val dataSource: HikariDataSource) : AutoCloseable {
    companion object {
        private const val SOURCE_ZONE_BUFFER_METERS = 1000.0

        private val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

        private val logger = org.slf4j.LoggerFactory.getLogger(Database::class.java)

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
            }
            return Database(HikariDataSource(config))
        }
    }

    private data class SqlFragment(
        val sql: String,
        val binders: List<(PreparedStatement, Int) -> Unit> = emptyList()
    )

    private data class FeatureSearchRow(
        val featureId: String,
        val properties: JsonObject,
        val geometry: JsonElement? = null,
        val matchedBusinessLinks: BusinessLinksDto
    )

    private data class DeletedLayerRef(
        val id: String,
        val schemaName: String,
        val tableName: String,
        val resultSetId: String?
    )

    private data class AnalysisJobOutcome(
        val resultLayerId: String?,
        val resultSetId: String?,
        val resultCount: Long
    )

    private data class ZoneLayerSyncCounts(
        val created: Int,
        val updated: Int
    )

    private data class LayerStats(
        val rowCount: Long,
        val geometryType: String,
        val bbox4326: String?
    )

    override fun close() {
        dataSource.close()
    }

    fun ensureBusinessSchema() {
        dataSource.connection.use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    CREATE EXTENSION IF NOT EXISTS pg_trgm;

                    CREATE TABLE IF NOT EXISTS app.lands (
                        id text PRIMARY KEY,
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        lot_number text NOT NULL,
                        address text NOT NULL,
                        land_use text,
                        area_sqm double precision,
                        registered_owner text,
                        right_type text,
                        registration_cause text,
                        registration_accepted_on date,
                        status text NOT NULL DEFAULT '調査中',
                        memo text,
                        source_layer_id uuid,
                        source_feature_id text,
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS app.buildings (
                        id text PRIMARY KEY,
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        land_id text REFERENCES app.lands(id) ON DELETE SET NULL,
                        name text NOT NULL,
                        building_location text,
                        house_number text,
                        building_use text,
                        floors integer,
                        total_floor_area_sqm double precision,
                        structure text,
                        registered_owner text,
                        right_type text,
                        registration_accepted_on date,
                        status text NOT NULL DEFAULT '調査中',
                        memo text,
                        source_layer_id uuid,
                        source_feature_id text,
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS app.parties (
                        id text PRIMARY KEY,
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        name text NOT NULL,
                        party_type text NOT NULL,
                        contact text,
                        address text,
                        memo text,
                        tags text[] NOT NULL DEFAULT '{}',
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS app.zones (
                        id text PRIMARY KEY,
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        name text NOT NULL,
                        zone_type text,
                        status text NOT NULL DEFAULT '有効',
                        memo text,
                        zone_layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE RESTRICT,
                        zone_feature_id text NOT NULL,
                        source_layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE RESTRICT,
                        source_feature_id text NOT NULL,
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now(),
                        UNIQUE (zone_layer_id, zone_feature_id)
                    );

                    CREATE TABLE IF NOT EXISTS app.party_relationships (
                        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        party_id text NOT NULL REFERENCES app.parties(id) ON DELETE CASCADE,
                        target_type text NOT NULL CHECK (target_type IN ('land', 'building')),
                        target_id text NOT NULL,
                        relation_type text NOT NULL,
                        note text,
                        created_at timestamptz NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS app.result_sets (
                        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        name text NOT NULL,
                        criteria jsonb NOT NULL,
                        created_at timestamptz NOT NULL DEFAULT now()
                    );

                    ALTER TABLE app.layers
                        ADD COLUMN IF NOT EXISTS result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL;
                    ALTER TABLE app.layers
                        ADD COLUMN IF NOT EXISTS source_layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL;
                    ALTER TABLE app.layers
                        ADD COLUMN IF NOT EXISTS layer_role text NOT NULL DEFAULT 'generic';
                    ALTER TABLE app.import_jobs
                        ADD COLUMN IF NOT EXISTS layer_role text NOT NULL DEFAULT 'generic';
                    ALTER TABLE app.analysis_jobs
                        ADD COLUMN IF NOT EXISTS result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL;
                    ALTER TABLE app.zones
                        ADD COLUMN IF NOT EXISTS zone_layer_id uuid REFERENCES app.layers(id) ON DELETE RESTRICT;
                    ALTER TABLE app.zones
                        ADD COLUMN IF NOT EXISTS zone_feature_id text;
                    UPDATE app.zones
                    SET zone_layer_id = COALESCE(zone_layer_id, source_layer_id),
                        zone_feature_id = COALESCE(zone_feature_id, source_feature_id)
                    WHERE zone_layer_id IS NULL OR zone_feature_id IS NULL;
                    ALTER TABLE app.zones
                        ALTER COLUMN zone_layer_id SET NOT NULL,
                        ALTER COLUMN zone_feature_id SET NOT NULL;
                    ALTER TABLE app.lands
                        ADD COLUMN IF NOT EXISTS registered_owner text,
                        ADD COLUMN IF NOT EXISTS right_type text,
                        ADD COLUMN IF NOT EXISTS registration_cause text,
                        ADD COLUMN IF NOT EXISTS registration_accepted_on date;
                    ALTER TABLE app.buildings
                        ADD COLUMN IF NOT EXISTS building_location text,
                        ADD COLUMN IF NOT EXISTS house_number text,
                        ADD COLUMN IF NOT EXISTS registered_owner text,
                        ADD COLUMN IF NOT EXISTS right_type text,
                        ADD COLUMN IF NOT EXISTS registration_accepted_on date;
                    ALTER TABLE app.parties
                        ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

                    CREATE INDEX IF NOT EXISTS lands_project_search_idx ON app.lands(project_id, id);
                    CREATE INDEX IF NOT EXISTS lands_source_feature_idx ON app.lands(source_layer_id, source_feature_id);
                    CREATE INDEX IF NOT EXISTS buildings_project_search_idx ON app.buildings(project_id, id);
                    CREATE INDEX IF NOT EXISTS buildings_land_idx ON app.buildings(land_id);
                    CREATE INDEX IF NOT EXISTS buildings_source_feature_idx ON app.buildings(source_layer_id, source_feature_id);
                    CREATE INDEX IF NOT EXISTS parties_project_search_idx ON app.parties(project_id, id);
                    CREATE INDEX IF NOT EXISTS zones_project_search_idx ON app.zones(project_id, id);
                    CREATE INDEX IF NOT EXISTS zones_source_feature_idx ON app.zones(source_layer_id, source_feature_id);
                    CREATE UNIQUE INDEX IF NOT EXISTS zones_zone_feature_unique_idx ON app.zones(zone_layer_id, zone_feature_id);
                    CREATE INDEX IF NOT EXISTS zones_zone_feature_idx ON app.zones(zone_layer_id, zone_feature_id);
                    CREATE INDEX IF NOT EXISTS party_relationships_party_idx ON app.party_relationships(party_id);
                    CREATE INDEX IF NOT EXISTS party_relationships_target_idx ON app.party_relationships(target_type, target_id);
                    CREATE INDEX IF NOT EXISTS result_sets_project_created_idx ON app.result_sets(project_id, created_at);
                    CREATE INDEX IF NOT EXISTS layers_result_set_idx ON app.layers(result_set_id, created_at);
                    CREATE INDEX IF NOT EXISTS layers_source_layer_idx ON app.layers(source_layer_id);
                    CREATE INDEX IF NOT EXISTS layers_role_idx ON app.layers(layer_role, project_id);
                    CREATE INDEX IF NOT EXISTS lands_search_text_trgm_idx ON app.lands USING gin (
                        lower(
                            coalesce(id, '') || ' ' ||
                            coalesce(lot_number, '') || ' ' ||
                            coalesce(address, '') || ' ' ||
                            coalesce(land_use, '') || ' ' ||
                            coalesce(status, '') || ' ' ||
                            coalesce(memo, '') || ' ' ||
                            coalesce(registered_owner, '') || ' ' ||
                            coalesce(right_type, '') || ' ' ||
                            coalesce(registration_cause, '')
                        ) gin_trgm_ops
                    );
                    CREATE INDEX IF NOT EXISTS buildings_search_text_trgm_idx ON app.buildings USING gin (
                        lower(
                            coalesce(id, '') || ' ' ||
                            coalesce(name, '') || ' ' ||
                            coalesce(building_location, '') || ' ' ||
                            coalesce(house_number, '') || ' ' ||
                            coalesce(building_use, '') || ' ' ||
                            coalesce(structure, '') || ' ' ||
                            coalesce(status, '') || ' ' ||
                            coalesce(memo, '') || ' ' ||
                            coalesce(registered_owner, '') || ' ' ||
                            coalesce(right_type, '')
                        ) gin_trgm_ops
                    );
                    CREATE INDEX IF NOT EXISTS parties_search_text_trgm_idx ON app.parties USING gin (
                        lower(
                            coalesce(id, '') || ' ' ||
                            coalesce(name, '') || ' ' ||
                            coalesce(party_type, '') || ' ' ||
                            coalesce(contact, '') || ' ' ||
                            coalesce(address, '') || ' ' ||
                            coalesce(memo, '')
                        ) gin_trgm_ops
                    );
                    CREATE INDEX IF NOT EXISTS zones_search_text_trgm_idx ON app.zones USING gin (
                        lower(
                            coalesce(id, '') || ' ' ||
                            coalesce(name, '') || ' ' ||
                            coalesce(zone_type, '') || ' ' ||
                            coalesce(status, '') || ' ' ||
                            coalesce(memo, '')
                        ) gin_trgm_ops
                    );

                    INSERT INTO app.projects (id, name)
                    VALUES ('00000000-0000-0000-0000-000000000000', 'Default project')
                    ON CONFLICT (id) DO NOTHING;
                    """.trimIndent()
                )
            }
        }
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

    fun createImportJob(
        projectId: String?,
        filename: String,
        format: String,
        sourceSrid: Int?,
        uploadPath: String,
        layerRole: String = "generic"
    ): ImportJobDto {
        val resolvedProjectId = projectId ?: defaultProjectId()
        val normalizedLayerRole = normalizeLayerRole(layerRole)
        return dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path, layer_role)
                VALUES (?::uuid, ?, ?, ?, ?, ?)
                RETURNING id::text
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, resolvedProjectId)
                stmt.setString(2, filename)
                stmt.setString(3, format)
                if (sourceSrid == null) stmt.setNull(4, java.sql.Types.INTEGER) else stmt.setInt(4, sourceSrid)
                stmt.setString(5, uploadPath)
                stmt.setString(6, normalizedLayerRole)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getImportJob(rs.getString(1)) ?: error("Created import job disappeared")
                }
            }
        }
    }

    fun getImportJob(id: String): ImportJobDto? = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT id::text, project_id::text, filename, format, source_srid, status,
                   error_message, layer_id::text, layer_role, created_at::text, started_at::text, finished_at::text
            FROM app.import_jobs
            WHERE id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toImportJobDto()
            }
        }
    }

    fun listLayers(projectId: String?): List<LayerDto> = dataSource.connection.use { connection ->
        val sql = if (projectId == null) {
            """
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.layer_role, l.result_set_id::text, rs.name AS result_set_name,
                   l.source_layer_id::text, l.tile_source_id, l.created_at::text
            FROM app.layers AS l
            LEFT JOIN app.result_sets AS rs ON rs.id = l.result_set_id
            ORDER BY l.created_at DESC
            """.trimIndent()
        } else {
            """
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.layer_role, l.result_set_id::text, rs.name AS result_set_name,
                   l.source_layer_id::text, l.tile_source_id, l.created_at::text
            FROM app.layers AS l
            LEFT JOIN app.result_sets AS rs ON rs.id = l.result_set_id
            WHERE l.project_id = ?::uuid
            ORDER BY l.created_at DESC
            """.trimIndent()
        }
        connection.prepareStatement(sql).use { stmt ->
            if (projectId != null) stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                val layers = buildList {
                    while (rs.next()) add(rs.toLayerDto(emptyList()))
                }
                withAttributes(connection, layers)
            }
        }
    }

    fun getLayer(id: String): LayerDto? = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.layer_role, l.result_set_id::text, rs.name AS result_set_name,
                   l.source_layer_id::text, l.tile_source_id, l.created_at::text
            FROM app.layers AS l
            LEFT JOIN app.result_sets AS rs ON rs.id = l.result_set_id
            WHERE l.id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) {
                    null
                } else {
                    withAttributes(connection, listOf(rs.toLayerDto(emptyList()))).single()
                }
            }
        }
    }

    fun listAttributeValues(layerId: String, field: String, limit: Int): List<String> {
        val layer = getLayer(layerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        val attribute = layer.attributes.find { it.name == field.trim() }
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown attribute: $field")
        if (attribute.name == layer.geometryColumn) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Geometry attribute values cannot be listed")
        }
        val boundedLimit = limit.coerceIn(1, 100)
        val fieldRef = quoteIdent(attribute.name)
        val sql = """
            SELECT $fieldRef::text AS value, COUNT(*) AS frequency
            FROM ${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}
            WHERE $fieldRef IS NOT NULL
            GROUP BY $fieldRef::text
            ORDER BY frequency DESC, value ASC
            LIMIT ?
        """.trimIndent()
        return dataSource.connection.use { connection ->
            connection.prepareStatement(sql).use { stmt ->
                stmt.setInt(1, boundedLimit)
                stmt.executeQuery().use { rs ->
                    buildList {
                        while (rs.next()) {
                            rs.getString("value")?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
                        }
                    }
                }
            }
        }
    }

    fun deleteLayer(id: String) {
        dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                val layer = loadDeletedLayerForUpdate(connection, id)
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
                deleteLayerInTransaction(connection, layer)
                layer.resultSetId?.let { deleteResultSetIfEmpty(connection, it) }
                connection.commit()
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Layer delete failed: ${exc.message ?: "invalid layer delete"}")
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    fun deleteResultSet(id: String) {
        dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                val resultSetExists = connection.prepareStatement(
                    "SELECT id::text FROM app.result_sets WHERE id = ?::uuid FOR UPDATE"
                ).use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeQuery().use { rs ->
                        rs.next()
                    }
                }
                if (!resultSetExists) {
                    throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Result set not found")
                }

                listDeletedLayersForResultSet(connection, id).forEach { layer ->
                    deleteLayerInTransaction(connection, layer)
                }
                deleteResultSetRecord(connection, id)
                connection.commit()
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Result set delete failed: ${exc.message ?: "invalid result set delete"}")
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    private fun loadDeletedLayerForUpdate(connection: Connection, id: String): DeletedLayerRef? =
        connection.prepareStatement(
            """
            SELECT id::text, schema_name, table_name, result_set_id::text
            FROM app.layers
            WHERE id = ?::uuid
            FOR UPDATE
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) {
                    null
                } else {
                    rs.toDeletedLayerRef()
                }
            }
        }

    private fun listDeletedLayersForResultSet(connection: Connection, resultSetId: String): List<DeletedLayerRef> =
        connection.prepareStatement(
            """
            SELECT id::text, schema_name, table_name, result_set_id::text
            FROM app.layers
            WHERE result_set_id = ?::uuid
            ORDER BY created_at DESC
            FOR UPDATE
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, resultSetId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toDeletedLayerRef())
                }
            }
        }

    private fun deleteLayerInTransaction(connection: Connection, layer: DeletedLayerRef) {
        connection.prepareStatement(
            """
            UPDATE app.lands
            SET source_layer_id = NULL, source_feature_id = NULL, updated_at = now()
            WHERE source_layer_id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        connection.prepareStatement(
            """
            UPDATE app.buildings
            SET source_layer_id = NULL, source_feature_id = NULL, updated_at = now()
            WHERE source_layer_id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        connection.prepareStatement("DELETE FROM app.zones WHERE zone_layer_id = ?::uuid OR source_layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.setString(2, layer.id)
            stmt.executeUpdate()
        }
        connection.prepareStatement("UPDATE app.layers SET source_layer_id = NULL WHERE source_layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        connection.prepareStatement("UPDATE app.import_jobs SET layer_id = NULL WHERE layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        connection.prepareStatement("UPDATE app.analysis_jobs SET result_layer_id = NULL WHERE result_layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }

        val deleted = connection.prepareStatement("DELETE FROM app.layers WHERE id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        if (deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        }

        connection.createStatement().use { stmt ->
            stmt.execute("DROP TABLE IF EXISTS ${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}")
        }
    }

    private fun deleteResultSetIfEmpty(connection: Connection, resultSetId: String) {
        val hasLayers = connection.prepareStatement("SELECT EXISTS (SELECT 1 FROM app.layers WHERE result_set_id = ?::uuid)").use { stmt ->
            stmt.setString(1, resultSetId)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getBoolean(1)
            }
        }
        if (!hasLayers) {
            deleteResultSetRecord(connection, resultSetId, requireExisting = false)
        }
    }

    private fun deleteResultSetRecord(connection: Connection, resultSetId: String, requireExisting: Boolean = true) {
        connection.prepareStatement("UPDATE app.analysis_jobs SET result_set_id = NULL WHERE result_set_id = ?::uuid").use { stmt ->
            stmt.setString(1, resultSetId)
            stmt.executeUpdate()
        }
        val deleted = connection.prepareStatement("DELETE FROM app.result_sets WHERE id = ?::uuid").use { stmt ->
            stmt.setString(1, resultSetId)
            stmt.executeUpdate()
        }
        if (requireExisting && deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Result set not found")
        }
    }

    fun getFeature(layerId: String, featureId: String): FeatureDto {
        val layer = getLayer(layerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        val sql = """
            SELECT
                (to_jsonb(t) - ?)::text AS properties,
                ST_AsGeoJSON(ST_Transform(${quoteIdent(layer.geometryColumn)}, 4326), 6)::text AS geometry
            FROM ${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)} AS t
            WHERE ${quoteIdent(layer.featureIdColumn)}::text = ?
            LIMIT 1
        """.trimIndent()
        return dataSource.connection.use { connection ->
            connection.prepareStatement(sql).use { stmt ->
                stmt.setString(1, layer.geometryColumn)
                stmt.setString(2, featureId)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) {
                        throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feature not found")
                    }
                    FeatureDto(
                        layerId = layerId,
                        featureId = featureId,
                        properties = json.parseToJsonElement(rs.getString("properties")).jsonObject,
                        geometry = rs.getString("geometry")?.let { json.parseToJsonElement(it) }
                    )
                }
            }
        }
    }

    fun searchFeatures(
        projectId: String?,
        layerId: String?,
        q: String?,
        field: String?,
        operator: String?,
        value: String?,
        linkedOnly: Boolean,
        limit: Int
    ): List<FeatureSearchResultDto> {
        val requestedLayerId = layerId?.trim()?.takeIf { it.isNotEmpty() }
        val requestedProjectId = projectId?.trim()?.takeIf { it.isNotEmpty() }
        val layer = if (requestedLayerId != null) {
            getLayer(requestedLayerId) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        } else {
            listLayers(requestedProjectId).firstOrNull() ?: return emptyList()
        }
        if (requestedProjectId != null && layer.projectId != requestedProjectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Layer does not belong to the selected project")
        }

        val boundedLimit = limit.coerceIn(1, 100)
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val query = q?.trim()?.takeIf { it.isNotEmpty() }
        if (query != null) {
            filters.add(
                """
                (
                    t.${quoteIdent(layer.featureIdColumn)}::text ILIKE ?
                    OR (to_jsonb(t) - ?)::text ILIKE ?
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$query%") }
            binders.add { stmt, index -> stmt.setString(index, layer.geometryColumn) }
            binders.add { stmt, index -> stmt.setString(index, "%$query%") }
        }

        val attribute = field?.trim()?.takeIf { it.isNotEmpty() }?.let { requestedField ->
            layer.attributes.find { it.name == requestedField }
                ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown search field: $requestedField")
        }
        if (attribute != null) {
            val op = operator?.trim()?.uppercase()?.takeIf { it.isNotEmpty() } ?: "LIKE"
            val fieldRef = "t.${quoteIdent(attribute.name)}"
            when (op) {
                "IS NULL" -> filters.add("$fieldRef IS NULL")
                "LIKE" -> {
                    val conditionValue = value?.trim()?.takeIf { it.isNotEmpty() }
                        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Search value is required")
                    filters.add("$fieldRef::text ILIKE ?")
                    binders.add { stmt, index -> stmt.setString(index, "%$conditionValue%") }
                }
                "=", "!=" -> {
                    val conditionValue = value?.trim()?.takeIf { it.isNotEmpty() }
                        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Search value is required")
                    filters.add("$fieldRef::text $op ?")
                    binders.add { stmt, index -> stmt.setString(index, conditionValue) }
                }
                "<", "<=", ">", ">=" -> {
                    val conditionValue = value?.trim()?.takeIf { it.isNotEmpty() }
                        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Search value is required")
                    if (isNumericType(attribute.dataType)) {
                        val numericValue = conditionValue.toDoubleOrNull()
                            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Search value must be a number")
                        filters.add("$fieldRef::double precision $op ?::double precision")
                        binders.add { stmt, index -> stmt.setDouble(index, numericValue) }
                    } else {
                        filters.add("$fieldRef::text $op ?")
                        binders.add { stmt, index -> stmt.setString(index, conditionValue) }
                    }
                }
                else -> throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported search operator: $op")
            }
        }

        if (linkedOnly) {
            filters.add(
                """
                (
                    EXISTS (
                        SELECT 1
                        FROM app.lands AS linked_land
                        WHERE linked_land.source_layer_id = ?::uuid
                          AND linked_land.source_feature_id = t.${quoteIdent(layer.featureIdColumn)}::text
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM app.buildings AS linked_building
                        WHERE linked_building.source_layer_id = ?::uuid
                          AND linked_building.source_feature_id = t.${quoteIdent(layer.featureIdColumn)}::text
                    )
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, layer.id) }
            binders.add { stmt, index -> stmt.setString(index, layer.id) }
        }

        val sql = """
            SELECT
                t.${quoteIdent(layer.featureIdColumn)}::text AS feature_id,
                (to_jsonb(t) - ?)::text AS properties,
                ST_AsGeoJSON(ST_Transform(t.${quoteIdent(layer.geometryColumn)}, 4326), 6)::text AS geometry
            FROM ${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)} AS t
            ${whereClause(filters)}
            ORDER BY t.${quoteIdent(layer.featureIdColumn)}::text
            LIMIT ?
        """.trimIndent()

        return dataSource.connection.use { connection ->
            val rows = connection.prepareStatement(sql).use { stmt ->
                var index = 1
                stmt.setString(index++, layer.geometryColumn)
                for (binder in binders) {
                    binder(stmt, index++)
                }
                stmt.setInt(index, boundedLimit)
                stmt.executeQuery().use { rs ->
                    buildList {
                        while (rs.next()) {
                            val featureId = rs.getString("feature_id")
                            add(
                                FeatureSearchRow(
                                    featureId = featureId,
                                    properties = json.parseToJsonElement(rs.getString("properties")).jsonObject,
                                    geometry = rs.getString("geometry")?.let { json.parseToJsonElement(it) },
                                    matchedBusinessLinks = BusinessLinksDto()
                                )
                            )
                        }
                    }
                }
            }
            rows.map { row ->
                FeatureSearchResultDto(
                    layerId = layer.id,
                    layerName = layer.name,
                    featureId = row.featureId,
                    properties = row.properties,
                    geometry = row.geometry,
                    matchSummary = conditionSearchSummary(query, emptyList()),
                    businessLinks = getBusinessLinks(connection, layer.id, row.featureId)
                )
            }
        }
    }

    fun searchBusinessSpatialFeatures(request: BusinessSpatialSearchRequest): List<FeatureSearchResultDto> {
        val resolvedProjectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: defaultProjectId()
        if (!projectExists(resolvedProjectId)) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Project does not exist")
        }
        val layers = listLayers(resolvedProjectId)
        val layersById = layers.associateBy { it.id }
        val targetLayerIds = request.targetLayerIds
            .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
            .distinct()
        if (targetLayerIds.isEmpty()) return emptyList()
        val targetLayers = targetLayerIds.map { layerId ->
            layersById[layerId]
                ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Target layer does not exist in project: $layerId")
        }
        val requestedSourceTypes = request.sourceTypes
            .mapNotNull { it.trim().lowercase().takeIf(String::isNotEmpty) }
        val sourceTypes = (requestedSourceTypes.ifEmpty { listOf("land", "building") }).toSet()
        val invalidSourceTypes = sourceTypes - setOf("land", "building")
        if (invalidSourceTypes.isNotEmpty()) {
            throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "Unsupported business source type(s): ${invalidSourceTypes.joinToString(", ")}"
            )
        }
        val spatialOperator = request.spatialOperator?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "intersects"
        if (spatialOperator !in setOf("intersects", "overlaps", "contains", "within", "dwithin")) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported spatial operator: $spatialOperator")
        }
        val distanceMeters = if (spatialOperator == "dwithin") {
            val distance = request.distanceMeters
                ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "distanceMeters is required for dwithin")
            if (distance <= 0.0) {
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "distanceMeters must be positive")
            }
            distance
        } else {
            null
        }
        val boundedLimit = request.limit.coerceIn(1, 200)

        return dataSource.connection.use { connection ->
            val results = mutableListOf<FeatureSearchResultDto>()
            for (targetLayer in targetLayers) {
                if (results.size >= boundedLimit) break
                val remainingLimit = boundedLimit - results.size
                val rows = searchBusinessSpatialFeaturesForLayer(
                    connection = connection,
                    targetLayer = targetLayer,
                    sourceLayers = layers,
                    projectId = resolvedProjectId,
                    sourceTypes = sourceTypes,
                    request = request,
                    spatialOperator = spatialOperator,
                    distanceMeters = distanceMeters,
                    limit = remainingLimit
                )
                rows.forEach { row ->
                    results.add(
                        FeatureSearchResultDto(
                            layerId = targetLayer.id,
                            layerName = targetLayer.name,
                            featureId = row.featureId,
                            properties = row.properties,
                            geometry = row.geometry,
                            matchSummary = conditionSearchSummary(null, listOf("業務条件", "空間条件")),
                            businessLinks = getBusinessLinks(connection, targetLayer.id, row.featureId),
                            matchedBusinessLinks = row.matchedBusinessLinks
                        )
                    )
                }
            }
            results
        }
    }

    private fun searchBusinessSpatialFeaturesForLayer(
        connection: Connection,
        targetLayer: LayerDto,
        sourceLayers: List<LayerDto>,
        projectId: String,
        sourceTypes: Set<String>,
        request: BusinessSpatialSearchRequest,
        spatialOperator: String,
        distanceMeters: Double?,
        limit: Int
    ): List<FeatureSearchRow> {
        val businessGeoms = businessGeometrySql(sourceLayers, projectId, sourceTypes, request)
        if (businessGeoms.sql.isBlank()) return emptyList()
        val spatialPredicate = spatialPredicateSql("tr.geom", "bg.geom", spatialOperator, distanceMeters)
        val sql = """
            WITH business_geoms AS (
                ${businessGeoms.sql}
            ),
            target_rows AS (
                SELECT
                    t.${quoteIdent(targetLayer.featureIdColumn)}::text AS feature_id,
                    (to_jsonb(t) - ?)::text AS properties,
                    ST_AsGeoJSON(ST_Transform(t.${quoteIdent(targetLayer.geometryColumn)}, 4326), 6)::text AS geometry,
                    t.${quoteIdent(targetLayer.geometryColumn)} AS geom
                FROM ${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)} AS t
                WHERE t.${quoteIdent(targetLayer.geometryColumn)} IS NOT NULL
            )
            SELECT
                tr.feature_id,
                tr.properties,
                tr.geometry,
                COALESCE(
                    jsonb_agg(DISTINCT jsonb_build_object('id', bg.business_id, 'label', bg.business_label))
                        FILTER (WHERE bg.business_type = 'land'),
                    '[]'::jsonb
                )::text AS matched_lands,
                COALESCE(
                    jsonb_agg(DISTINCT jsonb_build_object('id', bg.business_id, 'label', bg.business_label))
                        FILTER (WHERE bg.business_type = 'building'),
                    '[]'::jsonb
                )::text AS matched_buildings
            FROM target_rows AS tr
            JOIN business_geoms AS bg ON ${spatialPredicate.sql}
            GROUP BY tr.feature_id, tr.properties, tr.geometry
            ORDER BY tr.feature_id
            LIMIT ?
        """.trimIndent()

        return connection.prepareStatement(sql).use { stmt ->
            var index = 1
            for (binder in businessGeoms.binders) {
                binder(stmt, index++)
            }
            stmt.setString(index++, targetLayer.geometryColumn)
            for (binder in spatialPredicate.binders) {
                binder(stmt, index++)
            }
            stmt.setInt(index, limit)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            FeatureSearchRow(
                                featureId = rs.getString("feature_id"),
                                properties = json.parseToJsonElement(rs.getString("properties")).jsonObject,
                                geometry = rs.getString("geometry")?.let { json.parseToJsonElement(it) },
                                matchedBusinessLinks = BusinessLinksDto(
                                    lands = decodeBusinessEntityLinks(rs.getString("matched_lands")),
                                    buildings = decodeBusinessEntityLinks(rs.getString("matched_buildings"))
                                )
                            )
                        )
                    }
                }
            }
        }
    }

    fun conditionSearchFeatures(request: ConditionQueryDto): List<FeatureSearchResultDto> {
        val resolvedProjectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: defaultProjectId()
        if (!projectExists(resolvedProjectId)) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Project does not exist")
        }
        val layers = listLayers(resolvedProjectId)
        val layersById = layers.associateBy { it.id }
        val targetLayerIds = request.targetLayerIds
            .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
            .distinct()
        if (targetLayerIds.isEmpty()) return emptyList()
        val targetLayers = targetLayerIds.map { layerId ->
            layersById[layerId]
                ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Target layer does not exist in project: $layerId")
        }
        validateConditionSearchConditions(request, layersById)
        val boundedLimit = request.limit.coerceIn(1, 300)
        val summary = conditionSearchSummary(request.keyword, conditionLabels(request.conditions))
        val hasBusinessCondition = request.conditions.any {
            it.type.lowercase() == "business" ||
                (it.type.lowercase() == "spatial" && spatialComparisonTarget(it) == "business")
        }

        return dataSource.connection.use { connection ->
            val results = mutableListOf<FeatureSearchResultDto>()
            for (targetLayer in targetLayers) {
                if (results.size >= boundedLimit) break
                val rows = conditionSearchRowsForLayer(
                    connection = connection,
                    targetLayer = targetLayer,
                    sourceLayers = layers,
                    layersById = layersById,
                    projectId = resolvedProjectId,
                    request = request,
                    limit = boundedLimit - results.size
                )
                rows.forEach { row ->
                    val businessLinks = getBusinessLinks(connection, targetLayer.id, row.featureId)
                    results.add(
                        FeatureSearchResultDto(
                            layerId = targetLayer.id,
                            layerName = targetLayer.name,
                            featureId = row.featureId,
                            properties = row.properties,
                            geometry = row.geometry,
                            matchSummary = summary,
                            businessLinks = businessLinks,
                            matchedBusinessLinks = if (hasBusinessCondition && row.matchedBusinessLinks == BusinessLinksDto()) {
                                businessLinks
                            } else {
                                row.matchedBusinessLinks
                            }
                        )
                    )
                }
            }
            results
        }
    }

    private fun conditionSearchRowsForLayer(
        connection: Connection,
        targetLayer: LayerDto,
        sourceLayers: List<LayerDto>,
        layersById: Map<String, LayerDto>,
        projectId: String,
        request: ConditionQueryDto,
        limit: Int
    ): List<FeatureSearchRow> {
        val fragment = conditionSearchFilters(targetLayer, sourceLayers, layersById, projectId, request, limit)
        val sql = """
            SELECT
                t.${quoteIdent(targetLayer.featureIdColumn)}::text AS feature_id,
                (to_jsonb(t) - ?)::text AS properties,
                ST_AsGeoJSON(ST_Transform(t.${quoteIdent(targetLayer.geometryColumn)}, 4326), 6)::text AS geometry
            FROM ${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)} AS t
            WHERE ${fragment.sql}
            ORDER BY t.${quoteIdent(targetLayer.featureIdColumn)}::text
            LIMIT ?
        """.trimIndent()

        return connection.prepareStatement(sql).use { stmt ->
            var index = 1
            stmt.setString(index++, targetLayer.geometryColumn)
            for (binder in fragment.binders) {
                binder(stmt, index++)
            }
            stmt.setInt(index, limit)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            FeatureSearchRow(
                                featureId = rs.getString("feature_id"),
                                properties = json.parseToJsonElement(rs.getString("properties")).jsonObject,
                                geometry = rs.getString("geometry")?.let { json.parseToJsonElement(it) },
                                matchedBusinessLinks = BusinessLinksDto()
                            )
                        )
                    }
                }
            }
        }
    }

    // 条件検索の WHERE 述語を組み立てる単一実装。
    // プレビュー (conditionSearchFeatures) と分析ジョブの実体化 (executeClaimedAnalysisJob) が共有する
    private fun conditionSearchFilters(
        targetLayer: LayerDto,
        sourceLayers: List<LayerDto>,
        layersById: Map<String, LayerDto>,
        projectId: String,
        request: ConditionQueryDto,
        businessGeometryLimit: Int
    ): SqlFragment {
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val keyword = request.keyword?.trim()?.takeIf { it.isNotEmpty() }
        if (keyword != null) {
            filters.add(
                """
                (
                    t.${quoteIdent(targetLayer.featureIdColumn)}::text ILIKE ?
                    OR (to_jsonb(t) - ?)::text ILIKE ?
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$keyword%") }
            binders.add { stmt, index -> stmt.setString(index, targetLayer.geometryColumn) }
            binders.add { stmt, index -> stmt.setString(index, "%$keyword%") }
        }

        val attributeConditions = request.conditions.filter { it.type.lowercase() == "attribute" }
        val spatialConditions = request.conditions.filter { it.type.lowercase() == "spatial" }
        val businessConditions = request.conditions.filter { it.type.lowercase() == "business" }

        attributeConditions
            .filter { conditionLayerId(it).let { layerId -> layerId == null || layerId == targetLayer.id } }
            .forEach { addAttributeConditionFilter("t", targetLayer, it, filters, binders) }

        val nonTargetLayerIds = buildSet {
            attributeConditions.mapNotNullTo(this) { conditionLayerId(it)?.takeIf { layerId -> layerId != targetLayer.id } }
            spatialConditions
                .filter { spatialComparisonTarget(it) == "layer" }
                .mapNotNullTo(this) { conditionLayerId(it)?.takeIf { layerId -> layerId != targetLayer.id } }
        }
        for (layerId in nonTargetLayerIds.sorted()) {
            val otherLayer = layersById[layerId]
                ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Referenced layer does not exist in project: $layerId")
            val inner = mutableListOf<String>()
            attributeConditions
                .filter { conditionLayerId(it) == layerId }
                .forEach { addAttributeConditionFilter("o", otherLayer, it, inner, binders) }
            spatialConditions
                .filter { conditionLayerId(it) == layerId }
                .forEach { condition ->
                    val spatial = spatialPredicateSql(
                        "t.${quoteIdent(targetLayer.geometryColumn)}",
                        "o.${quoteIdent(otherLayer.geometryColumn)}",
                        condition.spatialOperator?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                            ?: condition.operator?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                            ?: "intersects",
                        condition.distanceMeters
                    )
                    inner.add(spatial.sql)
                    binders.addAll(spatial.binders)
                }
            if (inner.isEmpty()) inner.add("TRUE")
            filters.add(
                """
                EXISTS (
                    SELECT 1
                    FROM ${quoteIdent(otherLayer.schemaName)}.${quoteIdent(otherLayer.tableName)} AS o
                    WHERE ${inner.joinToString(" AND ")}
                )
                """.trimIndent()
            )
        }

        val businessSpatialConditions = spatialConditions.filter { spatialComparisonTarget(it) == "business" }
        if (businessSpatialConditions.isEmpty()) {
            businessConditions.forEach { condition ->
                val businessLinks = businessLinkPredicateSql(targetLayer, projectId, condition)
                filters.add(businessLinks.sql)
                binders.addAll(businessLinks.binders)
            }
        }

        businessSpatialConditions.forEach { condition ->
            val businessFilter = mergedBusinessCondition(businessConditions)
            val sourceTypes = businessSourceTypes(businessFilter)
            val businessRequest = businessSearchRequest(projectId, targetLayer.id, businessFilter, sourceTypes, businessGeometryLimit)
            val businessGeoms = businessGeometrySql(sourceLayers, projectId, sourceTypes.toSet(), businessRequest)
            if (businessGeoms.sql.isBlank()) {
                filters.add("FALSE")
                return@forEach
            }
            val spatial = spatialPredicateSql(
                "t.${quoteIdent(targetLayer.geometryColumn)}",
                "bg.geom",
                condition.spatialOperator?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                    ?: condition.operator?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                    ?: "intersects",
                condition.distanceMeters
            )
            filters.add(
                """
                EXISTS (
                    SELECT 1
                    FROM (
                        ${businessGeoms.sql}
                    ) AS bg
                    WHERE ${spatial.sql}
                )
                """.trimIndent()
            )
            binders.addAll(businessGeoms.binders)
            binders.addAll(spatial.binders)
        }

        return SqlFragment(if (filters.isEmpty()) "TRUE" else filters.joinToString(" AND "), binders)
    }

    private fun validateConditionSearchConditions(
        request: ConditionQueryDto,
        layersById: Map<String, LayerDto>
    ) {
        request.conditions.forEach { condition ->
            when (condition.type.lowercase()) {
                "attribute" -> {
                    val field = condition.field?.takeIf { it.isNotBlank() }
                        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Attribute condition field is required")
                    val operator = condition.operator?.uppercase()?.takeIf { it.isNotBlank() } ?: "="
                    if (operator !in setOf("=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL")) {
                        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported attribute operator: $operator")
                    }
                    val layerId = conditionLayerId(condition)
                    val candidateLayers = if (layerId == null) {
                        request.targetLayerIds.mapNotNull { layersById[it] }
                    } else {
                        listOf(layersById[layerId]
                            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Referenced layer does not exist in project: $layerId"))
                    }
                    if (candidateLayers.any { layer -> layer.attributes.none { it.name == field } }) {
                        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown attribute in condition: $field")
                    }
                }
                "spatial" -> {
                    val comparisonTarget = spatialComparisonTarget(condition)
                    if (comparisonTarget !in setOf("layer", "business")) {
                        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported spatial comparison target: $comparisonTarget")
                    }
                    if (comparisonTarget == "layer") {
                        val layerId = conditionLayerId(condition)
                            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Spatial condition layerId is required")
                        if (!layersById.containsKey(layerId)) {
                            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Referenced layer does not exist in project: $layerId")
                        }
                    }
                    val operator = condition.spatialOperator?.lowercase()?.takeIf { it.isNotBlank() }
                        ?: condition.operator?.lowercase()?.takeIf { it.isNotBlank() }
                        ?: "intersects"
                    if (operator !in setOf("intersects", "contains", "within", "dwithin")) {
                        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported spatial operator: $operator")
                    }
                    if (operator == "dwithin" && ((condition.distanceMeters ?: 0.0) <= 0.0)) {
                        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "dwithin requires a positive distanceMeters value")
                    }
                }
                "business" -> {
                    val sourceTypes = condition.sourceTypes?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() }
                        ?: emptyList()
                    val invalidSourceTypes = sourceTypes.toSet() - setOf("land", "building")
                    if (invalidSourceTypes.isNotEmpty()) {
                        throw ApiException(
                            io.ktor.http.HttpStatusCode.BadRequest,
                            "Unsupported business source type(s): ${invalidSourceTypes.joinToString(", ")}"
                        )
                    }
                }
                else -> throw ApiException(
                    io.ktor.http.HttpStatusCode.BadRequest,
                    "Unsupported condition type: ${condition.type}"
                )
            }
        }
    }

    private fun addAttributeConditionFilter(
        alias: String,
        layer: LayerDto,
        condition: ConditionQueryConditionDto,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val field = condition.field?.takeIf { it.isNotBlank() }
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Attribute condition field is required")
        val attribute = layer.attributes.find { it.name == field }
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown attribute '$field' for layer '${layer.name}'")
        val operator = condition.operator?.uppercase()?.takeIf { it.isNotBlank() } ?: "="
        val fieldRef = "$alias.${quoteIdent(attribute.name)}"
        when (operator) {
            "IS NULL" -> filters.add("$fieldRef IS NULL")
            "LIKE" -> {
                val value = conditionValueText(condition)
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "LIKE operator requires a value")
                filters.add("$fieldRef::text ILIKE ?")
                binders.add { stmt, index -> stmt.setString(index, "%$value%") }
            }
            "IN" -> {
                val values = condition.values?.map { it.trim() }?.filter { it.isNotEmpty() }
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "IN operator requires values")
                if (values.isEmpty()) {
                    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "IN operator requires values")
                }
                filters.add("$fieldRef::text = ANY(?::text[])")
                binders.add { stmt, index -> stmt.setArray(index, stmt.connection.createArrayOf("text", values.toTypedArray())) }
            }
            "<", "<=", ">", ">=" -> {
                val value = conditionValueText(condition)
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$operator operator requires a value")
                if (isNumericType(attribute.dataType)) {
                    val numericValue = value.toDoubleOrNull()
                        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$operator operator requires a numeric value")
                    filters.add("$fieldRef::double precision $operator ?::double precision")
                    binders.add { stmt, index -> stmt.setDouble(index, numericValue) }
                } else {
                    filters.add("$fieldRef::text $operator ?")
                    binders.add { stmt, index -> stmt.setString(index, value) }
                }
            }
            "=", "!=" -> {
                val value = conditionValueText(condition)
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$operator operator requires a value")
                val sqlOperator = if (operator == "!=") "<>" else operator
                filters.add("$fieldRef::text $sqlOperator ?")
                binders.add { stmt, index -> stmt.setString(index, value) }
            }
            else -> throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unsupported attribute operator: $operator")
        }
    }

    private fun conditionLayerId(condition: ConditionQueryConditionDto): String? =
        condition.layerId?.trim()?.takeIf { it.isNotEmpty() }

    private fun spatialComparisonTarget(condition: ConditionQueryConditionDto): String =
        condition.comparisonTarget?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            ?: if (condition.type.lowercase() == "spatial" && conditionLayerId(condition) == null) "business" else "layer"

    private fun mergedBusinessCondition(conditions: List<ConditionQueryConditionDto>): ConditionQueryConditionDto? =
        conditions.firstOrNull()

    private fun businessSourceTypes(condition: ConditionQueryConditionDto?): List<String> =
        condition?.sourceTypes
            ?.mapNotNull { it.trim().lowercase().takeIf(String::isNotEmpty) }
            ?.ifEmpty { listOf("land", "building") }
            ?: listOf("land", "building")

    private fun businessSearchRequest(
        projectId: String,
        targetLayerId: String,
        condition: ConditionQueryConditionDto?,
        sourceTypes: List<String>,
        limit: Int
    ): BusinessSpatialSearchRequest = BusinessSpatialSearchRequest(
        projectId = projectId,
        targetLayerIds = listOf(targetLayerId),
        sourceTypes = sourceTypes,
        businessQuery = condition?.businessQuery,
        status = condition?.status,
        landUse = condition?.landUse,
        buildingUse = condition?.buildingUse,
        partyQuery = condition?.partyQuery,
        partyType = condition?.partyType,
        relationType = condition?.relationType,
        limit = limit
    )

    private fun businessLinkPredicateSql(
        targetLayer: LayerDto,
        projectId: String,
        condition: ConditionQueryConditionDto
    ): SqlFragment {
        val sourceTypes = businessSourceTypes(condition).toSet()
        val invalidSourceTypes = sourceTypes - setOf("land", "building")
        if (invalidSourceTypes.isNotEmpty()) {
            throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "Unsupported business source type(s): ${invalidSourceTypes.joinToString(", ")}"
            )
        }

        val clauses = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val featureIdRef = "t.${quoteIdent(targetLayer.featureIdColumn)}"
        if ("land" in sourceTypes) {
            val filters = mutableListOf(
                "l.project_id = ?::uuid",
                "l.source_layer_id = ?::uuid",
                "l.source_feature_id = $featureIdRef::text"
            )
            val landBinders = mutableListOf<(PreparedStatement, Int) -> Unit>(
                { stmt, index -> stmt.setString(index, projectId) },
                { stmt, index -> stmt.setString(index, targetLayer.id) }
            )
            addBusinessQueryFilter(
                condition.businessQuery,
                "concat_ws(' ', l.id, l.lot_number, l.address, l.land_use, l.status, l.memo)",
                filters,
                landBinders
            )
            addBusinessChoiceFilter(condition.status, "l.status", filters, landBinders)
            addBusinessChoiceFilter(condition.landUse, "l.land_use", filters, landBinders)
            addPartyRelationshipFilter("land", "l.id", "l.project_id", businessSearchRequest(projectId, targetLayer.id, condition, listOf("land"), 1), filters, landBinders)
            clauses.add("EXISTS (SELECT 1 FROM app.lands AS l WHERE ${filters.joinToString(" AND ")})")
            binders.addAll(landBinders)
        }
        if ("building" in sourceTypes) {
            val filters = mutableListOf(
                "b.project_id = ?::uuid",
                "b.source_layer_id = ?::uuid",
                "b.source_feature_id = $featureIdRef::text"
            )
            val buildingBinders = mutableListOf<(PreparedStatement, Int) -> Unit>(
                { stmt, index -> stmt.setString(index, projectId) },
                { stmt, index -> stmt.setString(index, targetLayer.id) }
            )
            addBusinessQueryFilter(
                condition.businessQuery,
                "concat_ws(' ', b.id, b.name, b.building_use, b.structure, b.status, b.memo, l.lot_number, l.address)",
                filters,
                buildingBinders
            )
            addBusinessChoiceFilter(condition.status, "b.status", filters, buildingBinders)
            addBusinessChoiceFilter(condition.buildingUse, "b.building_use", filters, buildingBinders)
            addPartyRelationshipFilter("building", "b.id", "b.project_id", businessSearchRequest(projectId, targetLayer.id, condition, listOf("building"), 1), filters, buildingBinders)
            clauses.add(
                """
                EXISTS (
                    SELECT 1
                    FROM app.buildings AS b
                    LEFT JOIN app.lands AS l ON l.id = b.land_id
                    WHERE ${filters.joinToString(" AND ")}
                )
                """.trimIndent()
            )
            binders.addAll(buildingBinders)
        }
        return SqlFragment(
            if (clauses.isEmpty()) "FALSE" else "(${clauses.joinToString(" OR ")})",
            binders
        )
    }

    private fun conditionValueText(condition: ConditionQueryConditionDto): String? {
        val value = condition.value ?: return null
        if (value is JsonNull) return null
        return try {
            value.jsonPrimitive.contentOrNull
        } catch (exc: IllegalArgumentException) {
            value.toString()
        }?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun conditionLabels(conditions: List<ConditionQueryConditionDto>): List<String> =
        conditions.mapNotNull { condition ->
            when (condition.type.lowercase()) {
                "attribute" -> "属性条件"
                "spatial" -> "空間条件"
                "business" -> "業務条件"
                else -> null
            }
        }.distinct()

    private fun conditionSearchSummary(keyword: String?, labels: List<String>): String {
        val parts = mutableListOf<String>()
        keyword?.trim()?.takeIf { it.isNotEmpty() }?.let { parts.add("キーワード: $it") }
        parts.addAll(labels)
        return if (parts.isEmpty()) "条件なし" else parts.joinToString(" AND ")
    }

    fun updateFeature(layerId: String, featureId: String, request: FeatureUpdateRequest): FeatureDto {
        val layer = getLayer(layerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        val editableAttributes = layer.attributes
            .map { it.name }
            .filterNot { it == layer.featureIdColumn || it == layer.geometryColumn }
            .toSet()
        val invalidAttributes = request.properties.keys.filterNot { it in editableAttributes }
        if (invalidAttributes.isNotEmpty()) {
            throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "Unknown or read-only attribute(s): ${invalidAttributes.joinToString(", ")}"
            )
        }

        val propertyNames = request.properties.keys.sorted()
        val geometry = request.geometry?.takeUnless { it is JsonNull }
        if (propertyNames.isEmpty() && geometry == null) {
            return getFeature(layerId, featureId)
        }
        if (geometry != null && geometry !is JsonObject) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Geometry must be a GeoJSON object")
        }

        val tableRef = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
        val rawGeometryUpdate = "ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?), 4326), 3857))"
        val geometryUpdate = if (layer.geometryType.uppercase().contains("MULTI")) {
            "ST_Multi($rawGeometryUpdate)"
        } else {
            rawGeometryUpdate
        }
        val setClauses = buildList {
            propertyNames.forEach { name ->
                add("${quoteIdent(name)} = (payload.row).${quoteIdent(name)}")
            }
            if (geometry != null) {
                add("${quoteIdent(layer.geometryColumn)} = $geometryUpdate")
            }
        }
        val filteredProperties = JsonObject(propertyNames.associateWith { request.properties.getValue(it) })
        val sql = """
            WITH payload AS (
                SELECT jsonb_populate_record(NULL::$tableRef, ?::jsonb) AS row
            )
            UPDATE $tableRef AS t
            SET ${setClauses.joinToString(", ")}
            FROM payload
            WHERE t.${quoteIdent(layer.featureIdColumn)}::text = ?
            RETURNING
                (to_jsonb(t) - ?)::text AS properties,
                ST_AsGeoJSON(ST_Transform(t.${quoteIdent(layer.geometryColumn)}, 4326), 6)::text AS geometry
        """.trimIndent()

        return dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                val updated = connection.prepareStatement(sql).use { stmt ->
                    var index = 1
                    stmt.setString(index++, json.encodeToString(filteredProperties))
                    if (geometry != null) {
                        stmt.setString(index++, json.encodeToString(geometry))
                    }
                    stmt.setString(index++, featureId)
                    stmt.setString(index, layer.geometryColumn)
                    stmt.executeQuery().use { rs ->
                        if (!rs.next()) {
                            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feature not found")
                        }
                        FeatureDto(
                            layerId = layerId,
                            featureId = featureId,
                            properties = json.parseToJsonElement(rs.getString("properties")).jsonObject,
                            geometry = rs.getString("geometry")?.let { json.parseToJsonElement(it) }
                        )
                    }
                }
                if (geometry != null) {
                    refreshLayerMetadata(connection, layer)
                }
                connection.commit()
                updated
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(
                    io.ktor.http.HttpStatusCode.BadRequest,
                    "Feature update failed: ${exc.message ?: "invalid feature update"}"
                )
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    fun getMvtTile(layerId: String, z: Int, x: Int, y: Int): ByteArray {
        if (z !in 0..24 || x < 0 || y < 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Invalid tile coordinate")
        }
        val layer = getLayer(layerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        val propertyColumns = layer.attributes
            .filterNot { it.name == layer.geometryColumn }
            .joinToString("") { ", t.${quoteIdent(it.name)}" }
        val sql = """
            WITH bounds AS (
                SELECT ST_TileEnvelope(?::integer, ?::integer, ?::integer) AS geom
            ),
            mvtgeom AS (
                SELECT
                    ST_AsMVTGeom(t.${quoteIdent(layer.geometryColumn)}, bounds.geom, 4096, 64, true) AS geom
                    $propertyColumns
                FROM ${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)} AS t, bounds
                WHERE t.${quoteIdent(layer.geometryColumn)} && bounds.geom
                  AND ST_Intersects(t.${quoteIdent(layer.geometryColumn)}, bounds.geom)
            )
            SELECT COALESCE(ST_AsMVT(mvtgeom, ?, 4096, 'geom'), ''::bytea) AS tile
            FROM mvtgeom
        """.trimIndent()
        return dataSource.connection.use { connection ->
            connection.prepareStatement(sql).use { stmt ->
                stmt.setInt(1, z)
                stmt.setInt(2, x)
                stmt.setInt(3, y)
                stmt.setString(4, layer.tileSourceId)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    rs.getBytes("tile") ?: ByteArray(0)
                }
            }
        }
    }

    fun createAnalysisJob(request: AnalysisJobRequest): AnalysisJobDto {
        val projectId = request.projectId ?: defaultProjectId()
        val normalizedRequest = request.copy(
            projectId = projectId,
            conditionQuery = request.conditionQuery?.copy(projectId = projectId)
        )
        val criteriaJson = json.encodeToString(normalizedRequest)
        val name = request.name?.takeIf { it.isNotBlank() } ?: "Analysis ${OffsetDateTime.now()}"
        return dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO app.analysis_jobs (project_id, name, criteria)
                VALUES (?::uuid, ?, ?::jsonb)
                RETURNING id::text
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, projectId)
                stmt.setString(2, name)
                stmt.setString(3, criteriaJson)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getAnalysisJob(rs.getString(1)) ?: error("Created analysis job disappeared")
                }
            }
        }
    }

    fun getAnalysisJob(id: String): AnalysisJobDto? = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT id::text, project_id::text, name, criteria::text, status, error_message,
                   result_layer_id::text, result_set_id::text, result_count,
                   created_at::text, started_at::text, finished_at::text
            FROM app.analysis_jobs
            WHERE id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toAnalysisJobDto()
            }
        }
    }

    // pending の分析ジョブを 1 件 claim する (worker-gis と同じ FOR UPDATE SKIP LOCKED 方式)。
    // claim は独立トランザクションで確定するため、実行中にプロセスが落ちたジョブは running のまま残る
    fun claimPendingAnalysisJob(): ClaimedAnalysisJob? = dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            UPDATE app.analysis_jobs
            SET status = 'running', started_at = now(), error_message = NULL
            WHERE id = (
                SELECT id
                FROM app.analysis_jobs
                WHERE status = 'pending'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id::text, project_id::text, name, criteria::text
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                if (!rs.next()) {
                    null
                } else {
                    ClaimedAnalysisJob(
                        id = rs.getString(1),
                        projectId = rs.getString(2),
                        name = rs.getString(3),
                        criteriaJson = rs.getString(4)
                    )
                }
            }
        }
    }

    // claim 済み分析ジョブを実行する。結果テーブル作成・レイヤ登録・ジョブ状態更新を
    // 1 トランザクションで確定し、例外時は failed を記録する (呼び出し側へは投げない)
    fun executeClaimedAnalysisJob(job: ClaimedAnalysisJob) {
        try {
            val request = json.decodeFromString<AnalysisJobRequest>(job.criteriaJson)
            val operation = request.operation?.takeIf { it.isNotBlank() }?.lowercase() ?: "and_filter"
            val outcome = dataSource.connection.use { connection ->
                val previousAutoCommit = connection.autoCommit
                connection.autoCommit = false
                try {
                    val outcome = when (operation) {
                        "condition_search" -> executeConditionSearchAnalysisJob(connection, job, request)
                        "and_filter" -> executeAndFilterAnalysisJob(connection, job, request)
                        else -> throw IllegalArgumentException("Unsupported analysis operation: ${request.operation}")
                    }
                    connection.prepareStatement(
                        """
                        UPDATE app.analysis_jobs
                        SET status = 'succeeded',
                            result_layer_id = ?::uuid,
                            result_set_id = ?::uuid,
                            result_count = ?,
                            finished_at = now()
                        WHERE id = ?::uuid
                        """.trimIndent()
                    ).use { stmt ->
                        setNullableUuidString(stmt, 1, outcome.resultLayerId)
                        setNullableUuidString(stmt, 2, outcome.resultSetId)
                        stmt.setLong(3, outcome.resultCount)
                        stmt.setString(4, job.id)
                        stmt.executeUpdate()
                    }
                    connection.commit()
                    outcome
                } catch (exc: Exception) {
                    connection.rollback()
                    throw exc
                } finally {
                    connection.autoCommit = previousAutoCommit
                }
            }
            logger.info(
                "Analysis job {} succeeded (layer={}, resultSet={}, count={})",
                job.id, outcome.resultLayerId, outcome.resultSetId, outcome.resultCount
            )
        } catch (exc: Exception) {
            markAnalysisJobFailed(job.id, exc)
        }
    }

    private fun executeConditionSearchAnalysisJob(
        connection: Connection,
        job: ClaimedAnalysisJob,
        request: AnalysisJobRequest
    ): AnalysisJobOutcome {
        val conditionQuery = request.conditionQuery
            ?: throw IllegalArgumentException("conditionQuery is required for condition_search")
        val projectId = conditionQuery.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: job.projectId
        if (projectId != job.projectId) {
            throw IllegalArgumentException("Condition query project does not match analysis project")
        }

        val layers = listLayers(projectId)
        val layersById = layers.associateBy { it.id }
        val targetLayerIds = conditionQuery.targetLayerIds
            .mapNotNull { it.trim().takeIf(String::isNotEmpty) }
            .distinct()
        if (targetLayerIds.isEmpty()) {
            throw IllegalArgumentException("conditionQuery.targetLayerIds is required")
        }
        val targetLayers = targetLayerIds.map { layerId ->
            layersById[layerId]
                ?: throw IllegalArgumentException("Target layer does not exist in project: $layerId")
        }
        validateConditionSearchConditions(conditionQuery, layersById)

        val summary = conditionSearchSummary(conditionQuery.keyword, conditionLabels(conditionQuery.conditions))
        val emptyBusinessLinksJson = json.encodeToString(BusinessLinksDto())
        val resultSetId = insertResultSet(connection, projectId, job.name, conditionQuery)
        val baseTableName = "result_${job.id.replace("-", "").take(24)}"

        var representativeLayerId: String? = null
        var totalCount = 0L
        targetLayers.forEachIndexed { index, target ->
            val childTable = "%s_%02d".format(baseTableName, index + 1)
            val resultRef = "${quoteIdent("gis_data")}.${quoteIdent(childTable)}"
            val targetRef = "${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}"
            val fragment = conditionSearchFilters(target, layers, layersById, projectId, conditionQuery, conditionQuery.limit)
            val sourceSelect = selectableSourceColumns(connection, target)
                .joinToString(",\n                ") { "t.${quoteIdent(it)}" }

            connection.createStatement().use { stmt ->
                stmt.execute("DROP TABLE IF EXISTS $resultRef")
                // CREATE TABLE AS はユーティリティ文でバインドパラメータを使えないため、
                // スキーマだけ WHERE FALSE で作り、本体は INSERT ... SELECT で流し込む
                stmt.execute(
                    """
                    CREATE TABLE $resultRef AS
                    SELECT
                        $sourceSelect,
                        NULL::uuid AS source_layer_id,
                        t.${quoteIdent(target.featureIdColumn)}::text AS source_feature_id,
                        NULL::text AS matched_condition_summary,
                        NULL::jsonb AS matched_business_links
                    FROM $targetRef AS t
                    WHERE FALSE
                    """.trimIndent()
                )
            }
            connection.prepareStatement(
                """
                INSERT INTO $resultRef
                SELECT
                    $sourceSelect,
                    ?::uuid AS source_layer_id,
                    t.${quoteIdent(target.featureIdColumn)}::text AS source_feature_id,
                    ?::text AS matched_condition_summary,
                    ?::jsonb AS matched_business_links
                FROM $targetRef AS t
                WHERE ${fragment.sql}
                """.trimIndent()
            ).use { stmt ->
                var bindIndex = 1
                stmt.setString(bindIndex++, target.id)
                stmt.setString(bindIndex++, summary)
                stmt.setString(bindIndex++, emptyBusinessLinksJson)
                for (binder in fragment.binders) {
                    binder(stmt, bindIndex++)
                }
                stmt.executeUpdate()
            }
            normalizeGeneratedTable(connection, "gis_data", childTable, "geom")
            val count = countRows(connection, resultRef)
            totalCount += count
            val layerId = insertLayerMetadata(
                connection = connection,
                projectId = projectId,
                name = "${target.name} ${count}件",
                tableName = childTable,
                sourceSrid = 3857,
                isResult = true,
                layerRole = "generic",
                resultSetId = resultSetId,
                sourceLayerId = target.id
            )
            if (representativeLayerId == null) {
                representativeLayerId = layerId
            }
        }
        return AnalysisJobOutcome(representativeLayerId, resultSetId, totalCount)
    }

    private fun executeAndFilterAnalysisJob(
        connection: Connection,
        job: ClaimedAnalysisJob,
        request: AnalysisJobRequest
    ): AnalysisJobOutcome {
        val targetLayerId = request.targetLayerId?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("targetLayerId is required")
        val referencedLayerIds = buildSet {
            add(targetLayerId)
            request.attributeConditions.forEach { add(it.layerId) }
            request.spatialConditions.forEach { add(it.layerId) }
        }
        val layers = referencedLayerIds.associateWith { layerId ->
            getLayerInConnection(connection, layerId)
                ?: throw IllegalArgumentException("Layer not found: $layerId")
        }
        layers.values.forEach { layer ->
            if (layer.projectId != job.projectId) {
                throw IllegalArgumentException("Layer ${layer.id} does not belong to analysis project")
            }
        }
        val target = layers.getValue(targetLayerId)

        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        request.attributeConditions
            .filter { it.layerId == target.id }
            .forEach { filters.add(andFilterAttributePredicate("t", it, binders)) }

        val nonTargetLayerIds = buildSet {
            request.attributeConditions.mapNotNullTo(this) { it.layerId.takeIf { layerId -> layerId != target.id } }
            request.spatialConditions.mapTo(this) { it.layerId }
        }
        for (layerId in nonTargetLayerIds.sorted()) {
            val otherLayer = layers.getValue(layerId)
            val inner = mutableListOf<String>()
            request.spatialConditions
                .filter { it.layerId == layerId }
                .forEach { condition ->
                    val spatial = spatialPredicateSql(
                        "t.${quoteIdent(target.geometryColumn)}",
                        "o.${quoteIdent(otherLayer.geometryColumn)}",
                        condition.operator.trim().lowercase(),
                        condition.distanceMeters
                    )
                    inner.add(spatial.sql)
                    binders.addAll(spatial.binders)
                }
            request.attributeConditions
                .filter { it.layerId == layerId }
                .forEach { inner.add(andFilterAttributePredicate("o", it, binders)) }
            if (inner.isEmpty()) inner.add("TRUE")
            filters.add(
                """
                EXISTS (
                    SELECT 1
                    FROM ${quoteIdent(otherLayer.schemaName)}.${quoteIdent(otherLayer.tableName)} AS o
                    WHERE ${inner.joinToString(" AND ")}
                )
                """.trimIndent()
            )
        }
        val whereSql = if (filters.isEmpty()) "TRUE" else filters.joinToString(" AND ")

        val tableName = "result_${job.id.replace("-", "").take(24)}"
        val resultRef = "${quoteIdent("gis_data")}.${quoteIdent(tableName)}"
        val targetRef = "${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}"
        connection.createStatement().use { stmt ->
            stmt.execute("DROP TABLE IF EXISTS $resultRef")
            stmt.execute("CREATE TABLE $resultRef AS SELECT t.* FROM $targetRef AS t WHERE FALSE")
        }
        connection.prepareStatement(
            "INSERT INTO $resultRef SELECT t.* FROM $targetRef AS t WHERE $whereSql"
        ).use { stmt ->
            var bindIndex = 1
            for (binder in binders) {
                binder(stmt, bindIndex++)
            }
            stmt.executeUpdate()
        }
        normalizeGeneratedTable(connection, "gis_data", tableName, "geom")
        val count = countRows(connection, resultRef)
        val layerId = insertLayerMetadata(
            connection = connection,
            projectId = job.projectId,
            name = job.name,
            tableName = tableName,
            sourceSrid = 3857,
            isResult = true,
            layerRole = "generic"
        )
        return AnalysisJobOutcome(layerId, null, count)
    }

    // and_filter (旧形式) の属性述語。worker-gis の attribute_predicate と同じ意味論を保つ
    private fun andFilterAttributePredicate(
        alias: String,
        condition: AttributeConditionDto,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ): String {
        val column = "$alias.${quoteIdent(condition.field)}"
        val operator = condition.operator.uppercase().let { if (it == "!=") "<>" else it }
        return when (operator) {
            "IS NULL" -> "$column IS NULL"
            "LIKE" -> {
                val value = condition.value?.jsonPrimitive?.contentOrNull
                    ?: throw IllegalArgumentException("LIKE operator requires a value")
                binders.add { stmt, index -> stmt.setString(index, value) }
                "$column::text LIKE ?"
            }
            "IN" -> {
                val values = condition.values?.filter { it.isNotEmpty() }
                    ?: throw IllegalArgumentException("IN operator requires values")
                if (values.isEmpty()) throw IllegalArgumentException("IN operator requires values")
                binders.add { stmt, index -> stmt.setArray(index, stmt.connection.createArrayOf("text", values.toTypedArray())) }
                "$column::text = ANY(?::text[])"
            }
            "=", "<>", "<", "<=", ">", ">=" -> {
                val value = condition.value
                if (value == null || value is JsonNull) {
                    throw IllegalArgumentException("${condition.operator} operator requires a value")
                }
                val primitive = value.jsonPrimitive
                val boolValue = primitive.booleanOrNull
                val longValue = primitive.longOrNull
                val doubleValue = primitive.doubleOrNull
                when {
                    primitive.isString -> binders.add { stmt, index -> stmt.setString(index, primitive.content) }
                    boolValue != null -> binders.add { stmt, index -> stmt.setBoolean(index, boolValue) }
                    longValue != null -> binders.add { stmt, index -> stmt.setLong(index, longValue) }
                    doubleValue != null -> binders.add { stmt, index -> stmt.setDouble(index, doubleValue) }
                    else -> binders.add { stmt, index -> stmt.setString(index, primitive.content) }
                }
                "$column $operator ?"
            }
            else -> throw IllegalArgumentException("Unsupported attribute operator: ${condition.operator}")
        }
    }

    // 結果テーブルへ引き継ぐ元レイヤの列。結果メタデータ列と衝突する列は除外する
    private fun selectableSourceColumns(connection: Connection, layer: LayerDto): List<String> {
        val metadataColumns = setOf("source_layer_id", "source_feature_id", "matched_condition_summary", "matched_business_links")
        val columns = connection.prepareStatement(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = ? AND table_name = ?
            ORDER BY ordinal_position
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layer.schemaName)
            stmt.setString(2, layer.tableName)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        val column = rs.getString("column_name")
                        if (column !in metadataColumns) add(column)
                    }
                }
            }
        }
        if (columns.isEmpty()) {
            throw IllegalArgumentException("Layer ${layer.id} has no selectable columns")
        }
        return columns
    }

    private fun insertResultSet(
        connection: Connection,
        projectId: String,
        name: String,
        conditionQuery: ConditionQueryDto
    ): String = connection.prepareStatement(
        """
        INSERT INTO app.result_sets (project_id, name, criteria)
        VALUES (?::uuid, ?, ?::jsonb)
        RETURNING id::text
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, projectId)
        stmt.setString(2, name)
        stmt.setString(3, json.encodeToString(conditionQuery))
        stmt.executeQuery().use { rs ->
            rs.next()
            rs.getString(1)
        }
    }

    private fun countRows(connection: Connection, tableRef: String): Long =
        connection.createStatement().use { stmt ->
            stmt.executeQuery("SELECT count(*)::bigint FROM $tableRef").use { rs ->
                rs.next()
                rs.getLong(1)
            }
        }

    private fun markAnalysisJobFailed(jobId: String, exc: Exception) {
        val message = (exc.message ?: exc.toString()).take(4000)
        try {
            dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """
                    UPDATE app.analysis_jobs
                    SET status = 'failed', error_message = ?, finished_at = now()
                    WHERE id = ?::uuid
                    """.trimIndent()
                ).use { stmt ->
                    stmt.setString(1, message)
                    stmt.setString(2, jobId)
                    stmt.executeUpdate()
                }
            }
        } catch (updateExc: Exception) {
            logger.error("Failed to mark analysis job $jobId as failed", updateExc)
        }
        logger.warn("Analysis job {} failed: {}", jobId, message)
    }

    fun getBusinessLinks(layerId: String, featureId: String): BusinessLinksDto = dataSource.connection.use { connection ->
        getBusinessLinks(connection, layerId, featureId)
    }

    private fun getBusinessLinks(connection: Connection, layerId: String, featureId: String): BusinessLinksDto = BusinessLinksDto(
        lands = connection.prepareStatement(
            """
            SELECT id, concat(lot_number, ' · ', address) AS label
            FROM app.lands
            WHERE source_layer_id = ?::uuid AND source_feature_id = ?
            ORDER BY id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layerId)
            stmt.setString(2, featureId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(BusinessEntityLinkDto(rs.getString("id"), rs.getString("label")))
                }
            }
        },
        buildings = connection.prepareStatement(
            """
            SELECT id, name AS label
            FROM app.buildings
            WHERE source_layer_id = ?::uuid AND source_feature_id = ?
            ORDER BY id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layerId)
            stmt.setString(2, featureId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(BusinessEntityLinkDto(rs.getString("id"), rs.getString("label")))
                }
            }
        }
    )

    fun listZones(query: ZoneListQuery): List<ZoneDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
        if (!query.projectId.isNullOrBlank()) {
            filters.add("z.project_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, query.projectId) }
        }
        if (textQuery != null) {
            filters.add(
                """
                lower(
                    coalesce(z.id, '') || ' ' ||
                    coalesce(z.name, '') || ' ' ||
                    coalesce(z.zone_type, '') || ' ' ||
                    coalesce(z.status, '') || ' ' ||
                    coalesce(z.memo, '')
                ) LIKE lower(?)
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        }
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("z.status ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        query.zoneType?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("z.zone_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        val requestedZoneLayerId = query.zoneLayerId?.trim()?.takeIf { it.isNotEmpty() }
            ?: query.sourceLayerId?.trim()?.takeIf { it.isNotEmpty() }
        requestedZoneLayerId?.let { value ->
            filters.add("z.zone_layer_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, value) }
        }
        if (query.linkedOnly) {
            filters.add("z.zone_layer_id IS NOT NULL AND z.zone_feature_id IS NOT NULL")
        }
        val sql = """
            SELECT z.id, z.project_id::text, z.name, z.zone_type, z.status, z.memo,
                   z.zone_layer_id::text, z.zone_feature_id,
                   z.source_layer_id::text, z.source_feature_id
            FROM app.zones AS z
            ${whereClause(filters)}
            ORDER BY z.id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        val zone = rs.toZoneDto()
                        val contained = listZoneBusinessLinks(zone)
                        add(
                            zone.copy(
                                landCount = contained.lands.size,
                                buildingCount = contained.buildings.size
                            )
                        )
                    }
                }
            }
        }
    }

    fun getZone(id: String): ZoneDto? = dataSource.connection.use { connection ->
        val zone = connection.prepareStatement(
            """
            SELECT id, project_id::text, name, zone_type, status, memo,
                   zone_layer_id::text, zone_feature_id,
                   source_layer_id::text, source_feature_id
            FROM app.zones
            WHERE id = ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toZoneDto()
            }
        } ?: return@use null
        val contained = listZoneBusinessLinks(zone)
        zone.copy(
            landCount = contained.lands.size,
            buildingCount = contained.buildings.size,
            lands = contained.lands,
            buildings = contained.buildings
        )
    }

    fun getZonePartySummary(id: String): ZonePartySummaryDto? {
        val zone = getZone(id) ?: return null
        val landIds = zone.lands.map { it.id }
        val buildingIds = zone.buildings.map { it.id }
        val containedCount = landIds.size + buildingIds.size
        if (landIds.isEmpty() && buildingIds.isEmpty()) {
            return ZonePartySummaryDto(zoneId = id, containedCount = 0, partyCount = 0)
        }
        data class PartyAcc(
            val id: String,
            val name: String,
            val partyType: String,
            val tags: List<String>,
            val targets: MutableSet<String> = mutableSetOf(),
            val relationTypes: MutableSet<String> = mutableSetOf()
        )
        return dataSource.connection.use { connection ->
            val targetConds = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            if (landIds.isNotEmpty()) {
                targetConds.add("(r.target_type = 'land' AND r.target_id = ANY(?))")
                binders.add { stmt, index -> stmt.setArray(index, connection.createArrayOf("text", landIds.toTypedArray())) }
            }
            if (buildingIds.isNotEmpty()) {
                targetConds.add("(r.target_type = 'building' AND r.target_id = ANY(?))")
                binders.add { stmt, index -> stmt.setArray(index, connection.createArrayOf("text", buildingIds.toTypedArray())) }
            }
            val accById = linkedMapOf<String, PartyAcc>()
            connection.prepareStatement(
                """
                SELECT p.id, p.name, p.party_type, p.tags, r.target_type, r.target_id, r.relation_type
                FROM app.party_relationships AS r
                JOIN app.parties AS p ON p.id = r.party_id
                WHERE ${targetConds.joinToString(" OR ")}
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.executeQuery().use { rs ->
                    while (rs.next()) {
                        val partyId = rs.getString("id")
                        val acc = accById.getOrPut(partyId) {
                            PartyAcc(
                                id = partyId,
                                name = rs.getString("name"),
                                partyType = rs.getString("party_type"),
                                tags = rs.textArray("tags")
                            )
                        }
                        acc.targets.add("${rs.getString("target_type")}:${rs.getString("target_id")}")
                        rs.getString("relation_type")?.let { acc.relationTypes.add(it) }
                    }
                }
            }

            val projectInvolvement = mutableMapOf<String, Int>()
            if (accById.isNotEmpty()) {
                connection.prepareStatement(
                    """
                    SELECT party_id, count(DISTINCT (target_type, target_id)) AS cnt
                    FROM app.party_relationships
                    WHERE party_id = ANY(?)
                    GROUP BY party_id
                    """.trimIndent()
                ).use { stmt ->
                    stmt.setArray(1, connection.createArrayOf("text", accById.keys.toTypedArray()))
                    stmt.executeQuery().use { rs ->
                        while (rs.next()) projectInvolvement[rs.getString("party_id")] = rs.getInt("cnt")
                    }
                }
            }

            val parties = accById.values
                .map { acc ->
                    val zoneInvolvement = acc.targets.size
                    ZonePartySummaryEntryDto(
                        id = acc.id,
                        name = acc.name,
                        partyType = acc.partyType,
                        tags = acc.tags,
                        zoneInvolvement = zoneInvolvement,
                        projectInvolvement = projectInvolvement[acc.id] ?: zoneInvolvement,
                        relationTypes = acc.relationTypes.sorted(),
                        coverageRatio = if (containedCount > 0) zoneInvolvement.toDouble() / containedCount else 0.0
                    )
                }
                .sortedWith(compareByDescending<ZonePartySummaryEntryDto> { it.zoneInvolvement }.thenBy { it.id })

            val typeBreakdown = parties.groupingBy { it.partyType }.eachCount()
                .map { (key, count) -> ZonePartyBreakdownDto(key, count) }
                .sortedWith(compareByDescending<ZonePartyBreakdownDto> { it.count }.thenBy { it.key })
            val tagBreakdown = parties.flatMap { it.tags }.groupingBy { it }.eachCount()
                .map { (key, count) -> ZonePartyBreakdownDto(key, count) }
                .sortedWith(compareByDescending<ZonePartyBreakdownDto> { it.count }.thenBy { it.key })

            ZonePartySummaryDto(
                zoneId = id,
                containedCount = containedCount,
                partyCount = parties.size,
                typeBreakdown = typeBreakdown,
                tagBreakdown = tagBreakdown,
                parties = parties
            )
        }
    }

    fun createZone(request: JsonObject): ZoneDto = try {
        val id = readRequiredText(request, "id")
        val projectId = readRequiredUuid(request, "projectId")
        val name = readRequiredText(request, "name")
        val zoneType = readOptionalText(request, "zoneType")
        val status = readOptionalText(request, "status") ?: "有効"
        val memo = readOptionalText(request, "memo")
        val zoneLayerId = readOptionalUuid(request, "zoneLayerId") ?: readRequiredUuid(request, "sourceLayerId")
        val zoneFeatureId = readOptionalText(request, "zoneFeatureId") ?: readRequiredText(request, "sourceFeatureId")
        validateZoneFeature(projectId, zoneLayerId, zoneFeatureId)
        dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO app.zones (
                    id, project_id, name, zone_type, status, memo,
                    zone_layer_id, zone_feature_id, source_layer_id, source_feature_id
                )
                VALUES (?, ?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?::uuid, ?)
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, id)
                stmt.setString(2, projectId)
                stmt.setString(3, name)
                setNullableString(stmt, 4, zoneType)
                stmt.setString(5, status)
                setNullableString(stmt, 6, memo)
                stmt.setString(7, zoneLayerId)
                stmt.setString(8, zoneFeatureId)
                stmt.setString(9, zoneLayerId)
                stmt.setString(10, zoneFeatureId)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getZone(rs.getString("id")) ?: error("Created zone disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone create failed: ${exc.message ?: "invalid zone create"}")
    }

    fun updateZone(id: String, request: JsonObject): ZoneDto = try {
        dataSource.connection.use { connection ->
            val existing = getZone(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "name", "name", setters, binders, required = true)
            addTextPatch(request, "zoneType", "zone_type", setters, binders)
            addTextPatch(request, "status", "status", setters, binders, required = true)
            addTextPatch(request, "memo", "memo", setters, binders)
            if (setters.isEmpty()) {
                return@use existing
            }

            val updatedId = connection.prepareStatement(
                """
                UPDATE app.zones
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.setString(binders.size + 1, id)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) {
                        throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
                    }
                    rs.getString("id")
                }
            }
            getZone(updatedId) ?: error("Updated zone disappeared")
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone update failed: ${exc.message ?: "invalid zone update"}")
    }

    fun deleteZone(id: String) {
        dataSource.connection.use { connection ->
            val deleted = connection.prepareStatement("DELETE FROM app.zones WHERE id = ?").use { stmt ->
                stmt.setString(1, id)
                stmt.executeUpdate()
            }
            if (deleted == 0) {
                throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
            }
        }
    }

    fun createZoneLayerFromImport(request: ZoneLayerFromImportRequest): ZoneLayerOperationDto {
        val requestedLayerId = request.layerId.trim().takeIf { it.isNotEmpty() }
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "layerId is required")
        val sourceLayer = getLayer(requestedLayerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
        val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: sourceLayer.projectId
        if (sourceLayer.projectId != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Layer does not belong to the selected project")
        }
        validateZoneSourceLayerGeometry(sourceLayer)

        val layerName = request.name?.trim()?.takeIf { it.isNotEmpty() } ?: "${sourceLayer.name} 区域"
        val tableName = generatedTableName("zone_buffer")
        return dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                createSourceZoneBufferTable(
                    connection = connection,
                    tableName = tableName,
                    sourceLayer = sourceLayer,
                    layerName = layerName
                )
                normalizeGeneratedTable(connection, "gis_data", tableName, "geom")
                val count = connection.prepareStatement("SELECT count(*)::int FROM ${quoteIdent("gis_data")}.${quoteIdent(tableName)}").use { stmt ->
                    stmt.executeQuery().use { rs ->
                        rs.next()
                        rs.getInt(1)
                    }
                }
                if (count == 0) {
                    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Source layer has no point or polygon geometry")
                }
                val layerId = insertLayerMetadata(
                    connection = connection,
                    projectId = projectId,
                    name = layerName,
                    tableName = tableName,
                    sourceSrid = 3857,
                    isResult = false,
                    layerRole = "zone",
                    sourceLayerId = sourceLayer.id
                )
                val layer = getLayerInConnection(connection, layerId)
                    ?: throw ApiException(io.ktor.http.HttpStatusCode.InternalServerError, "Created layer disappeared")
                val counts = syncZonesForLayer(
                    connection = connection,
                    layer = layer,
                    zoneType = request.zoneType,
                    status = request.status,
                    nameField = "name"
                )
                connection.commit()
                val createdLayer = getLayer(layerId) ?: error("Created layer disappeared")
                ZoneLayerOperationDto(
                    layer = createdLayer,
                    zonesCreated = counts.created,
                    zonesUpdated = counts.updated,
                    zones = listZones(
                        ZoneListQuery(
                            projectId = projectId,
                            q = null,
                            status = null,
                            zoneType = null,
                            linkedOnly = false,
                            zoneLayerId = layerId,
                            sourceLayerId = null
                        )
                    )
                )
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer generation failed: ${exc.message ?: "invalid zone layer generation"}")
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    private fun listZoneBusinessLinks(zone: ZoneDto): BusinessLinksDto {
        val landLinks = listLands(
            LandListQuery(
                projectId = zone.projectId,
                q = null,
                status = null,
                landUse = null,
                partyType = null,
                relationType = null,
                linkedOnly = true,
                sourceLayerId = null,
                bbox = null,
                intersectsLayerId = zone.zoneLayerId,
                intersectsFeatureId = zone.zoneFeatureId,
                distanceMeters = null
            )
        ).map { land -> BusinessEntityLinkDto(land.id, "${land.lotNumber} · ${land.address}") }
        val buildingLinks = listBuildings(
            BuildingListQuery(
                projectId = zone.projectId,
                q = null,
                landId = null,
                status = null,
                buildingUse = null,
                partyType = null,
                relationType = null,
                linkedOnly = true,
                sourceLayerId = null,
                bbox = null,
                intersectsLayerId = zone.zoneLayerId,
                intersectsFeatureId = zone.zoneFeatureId,
                distanceMeters = null
            )
        ).map { building -> BusinessEntityLinkDto(building.id, building.name) }
        return BusinessLinksDto(lands = landLinks, buildings = buildingLinks)
    }

    private fun validateZoneFeature(projectId: String, zoneLayerId: String, zoneFeatureId: String) {
        val layer = getLayer(zoneLayerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "zoneLayerId not found")
        if (layer.projectId != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "zoneLayerId belongs to another project")
        }
        val layerGeometryType = layer.geometryType.uppercase()
        if (!layerGeometryType.contains("POLYGON") && layerGeometryType != "GEOMETRY") {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer must be a polygon layer")
        }
        val feature = getFeature(zoneLayerId, zoneFeatureId)
        val featureGeometryType = feature.geometry?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull?.uppercase()
        if (featureGeometryType?.contains("POLYGON") != true) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone feature must be a polygon")
        }
    }

    fun listLands(query: LandListQuery): List<LandDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
        if (!query.projectId.isNullOrBlank()) {
            filters.add("l.project_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, query.projectId) }
        }
        if (textQuery != null) {
            filters.add(
                """
                (
                    lower(${landSearchTextSql("l")}) LIKE lower(?)
                    OR EXISTS (
                        SELECT 1
                        FROM app.party_relationships AS r
                        JOIN app.parties AS p ON p.id = r.party_id
                        WHERE r.project_id = l.project_id
                          AND r.target_type = 'land'
                          AND r.target_id = l.id
                          AND lower(${relationshipSearchTextSql("r", "p")}) LIKE lower(?)
                    )
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        }
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("l.status ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        query.landUse?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("l.land_use ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        addRelationshipListFilter(
            targetType = "land",
            targetIdExpression = "l.id",
            projectIdExpression = "l.project_id",
            partyType = query.partyType,
            relationType = query.relationType,
            filters = filters,
            binders = binders
        )
        addBusinessListSpatialFilters(
            entityAlias = "l",
            projectId = query.projectId,
            linkedOnly = query.linkedOnly,
            sourceLayerId = query.sourceLayerId,
            bbox = query.bbox,
            intersectsLayerId = query.intersectsLayerId,
            intersectsFeatureId = query.intersectsFeatureId,
            distanceMeters = query.distanceMeters,
            filters = filters,
            binders = binders
        )
        val sql = """
            SELECT l.id, l.project_id::text, l.lot_number, l.address, l.land_use, l.area_sqm,
                   l.registered_owner, l.right_type, l.registration_cause, l.registration_accepted_on::text,
                   l.status, l.memo, l.source_layer_id::text, l.source_feature_id
            FROM app.lands AS l
            ${whereClause(filters)}
            ORDER BY l.id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                val items = buildList {
                    while (rs.next()) add(rs.toLandDto())
                }
                items.map { land ->
                    land.copy(
                        buildings = listBuildingLinksForLand(connection, land.id),
                        relationships = listRelationshipsForTarget(connection, "land", land.id)
                    )
                }
            }
        }
    }

    fun getLand(id: String): LandDto? = dataSource.connection.use { connection ->
        val land = connection.prepareStatement(
            """
            SELECT id, project_id::text, lot_number, address, land_use, area_sqm,
                   registered_owner, right_type, registration_cause, registration_accepted_on::text,
                   status, memo, source_layer_id::text, source_feature_id
            FROM app.lands
            WHERE id = ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toLandDto()
            }
        } ?: return@use null
        land.copy(
            buildings = listBuildingLinksForLand(connection, id),
            relationships = listRelationshipsForTarget(connection, "land", id)
        )
    }

    fun createLand(request: JsonObject): LandDto = try {
        dataSource.connection.use { connection ->
            val id = readRequiredText(request, "id")
            val projectId = readRequiredUuid(request, "projectId")
            val lotNumber = readRequiredText(request, "lotNumber")
            val address = readRequiredText(request, "address")
            val landUse = readOptionalText(request, "landUse")
            val areaSqm = readOptionalDouble(request, "areaSqm")
            val registeredOwner = readOptionalText(request, "registeredOwner")
            val rightType = readOptionalText(request, "rightType")
            val registrationCause = readOptionalText(request, "registrationCause")
            val registrationAcceptedOn = readOptionalDate(request, "registrationAcceptedOn")
            val status = readOptionalText(request, "status") ?: "調査中"
            val memo = readOptionalText(request, "memo")
            val sourceLayerId = readOptionalUuid(request, "sourceLayerId")
            val sourceFeatureId = readOptionalText(request, "sourceFeatureId")
            connection.prepareStatement(
                """
                INSERT INTO app.lands (
                    id, project_id, lot_number, address, land_use, area_sqm,
                    registered_owner, right_type, registration_cause, registration_accepted_on,
                    status, memo, source_layer_id, source_feature_id
                )
                VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?::uuid, ?)
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, id)
                stmt.setString(2, projectId)
                stmt.setString(3, lotNumber)
                stmt.setString(4, address)
                setNullableString(stmt, 5, landUse)
                if (areaSqm == null) stmt.setNull(6, Types.DOUBLE) else stmt.setDouble(6, areaSqm)
                setNullableString(stmt, 7, registeredOwner)
                setNullableString(stmt, 8, rightType)
                setNullableString(stmt, 9, registrationCause)
                setNullableDateString(stmt, 10, registrationAcceptedOn)
                stmt.setString(11, status)
                setNullableString(stmt, 12, memo)
                setNullableUuidString(stmt, 13, sourceLayerId)
                setNullableString(stmt, 14, sourceFeatureId)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getLand(rs.getString("id")) ?: error("Created land disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Land create failed: ${exc.message ?: "invalid land create"}")
    }

    fun updateLand(id: String, request: JsonObject): LandDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "lotNumber", "lot_number", setters, binders, required = true)
            addTextPatch(request, "address", "address", setters, binders, required = true)
            addTextPatch(request, "landUse", "land_use", setters, binders)
            addDoublePatch(request, "areaSqm", "area_sqm", setters, binders)
            addTextPatch(request, "registeredOwner", "registered_owner", setters, binders)
            addTextPatch(request, "rightType", "right_type", setters, binders)
            addTextPatch(request, "registrationCause", "registration_cause", setters, binders)
            addDatePatch(request, "registrationAcceptedOn", "registration_accepted_on", setters, binders)
            addTextPatch(request, "status", "status", setters, binders, required = true)
            addTextPatch(request, "memo", "memo", setters, binders)
            addUuidPatch(request, "sourceLayerId", "source_layer_id", setters, binders)
            addTextPatch(request, "sourceFeatureId", "source_feature_id", setters, binders)
            if (setters.isEmpty()) {
                return@use getLand(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Land not found")
            }

            val updated = connection.prepareStatement(
                """
                UPDATE app.lands
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?
                RETURNING id, project_id::text, lot_number, address, land_use, area_sqm, status, memo,
                          registered_owner, right_type, registration_cause, registration_accepted_on::text,
                          source_layer_id::text, source_feature_id
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.setString(binders.size + 1, id)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) {
                        throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Land not found")
                    }
                    rs.toLandDto()
                }
            }
            updated.copy(
                buildings = listBuildingLinksForLand(connection, id),
                relationships = listRelationshipsForTarget(connection, "land", id)
            )
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Land update failed: ${exc.message ?: "invalid land update"}")
    }

    fun deleteLand(id: String) {
        dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                connection.prepareStatement("UPDATE app.buildings SET land_id = NULL, updated_at = now() WHERE land_id = ?").use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeUpdate()
                }
                connection.prepareStatement("DELETE FROM app.party_relationships WHERE target_type = 'land' AND target_id = ?").use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeUpdate()
                }
                val deleted = connection.prepareStatement("DELETE FROM app.lands WHERE id = ?").use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeUpdate()
                }
                if (deleted == 0) {
                    throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Land not found")
                }
                connection.commit()
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Land delete failed: ${exc.message ?: "invalid land delete"}")
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    fun listBuildings(query: BuildingListQuery): List<BuildingDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
        if (!query.projectId.isNullOrBlank()) {
            filters.add("b.project_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, query.projectId) }
        }
        if (!query.landId.isNullOrBlank()) {
            filters.add("b.land_id = ?")
            binders.add { stmt, index -> stmt.setString(index, query.landId) }
        }
        if (textQuery != null) {
            filters.add(
                """
                (
                    lower(${buildingSearchTextSql("b", "l")}) LIKE lower(?)
                    OR EXISTS (
                        SELECT 1
                        FROM app.party_relationships AS r
                        JOIN app.parties AS p ON p.id = r.party_id
                        WHERE r.project_id = b.project_id
                          AND r.target_type = 'building'
                          AND r.target_id = b.id
                          AND lower(${relationshipSearchTextSql("r", "p")}) LIKE lower(?)
                    )
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        }
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("b.status ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        query.buildingUse?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("b.building_use ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        addRelationshipListFilter(
            targetType = "building",
            targetIdExpression = "b.id",
            projectIdExpression = "b.project_id",
            partyType = query.partyType,
            relationType = query.relationType,
            filters = filters,
            binders = binders
        )
        addBusinessListSpatialFilters(
            entityAlias = "b",
            projectId = query.projectId,
            linkedOnly = query.linkedOnly,
            sourceLayerId = query.sourceLayerId,
            bbox = query.bbox,
            intersectsLayerId = query.intersectsLayerId,
            intersectsFeatureId = query.intersectsFeatureId,
            distanceMeters = query.distanceMeters,
            filters = filters,
            binders = binders
        )
        val sql = """
            SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
                   b.name, b.building_location, b.house_number, b.building_use, b.floors,
                   b.total_floor_area_sqm, b.structure, b.registered_owner, b.right_type,
                   b.registration_accepted_on::text, b.status, b.memo, b.source_layer_id::text, b.source_feature_id
            FROM app.buildings AS b
            LEFT JOIN app.lands AS l ON l.id = b.land_id
            ${whereClause(filters)}
            ORDER BY b.id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                val items = buildList {
                    while (rs.next()) add(rs.toBuildingDto())
                }
                items.map { building ->
                    building.copy(relationships = listRelationshipsForTarget(connection, "building", building.id))
                }
            }
        }
    }

    fun getBuilding(id: String): BuildingDto? = dataSource.connection.use { connection ->
        val building = connection.prepareStatement(
            """
            SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
                   b.name, b.building_location, b.house_number, b.building_use, b.floors,
                   b.total_floor_area_sqm, b.structure, b.registered_owner, b.right_type,
                   b.registration_accepted_on::text, b.status, b.memo, b.source_layer_id::text, b.source_feature_id
            FROM app.buildings AS b
            LEFT JOIN app.lands AS l ON l.id = b.land_id
            WHERE b.id = ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toBuildingDto()
            }
        } ?: return@use null
        building.copy(relationships = listRelationshipsForTarget(connection, "building", id))
    }

    fun createBuilding(request: JsonObject): BuildingDto = try {
        dataSource.connection.use { connection ->
            val id = readRequiredText(request, "id")
            val projectId = readRequiredUuid(request, "projectId")
            val landId = readOptionalText(request, "landId")
            val name = readRequiredText(request, "name")
            val buildingLocation = readOptionalText(request, "buildingLocation")
            val houseNumber = readOptionalText(request, "houseNumber")
            val buildingUse = readOptionalText(request, "buildingUse")
            val floors = readOptionalInt(request, "floors")
            val totalFloorAreaSqm = readOptionalDouble(request, "totalFloorAreaSqm")
            val structure = readOptionalText(request, "structure")
            val registeredOwner = readOptionalText(request, "registeredOwner")
            val rightType = readOptionalText(request, "rightType")
            val registrationAcceptedOn = readOptionalDate(request, "registrationAcceptedOn")
            val status = readOptionalText(request, "status") ?: "調査中"
            val memo = readOptionalText(request, "memo")
            val sourceLayerId = readOptionalUuid(request, "sourceLayerId")
            val sourceFeatureId = readOptionalText(request, "sourceFeatureId")
            connection.prepareStatement(
                """
                INSERT INTO app.buildings (
                    id, project_id, land_id, name, building_location, house_number,
                    building_use, floors, total_floor_area_sqm, structure,
                    registered_owner, right_type, registration_accepted_on,
                    status, memo, source_layer_id, source_feature_id
                )
                VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?::uuid, ?)
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, id)
                stmt.setString(2, projectId)
                setNullableString(stmt, 3, landId)
                stmt.setString(4, name)
                setNullableString(stmt, 5, buildingLocation)
                setNullableString(stmt, 6, houseNumber)
                setNullableString(stmt, 7, buildingUse)
                if (floors == null) stmt.setNull(8, Types.INTEGER) else stmt.setInt(8, floors)
                if (totalFloorAreaSqm == null) stmt.setNull(9, Types.DOUBLE) else stmt.setDouble(9, totalFloorAreaSqm)
                setNullableString(stmt, 10, structure)
                setNullableString(stmt, 11, registeredOwner)
                setNullableString(stmt, 12, rightType)
                setNullableDateString(stmt, 13, registrationAcceptedOn)
                stmt.setString(14, status)
                setNullableString(stmt, 15, memo)
                setNullableUuidString(stmt, 16, sourceLayerId)
                setNullableString(stmt, 17, sourceFeatureId)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getBuilding(rs.getString("id")) ?: error("Created building disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Building create failed: ${exc.message ?: "invalid building create"}")
    }

    fun updateBuilding(id: String, request: JsonObject): BuildingDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "landId", "land_id", setters, binders)
            addTextPatch(request, "name", "name", setters, binders, required = true)
            addTextPatch(request, "buildingLocation", "building_location", setters, binders)
            addTextPatch(request, "houseNumber", "house_number", setters, binders)
            addTextPatch(request, "buildingUse", "building_use", setters, binders)
            addIntPatch(request, "floors", "floors", setters, binders)
            addDoublePatch(request, "totalFloorAreaSqm", "total_floor_area_sqm", setters, binders)
            addTextPatch(request, "structure", "structure", setters, binders)
            addTextPatch(request, "registeredOwner", "registered_owner", setters, binders)
            addTextPatch(request, "rightType", "right_type", setters, binders)
            addDatePatch(request, "registrationAcceptedOn", "registration_accepted_on", setters, binders)
            addTextPatch(request, "status", "status", setters, binders, required = true)
            addTextPatch(request, "memo", "memo", setters, binders)
            addUuidPatch(request, "sourceLayerId", "source_layer_id", setters, binders)
            addTextPatch(request, "sourceFeatureId", "source_feature_id", setters, binders)
            if (setters.isEmpty()) {
                return@use getBuilding(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Building not found")
            }

            val updatedId = connection.prepareStatement(
                """
                UPDATE app.buildings
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.setString(binders.size + 1, id)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) {
                        throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Building not found")
                    }
                    rs.getString("id")
                }
            }
            getBuilding(updatedId) ?: error("Updated building disappeared")
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Building update failed: ${exc.message ?: "invalid building update"}")
    }

    fun deleteBuilding(id: String) {
        dataSource.connection.use { connection ->
            val previousAutoCommit = connection.autoCommit
            connection.autoCommit = false
            try {
                connection.prepareStatement("DELETE FROM app.party_relationships WHERE target_type = 'building' AND target_id = ?").use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeUpdate()
                }
                val deleted = connection.prepareStatement("DELETE FROM app.buildings WHERE id = ?").use { stmt ->
                    stmt.setString(1, id)
                    stmt.executeUpdate()
                }
                if (deleted == 0) {
                    throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Building not found")
                }
                connection.commit()
            } catch (exc: ApiException) {
                connection.rollback()
                throw exc
            } catch (exc: SQLException) {
                connection.rollback()
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Building delete failed: ${exc.message ?: "invalid building delete"}")
            } finally {
                connection.autoCommit = previousAutoCommit
            }
        }
    }

    fun listParties(query: PartyListQuery): List<PartyDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
        if (!query.projectId.isNullOrBlank()) {
            filters.add("p.project_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, query.projectId) }
        }
        if (textQuery != null) {
            filters.add(
                """
                (
                    lower(${partySearchTextSql("p")}) LIKE lower(?)
                    OR EXISTS (
                        SELECT 1
                        FROM app.party_relationships AS r
                        LEFT JOIN app.lands AS l ON r.target_type = 'land' AND l.id = r.target_id
                        LEFT JOIN app.buildings AS b ON r.target_type = 'building' AND b.id = r.target_id
                        WHERE r.party_id = p.id
                          AND lower(${partyRelationshipTargetSearchTextSql("r", "l", "b")}) LIKE lower(?)
                    )
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
            binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        }
        query.partyType?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
            filters.add("p.party_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$value%") }
        }
        val relationType = query.relationType?.trim()?.takeIf { it.isNotEmpty() }
        val targetType = query.targetType?.trim()?.takeIf { it.isNotEmpty() }
        if (query.linkedOnly || relationType != null || targetType != null) {
            val relationshipFilters = mutableListOf("r.party_id = p.id")
            if (relationType != null) {
                relationshipFilters.add("r.relation_type ILIKE ?")
                binders.add { stmt, index -> stmt.setString(index, "%$relationType%") }
            }
            if (targetType != null) {
                if (targetType !in setOf("land", "building")) {
                    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetType must be land or building")
                }
                relationshipFilters.add("r.target_type = ?")
                binders.add { stmt, index -> stmt.setString(index, targetType) }
            }
            filters.add(
                """
                EXISTS (
                    SELECT 1
                    FROM app.party_relationships AS r
                    WHERE ${relationshipFilters.joinToString(" AND ")}
                )
                """.trimIndent()
            )
        }
        val sql = """
            SELECT p.id, p.project_id::text, p.name, p.party_type, p.contact, p.address, p.memo, p.tags
            FROM app.parties AS p
            ${whereClause(filters)}
            ORDER BY p.id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                val items = buildList {
                    while (rs.next()) add(rs.toPartyDto())
                }
                items.map { party -> party.copy(relationships = listRelationshipsForParty(connection, party.id)) }
            }
        }
    }

    fun getParty(id: String): PartyDto? = dataSource.connection.use { connection ->
        val party = connection.prepareStatement(
            """
            SELECT id, project_id::text, name, party_type, contact, address, memo, tags
            FROM app.parties
            WHERE id = ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toPartyDto()
            }
        } ?: return@use null
        party.copy(relationships = listRelationshipsForParty(connection, id))
    }

    fun createParty(request: JsonObject): PartyDto = try {
        dataSource.connection.use { connection ->
            val id = readRequiredText(request, "id")
            val projectId = readRequiredUuid(request, "projectId")
            val name = readRequiredText(request, "name")
            val partyType = readRequiredText(request, "partyType")
            val contact = readOptionalText(request, "contact")
            val address = readOptionalText(request, "address")
            val memo = readOptionalText(request, "memo")
            val tags = readTextArray(request, "tags") ?: emptyList()
            connection.prepareStatement(
                """
                INSERT INTO app.parties (id, project_id, name, party_type, contact, address, memo, tags)
                VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, id)
                stmt.setString(2, projectId)
                stmt.setString(3, name)
                stmt.setString(4, partyType)
                setNullableString(stmt, 5, contact)
                setNullableString(stmt, 6, address)
                setNullableString(stmt, 7, memo)
                stmt.setArray(8, connection.createArrayOf("text", tags.toTypedArray()))
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getParty(rs.getString("id")) ?: error("Created party disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party create failed: ${exc.message ?: "invalid party create"}")
    }

    fun updateParty(id: String, request: JsonObject): PartyDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "name", "name", setters, binders, required = true)
            addTextPatch(request, "partyType", "party_type", setters, binders, required = true)
            addTextPatch(request, "contact", "contact", setters, binders)
            addTextPatch(request, "address", "address", setters, binders)
            addTextPatch(request, "memo", "memo", setters, binders)
            addTextArrayPatch(request, "tags", "tags", setters, binders)
            if (setters.isEmpty()) {
                return@use getParty(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
            }

            val updated = connection.prepareStatement(
                """
                UPDATE app.parties
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?
                RETURNING id, project_id::text, name, party_type, contact, address, memo, tags
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.setString(binders.size + 1, id)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) {
                        throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
                    }
                    rs.toPartyDto()
                }
            }
            updated.copy(relationships = listRelationshipsForParty(connection, id))
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party update failed: ${exc.message ?: "invalid party update"}")
    }

    fun deleteParty(id: String) {
        dataSource.connection.use { connection ->
            val deleted = connection.prepareStatement("DELETE FROM app.parties WHERE id = ?").use { stmt ->
                stmt.setString(1, id)
                stmt.executeUpdate()
            }
            if (deleted == 0) {
                throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
            }
        }
    }

    fun createPartyRelationship(request: JsonObject): PartyRelationshipDto = try {
        dataSource.connection.use { connection ->
            val projectId = readRequiredUuid(request, "projectId")
            val partyId = readRequiredText(request, "partyId")
            val targetType = readRequiredTargetType(request, "targetType")
            val targetId = readRequiredText(request, "targetId")
            val relationType = readRequiredText(request, "relationType")
            val note = readOptionalText(request, "note")
            validateRelationshipTarget(connection, projectId, partyId, targetType, targetId)
            connection.prepareStatement(
                """
                INSERT INTO app.party_relationships (project_id, party_id, target_type, target_id, relation_type, note)
                VALUES (?::uuid, ?, ?, ?, ?, ?)
                RETURNING id::text
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, projectId)
                stmt.setString(2, partyId)
                stmt.setString(3, targetType)
                stmt.setString(4, targetId)
                stmt.setString(5, relationType)
                setNullableString(stmt, 6, note)
                stmt.executeQuery().use { rs ->
                    rs.next()
                    getPartyRelationship(connection, rs.getString("id")) ?: error("Created relationship disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Relationship create failed: ${exc.message ?: "invalid relationship create"}")
    }

    fun updatePartyRelationship(id: String, request: JsonObject): PartyRelationshipDto = try {
        dataSource.connection.use { connection ->
            val current = getPartyRelationship(connection, id)
                ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
            val partyId = readOptionalText(request, "partyId") ?: current.partyId
            val targetType = readOptionalTargetType(request, "targetType") ?: current.targetType
            val targetId = readOptionalText(request, "targetId") ?: current.targetId
            val relationType = readOptionalText(request, "relationType") ?: current.relationType
            val note = if ("note" in request) readOptionalText(request, "note") else current.note
            validateRelationshipTarget(connection, current.projectId, partyId, targetType, targetId)
            connection.prepareStatement(
                """
                UPDATE app.party_relationships
                SET party_id = ?, target_type = ?, target_id = ?, relation_type = ?, note = ?
                WHERE id = ?::uuid
                RETURNING id::text
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, partyId)
                stmt.setString(2, targetType)
                stmt.setString(3, targetId)
                stmt.setString(4, relationType)
                setNullableString(stmt, 5, note)
                stmt.setString(6, id)
                stmt.executeQuery().use { rs ->
                    if (!rs.next()) throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
                    getPartyRelationship(connection, rs.getString("id")) ?: error("Updated relationship disappeared")
                }
            }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Relationship update failed: ${exc.message ?: "invalid relationship update"}")
    }

    fun deletePartyRelationship(id: String) {
        dataSource.connection.use { connection ->
            val deleted = connection.prepareStatement("DELETE FROM app.party_relationships WHERE id = ?::uuid").use { stmt ->
                stmt.setString(1, id)
                stmt.executeUpdate()
            }
            if (deleted == 0) {
                throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
            }
        }
    }

    private fun withAttributes(connection: Connection, layers: List<LayerDto>): List<LayerDto> {
        if (layers.isEmpty()) return layers
        val byLayer = layers.associateBy { it.id }
        val attrs = layers.associate { it.id to mutableListOf<LayerAttributeDto>() }.toMutableMap()
        val placeholders = layers.joinToString(",") { "?::uuid" }
        connection.prepareStatement(
            """
            SELECT layer_id::text, name, data_type, ordinal_position
            FROM app.layer_attributes
            WHERE layer_id IN ($placeholders) AND is_geometry = false
            ORDER BY layer_id, ordinal_position
            """.trimIndent()
        ).use { stmt ->
            layers.forEachIndexed { index, layer -> stmt.setString(index + 1, layer.id) }
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    attrs.getValue(rs.getString("layer_id")).add(
                        LayerAttributeDto(
                            name = rs.getString("name"),
                            dataType = rs.getString("data_type"),
                            ordinalPosition = rs.getInt("ordinal_position")
                        )
                    )
                }
            }
        }
        return layers.map { byLayer.getValue(it.id).copy(attributes = attrs.getValue(it.id)) }
    }

    private fun getLayerInConnection(connection: Connection, id: String): LayerDto? =
        connection.prepareStatement(
            """
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.layer_role, l.result_set_id::text, rs.name AS result_set_name,
                   l.source_layer_id::text, l.tile_source_id, l.created_at::text
            FROM app.layers AS l
            LEFT JOIN app.result_sets AS rs ON rs.id = l.result_set_id
            WHERE l.id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else withAttributes(connection, listOf(rs.toLayerDto(emptyList()))).single()
            }
        }

    private fun validateZoneLayerGeometry(layer: LayerDto) {
        val geometryType = layer.geometryType.uppercase()
        if (!geometryType.contains("POLYGON") && geometryType != "GEOMETRY") {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer must be polygon geometry")
        }
    }

    private fun validateZoneSourceLayerGeometry(layer: LayerDto) {
        val geometryType = layer.geometryType.uppercase()
        if (!geometryType.contains("POINT") && !geometryType.contains("POLYGON") && geometryType != "GEOMETRY") {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Source layer must be point or polygon geometry")
        }
    }

    private fun syncZonesForLayer(
        connection: Connection,
        layer: LayerDto,
        zoneType: String?,
        status: String?,
        nameField: String?
    ): ZoneLayerSyncCounts {
        validateZoneLayerGeometry(layer)
        val tableRef = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
        val featureIdRef = "t.${quoteIdent(layer.featureIdColumn)}"
        val geometryRef = "t.${quoteIdent(layer.geometryColumn)}"
        val existingCount = connection.prepareStatement("SELECT count(*)::int FROM app.zones WHERE zone_layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
        val nameExpression = zoneNameExpression(layer, nameField)
        val normalizedStatus = status?.trim()?.takeIf { it.isNotEmpty() } ?: "有効"
        val normalizedZoneType = zoneType?.trim()?.takeIf { it.isNotEmpty() }
        val affected = connection.prepareStatement(
            """
            INSERT INTO app.zones (
                id, project_id, name, zone_type, status, memo,
                zone_layer_id, zone_feature_id, source_layer_id, source_feature_id
            )
            SELECT
                concat('Z-', replace(?::text, '-', ''), '-', $featureIdRef::text) AS id,
                ?::uuid AS project_id,
                COALESCE($nameExpression, concat('区域 ', $featureIdRef::text)) AS name,
                ? AS zone_type,
                ? AS status,
                NULL::text AS memo,
                ?::uuid AS zone_layer_id,
                $featureIdRef::text AS zone_feature_id,
                ?::uuid AS source_layer_id,
                $featureIdRef::text AS source_feature_id
            FROM $tableRef AS t
            WHERE $geometryRef IS NOT NULL
              AND GeometryType($geometryRef) ILIKE '%POLYGON%'
            ON CONFLICT (zone_layer_id, zone_feature_id) DO UPDATE
            SET name = EXCLUDED.name,
                zone_type = COALESCE(app.zones.zone_type, EXCLUDED.zone_type),
                status = COALESCE(app.zones.status, EXCLUDED.status),
                source_layer_id = EXCLUDED.source_layer_id,
                source_feature_id = EXCLUDED.source_feature_id,
                updated_at = now()
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layer.id)
            stmt.setString(2, layer.projectId)
            setNullableString(stmt, 3, normalizedZoneType)
            stmt.setString(4, normalizedStatus)
            stmt.setString(5, layer.id)
            stmt.setString(6, layer.id)
            stmt.executeUpdate()
        }
        val nextCount = connection.prepareStatement("SELECT count(*)::int FROM app.zones WHERE zone_layer_id = ?::uuid").use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
        val created = (nextCount - existingCount).coerceAtLeast(0)
        return ZoneLayerSyncCounts(created = created, updated = (affected - created).coerceAtLeast(0))
    }

    private fun zoneNameExpression(layer: LayerDto, requestedNameField: String?): String {
        val attributeNames = layer.attributes.map { it.name }.toSet()
        val requested = requestedNameField?.trim()?.takeIf { it.isNotEmpty() }
        if (requested != null && requested !in attributeNames) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown zone name field: $requested")
        }
        val candidates = buildList {
            if (requested != null) add(requested)
            addAll(listOf("name", "区域名", "title", "zone_name", "Name", "NAME"))
        }.distinct().filter { it in attributeNames }
        if (candidates.isEmpty()) return "NULL"
        return candidates.joinToString(", ") { "NULLIF(t.${quoteIdent(it)}::text, '')" }
    }

    private fun createSourceZoneBufferTable(
        connection: Connection,
        tableName: String,
        sourceLayer: LayerDto,
        layerName: String
    ) {
        val tableRef = "${quoteIdent("gis_data")}.${quoteIdent(tableName)}"
        val sourceRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
        val rawSourceGeom = "s.${quoteIdent(sourceLayer.geometryColumn)}"
        val sourceGeom = if (sourceLayer.displaySrid == 3857) rawSourceGeom else "ST_Transform($rawSourceGeom, 3857)"
        connection.createStatement().use { stmt ->
            stmt.execute("DROP TABLE IF EXISTS $tableRef")
        }
        val sql = """
            CREATE TABLE $tableRef AS
            WITH source_parts AS (
                SELECT ST_CollectionExtract(ST_MakeValid($sourceGeom), 3) AS geom
                FROM $sourceRef AS s
                WHERE $rawSourceGeom IS NOT NULL

                UNION ALL

                SELECT ST_CollectionExtract(ST_MakeValid($sourceGeom), 1) AS geom
                FROM $sourceRef AS s
                WHERE $rawSourceGeom IS NOT NULL
            ),
            source_geoms AS (
                SELECT geom
                FROM source_parts
                WHERE geom IS NOT NULL
                  AND NOT ST_IsEmpty(geom)
            ),
            merged AS (
                SELECT count(*)::integer AS source_feature_count,
                       ST_MemUnion(ST_Buffer(geom, ?::double precision)) AS geom
                FROM source_geoms
            )
            SELECT
                1::integer AS fid,
                ?::text AS name,
                'source_buffer'::text AS operation,
                ?::double precision AS buffer_meters,
                ?::uuid AS source_layer_id,
                source_feature_count,
                ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))::geometry(MultiPolygon, 3857) AS geom
            FROM merged
            WHERE geom IS NOT NULL
              AND NOT ST_IsEmpty(geom)
              AND source_feature_count > 0
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            stmt.setDouble(1, SOURCE_ZONE_BUFFER_METERS)
            stmt.setString(2, layerName)
            stmt.setDouble(3, SOURCE_ZONE_BUFFER_METERS)
            stmt.setString(4, sourceLayer.id)
            stmt.execute()
        }
    }

    private fun normalizeGeneratedTable(connection: Connection, schemaName: String, tableName: String, geometryColumn: String) {
        val tableRef = "${quoteIdent(schemaName)}.${quoteIdent(tableName)}"
        val geom = quoteIdent(geometryColumn)
        val indexName = quoteIdent("${tableName.take(48)}_geom_gix")
        connection.createStatement().use { stmt ->
            stmt.execute("UPDATE $tableRef SET $geom = ST_MakeValid($geom) WHERE $geom IS NOT NULL AND NOT ST_IsValid($geom)")
            stmt.execute("DELETE FROM $tableRef WHERE $geom IS NULL OR ST_IsEmpty($geom)")
            stmt.execute("CREATE INDEX IF NOT EXISTS $indexName ON $tableRef USING GIST ($geom)")
            stmt.execute("ANALYZE $tableRef")
        }
    }

    private fun insertLayerMetadata(
        connection: Connection,
        projectId: String,
        name: String,
        tableName: String,
        sourceSrid: Int?,
        isResult: Boolean,
        layerRole: String,
        resultSetId: String? = null,
        sourceLayerId: String? = null
    ): String {
        val stats = tableStats(connection, "gis_data", tableName, "geom")
        val layerId = connection.prepareStatement(
            """
            INSERT INTO app.layers (
                project_id, name, schema_name, table_name, geometry_column, geometry_type,
                source_srid, display_srid, feature_id_column, bbox_4326, row_count,
                is_result, layer_role, result_set_id, source_layer_id, tile_source_id
            )
            VALUES (?::uuid, ?, 'gis_data', ?, 'geom', ?, ?, 3857, 'fid', ?::jsonb, ?, ?, ?, ?::uuid, ?::uuid, ?)
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setString(2, name)
            stmt.setString(3, tableName)
            stmt.setString(4, stats.geometryType)
            if (sourceSrid == null) stmt.setNull(5, Types.INTEGER) else stmt.setInt(5, sourceSrid)
            setNullableString(stmt, 6, stats.bbox4326)
            stmt.setLong(7, stats.rowCount)
            stmt.setBoolean(8, isResult)
            stmt.setString(9, normalizeLayerRole(layerRole))
            setNullableUuidString(stmt, 10, resultSetId)
            setNullableUuidString(stmt, 11, sourceLayerId)
            stmt.setString(12, tableName)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
        insertLayerAttributes(connection, layerId, "gis_data", tableName)
        return layerId
    }

    private fun tableStats(connection: Connection, schemaName: String, tableName: String, geometryColumn: String): LayerStats {
        val tableRef = "${quoteIdent(schemaName)}.${quoteIdent(tableName)}"
        val geom = quoteIdent(geometryColumn)
        return connection.prepareStatement(
            """
            WITH stats AS (
                SELECT
                    count(*)::bigint AS row_count,
                    (array_agg(GeometryType($geom) ORDER BY GeometryType($geom)) FILTER (WHERE $geom IS NOT NULL))[1] AS geometry_type,
                    ST_Extent(ST_Transform($geom, 4326)) AS bbox
                FROM $tableRef
            )
            SELECT row_count,
                   COALESCE(geometry_type, 'GEOMETRY') AS geometry_type,
                   CASE
                       WHEN bbox IS NULL THEN NULL
                       ELSE jsonb_build_array(ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox))::text
                   END AS bbox_4326
            FROM stats
            """.trimIndent()
        ).use { stmt ->
            stmt.executeQuery().use { rs ->
                rs.next()
                LayerStats(
                    rowCount = rs.getLong("row_count"),
                    geometryType = rs.getString("geometry_type"),
                    bbox4326 = rs.getString("bbox_4326")
                )
            }
        }
    }

    private fun insertLayerAttributes(connection: Connection, layerId: String, schemaName: String, tableName: String) {
        connection.prepareStatement(
            """
            SELECT column_name, data_type, udt_name, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = ? AND table_name = ?
            ORDER BY ordinal_position
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, schemaName)
            stmt.setString(2, tableName)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    val isGeometry = rs.getString("column_name") == "geom" || rs.getString("udt_name") == "geometry"
                    connection.prepareStatement(
                        """
                        INSERT INTO app.layer_attributes (layer_id, name, data_type, ordinal_position, is_geometry)
                        VALUES (?::uuid, ?, ?, ?, ?)
                        ON CONFLICT (layer_id, name) DO UPDATE
                        SET data_type = EXCLUDED.data_type,
                            ordinal_position = EXCLUDED.ordinal_position,
                            is_geometry = EXCLUDED.is_geometry
                        """.trimIndent()
                    ).use { insert ->
                        insert.setString(1, layerId)
                        insert.setString(2, rs.getString("column_name"))
                        insert.setString(3, if (isGeometry) "geometry" else rs.getString("data_type"))
                        insert.setInt(4, rs.getInt("ordinal_position"))
                        insert.setBoolean(5, isGeometry)
                        insert.executeUpdate()
                    }
                }
            }
        }
    }

    private fun refreshLayerMetadata(connection: Connection, layer: LayerDto) {
        val tableRef = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
        val geometryColumn = quoteIdent(layer.geometryColumn)
        connection.prepareStatement(
            """
            WITH stats AS (
                SELECT
                    count(*)::bigint AS row_count,
                    (array_agg(GeometryType($geometryColumn) ORDER BY GeometryType($geometryColumn)) FILTER (WHERE $geometryColumn IS NOT NULL))[1] AS geometry_type,
                    ST_Extent(ST_Transform($geometryColumn, 4326)) AS bbox
                FROM $tableRef
            ),
            formatted AS (
                SELECT
                    row_count,
                    COALESCE(geometry_type, 'GEOMETRY') AS geometry_type,
                    CASE
                        WHEN bbox IS NULL THEN NULL
                        ELSE jsonb_build_array(ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox))
                    END AS bbox_4326
                FROM stats
            )
            UPDATE app.layers AS l
            SET row_count = formatted.row_count,
                geometry_type = formatted.geometry_type,
                bbox_4326 = formatted.bbox_4326
            FROM formatted
            WHERE l.id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, layer.id)
            stmt.executeUpdate()
        }
        connection.createStatement().use { stmt ->
            stmt.execute("ANALYZE $tableRef")
        }
    }

    private fun listBuildingLinksForLand(connection: Connection, landId: String): List<BusinessEntityLinkDto> =
        connection.prepareStatement(
            """
            SELECT id, name AS label
            FROM app.buildings
            WHERE land_id = ?
            ORDER BY id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, landId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(BusinessEntityLinkDto(rs.getString("id"), rs.getString("label")))
                }
            }
        }

    private fun listRelationshipsForTarget(connection: Connection, targetType: String, targetId: String): List<PartyRelationshipDto> =
        connection.prepareStatement(relationshipSelectSql("WHERE r.target_type = ? AND r.target_id = ? ORDER BY r.relation_type, p.name")).use { stmt ->
            stmt.setString(1, targetType)
            stmt.setString(2, targetId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toPartyRelationshipDto())
                }
            }
        }

    private fun listRelationshipsForParty(connection: Connection, partyId: String): List<PartyRelationshipDto> =
        connection.prepareStatement(relationshipSelectSql("WHERE r.party_id = ? ORDER BY r.target_type, r.target_id")).use { stmt ->
            stmt.setString(1, partyId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toPartyRelationshipDto())
                }
            }
        }

    private fun getPartyRelationship(connection: Connection, id: String): PartyRelationshipDto? =
        connection.prepareStatement(relationshipSelectSql("WHERE r.id = ?::uuid")).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) null else rs.toPartyRelationshipDto()
            }
        }

    private fun validateRelationshipTarget(
        connection: Connection,
        projectId: String,
        partyId: String,
        targetType: String,
        targetId: String
    ) {
        val partyProject = connection.prepareStatement("SELECT project_id::text FROM app.parties WHERE id = ?").use { stmt ->
            stmt.setString(1, partyId)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        } ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "partyId does not exist")
        if (partyProject != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party belongs to another project")
        }
        val targetProjectSql = when (targetType) {
            "land" -> "SELECT project_id::text FROM app.lands WHERE id = ?"
            "building" -> "SELECT project_id::text FROM app.buildings WHERE id = ?"
            else -> throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetType must be land or building")
        }
        val targetProject = connection.prepareStatement(targetProjectSql).use { stmt ->
            stmt.setString(1, targetId)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        } ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetId does not exist")
        if (targetProject != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Target belongs to another project")
        }
    }

    private fun relationshipSelectSql(where: String): String = """
        SELECT r.id::text, r.project_id::text, r.party_id, p.name AS party_name,
               r.target_type, r.target_id,
               CASE
                   WHEN r.target_type = 'land' THEN concat(l.lot_number, ' · ', l.address)
                   WHEN r.target_type = 'building' THEN b.name
                   ELSE NULL
               END AS target_label,
               r.relation_type, r.note
        FROM app.party_relationships AS r
        JOIN app.parties AS p ON p.id = r.party_id
        LEFT JOIN app.lands AS l ON r.target_type = 'land' AND l.id = r.target_id
        LEFT JOIN app.buildings AS b ON r.target_type = 'building' AND b.id = r.target_id
        $where
    """.trimIndent()

    private fun landSearchTextSql(alias: String): String =
        """
        (
            coalesce($alias.id, '') || ' ' ||
            coalesce($alias.lot_number, '') || ' ' ||
            coalesce($alias.address, '') || ' ' ||
            coalesce($alias.land_use, '') || ' ' ||
            coalesce($alias.status, '') || ' ' ||
            coalesce($alias.memo, '') || ' ' ||
            coalesce($alias.registered_owner, '') || ' ' ||
            coalesce($alias.right_type, '') || ' ' ||
            coalesce($alias.registration_cause, '') || ' ' ||
            coalesce($alias.registration_accepted_on::text, '')
        )
        """.trimIndent()

    private fun buildingSearchTextSql(alias: String, landAlias: String): String =
        """
        (
            coalesce($alias.id, '') || ' ' ||
            coalesce($alias.name, '') || ' ' ||
            coalesce($alias.building_location, '') || ' ' ||
            coalesce($alias.house_number, '') || ' ' ||
            coalesce($alias.building_use, '') || ' ' ||
            coalesce($alias.structure, '') || ' ' ||
            coalesce($alias.status, '') || ' ' ||
            coalesce($alias.memo, '') || ' ' ||
            coalesce($alias.registered_owner, '') || ' ' ||
            coalesce($alias.right_type, '') || ' ' ||
            coalesce($alias.registration_accepted_on::text, '') || ' ' ||
            coalesce($landAlias.id, '') || ' ' ||
            coalesce($landAlias.lot_number, '') || ' ' ||
            coalesce($landAlias.address, '')
        )
        """.trimIndent()

    private fun partySearchTextSql(alias: String): String =
        """
        (
            coalesce($alias.id, '') || ' ' ||
            coalesce($alias.name, '') || ' ' ||
            coalesce($alias.party_type, '') || ' ' ||
            coalesce($alias.contact, '') || ' ' ||
            coalesce($alias.address, '') || ' ' ||
            coalesce($alias.memo, '')
        )
        """.trimIndent()

    private fun relationshipSearchTextSql(relationAlias: String, partyAlias: String): String =
        """
        (
            coalesce($relationAlias.relation_type, '') || ' ' ||
            coalesce($relationAlias.note, '') || ' ' ||
            coalesce($partyAlias.id, '') || ' ' ||
            coalesce($partyAlias.name, '') || ' ' ||
            coalesce($partyAlias.party_type, '') || ' ' ||
            coalesce($partyAlias.contact, '') || ' ' ||
            coalesce($partyAlias.address, '') || ' ' ||
            coalesce($partyAlias.memo, '')
        )
        """.trimIndent()

    private fun partyRelationshipTargetSearchTextSql(relationAlias: String, landAlias: String, buildingAlias: String): String =
        """
        (
            coalesce($relationAlias.relation_type, '') || ' ' ||
            coalesce($relationAlias.note, '') || ' ' ||
            coalesce($relationAlias.target_type, '') || ' ' ||
            coalesce($relationAlias.target_id, '') || ' ' ||
            coalesce($landAlias.lot_number, '') || ' ' ||
            coalesce($landAlias.address, '') || ' ' ||
            coalesce($landAlias.registered_owner, '') || ' ' ||
            coalesce($buildingAlias.name, '') || ' ' ||
            coalesce($buildingAlias.building_location, '') || ' ' ||
            coalesce($buildingAlias.house_number, '') || ' ' ||
            coalesce($buildingAlias.registered_owner, '')
        )
        """.trimIndent()

    private fun addRelationshipListFilter(
        targetType: String,
        targetIdExpression: String,
        projectIdExpression: String,
        partyType: String?,
        relationType: String?,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val requestedPartyType = partyType?.trim()?.takeIf { it.isNotEmpty() }
        val requestedRelationType = relationType?.trim()?.takeIf { it.isNotEmpty() }
        if (requestedPartyType == null && requestedRelationType == null) return
        val relationshipFilters = mutableListOf(
            "r.project_id = $projectIdExpression",
            "r.target_type = '$targetType'",
            "r.target_id = $targetIdExpression"
        )
        if (requestedPartyType != null) {
            relationshipFilters.add("p.party_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$requestedPartyType%") }
        }
        if (requestedRelationType != null) {
            relationshipFilters.add("r.relation_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$requestedRelationType%") }
        }
        filters.add(
            """
            EXISTS (
                SELECT 1
                FROM app.party_relationships AS r
                JOIN app.parties AS p ON p.id = r.party_id
                WHERE ${relationshipFilters.joinToString(" AND ")}
            )
            """.trimIndent()
        )
    }

    private fun addBusinessListSpatialFilters(
        entityAlias: String,
        projectId: String?,
        linkedOnly: Boolean,
        sourceLayerId: String?,
        bbox: String?,
        intersectsLayerId: String?,
        intersectsFeatureId: String?,
        distanceMeters: Double?,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val requestedSourceLayerId = sourceLayerId?.trim()?.takeIf { it.isNotEmpty() }
        if (linkedOnly) {
            filters.add("$entityAlias.source_layer_id IS NOT NULL AND $entityAlias.source_feature_id IS NOT NULL")
        }
        if (requestedSourceLayerId != null) {
            filters.add("$entityAlias.source_layer_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, requestedSourceLayerId) }
        }

        val bboxBounds = parseBbox(bbox)
        val targetLayerId = intersectsLayerId?.trim()?.takeIf { it.isNotEmpty() }
        val targetFeatureId = intersectsFeatureId?.trim()?.takeIf { it.isNotEmpty() }
        if (bboxBounds == null && (targetLayerId == null || targetFeatureId == null)) return

        val sourceLayers = resolveSpatialSourceLayers(projectId, requestedSourceLayerId)
        val targetLayer = if (targetLayerId != null && targetFeatureId != null) {
            getLayer(targetLayerId) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "intersectsLayerId not found")
        } else {
            null
        }
        if (projectId != null && targetLayer != null && targetLayer.projectId != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "intersectsLayerId belongs to another project")
        }

        val spatialClauses = mutableListOf<String>()
        val spatialBinders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        for (sourceLayer in sourceLayers) {
            val sourceTableRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
            val sourceFeatureIdRef = "src.${quoteIdent(sourceLayer.featureIdColumn)}"
            val sourceGeomRef = "src.${quoteIdent(sourceLayer.geometryColumn)}"
            val clauseBinders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            val joins = StringBuilder()
            var targetGeomRef: String? = null
            if (targetLayer != null && targetFeatureId != null) {
                val targetTableRef = "${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)}"
                val targetFeatureIdRef = "target.${quoteIdent(targetLayer.featureIdColumn)}"
                joins.append(" JOIN $targetTableRef AS target ON $targetFeatureIdRef::text = ?")
                clauseBinders.add { stmt, index -> stmt.setString(index, targetFeatureId) }
                val rawTargetGeom = "target.${quoteIdent(targetLayer.geometryColumn)}"
                targetGeomRef = if (targetLayer.displaySrid == sourceLayer.displaySrid) {
                    rawTargetGeom
                } else {
                    "ST_Transform($rawTargetGeom, ${sourceLayer.displaySrid})"
                }
            }
            if (bboxBounds != null) {
                if (joins.isNotEmpty()) joins.append('\n')
                joins.append(
                    """
                    CROSS JOIN (
                        SELECT ST_Transform(ST_MakeEnvelope(?::double precision, ?::double precision, ?::double precision, ?::double precision, 4326), ${sourceLayer.displaySrid}) AS geom
                    ) AS bbox
                    """.trimIndent()
                )
                clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[0]) }
                clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[1]) }
                clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[2]) }
                clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[3]) }
            }
            val geometryFilters = mutableListOf(
                "$entityAlias.source_layer_id = ?::uuid",
                "$entityAlias.source_feature_id = $sourceFeatureIdRef::text",
                "$sourceGeomRef IS NOT NULL"
            )
            clauseBinders.add { stmt, index -> stmt.setString(index, sourceLayer.id) }
            if (bboxBounds != null) {
                geometryFilters.add("$sourceGeomRef && bbox.geom")
                geometryFilters.add("ST_Intersects($sourceGeomRef, bbox.geom)")
            }
            if (targetGeomRef != null) {
                geometryFilters.add("target.${quoteIdent(targetLayer!!.geometryColumn)} IS NOT NULL")
                if (distanceMeters != null && distanceMeters > 0.0) {
                    geometryFilters.add("ST_DWithin($sourceGeomRef, $targetGeomRef, ?::double precision)")
                    clauseBinders.add { stmt, index -> stmt.setDouble(index, distanceMeters) }
                } else {
                    geometryFilters.add("$sourceGeomRef && $targetGeomRef")
                    geometryFilters.add("ST_Intersects($sourceGeomRef, $targetGeomRef)")
                }
            }
            spatialClauses.add(
                """
                EXISTS (
                    SELECT 1
                    FROM $sourceTableRef AS src
                    $joins
                    WHERE ${geometryFilters.joinToString(" AND ")}
                )
                """.trimIndent()
            )
            spatialBinders.addAll(clauseBinders)
        }
        if (spatialClauses.isEmpty()) {
            filters.add("false")
        } else {
            filters.add(spatialClauses.joinToString(separator = "\nOR\n", prefix = "(", postfix = ")"))
            binders.addAll(spatialBinders)
        }
    }

    private fun resolveSpatialSourceLayers(projectId: String?, sourceLayerId: String?): List<LayerDto> {
        if (sourceLayerId != null) {
            val layer = getLayer(sourceLayerId)
                ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "sourceLayerId not found")
            if (projectId != null && layer.projectId != projectId) {
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "sourceLayerId belongs to another project")
            }
            return listOf(layer)
        }
        return listLayers(projectId).filter { !it.isResult && it.layerRole != "zone" }
    }

    private fun businessGeometrySql(
        sourceLayers: List<LayerDto>,
        projectId: String,
        sourceTypes: Set<String>,
        request: BusinessSpatialSearchRequest
    ): SqlFragment {
        val selects = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        for (sourceLayer in sourceLayers) {
            val tableRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
            val featureIdRef = "src.${quoteIdent(sourceLayer.featureIdColumn)}"
            val geometryRef = "src.${quoteIdent(sourceLayer.geometryColumn)}"
            if ("land" in sourceTypes) {
                val landFilters = mutableListOf(
                    "l.project_id = ?::uuid",
                    "l.source_layer_id = ?::uuid",
                    "l.source_feature_id IS NOT NULL",
                    "$geometryRef IS NOT NULL"
                )
                val landBinders = mutableListOf<(PreparedStatement, Int) -> Unit>(
                    { stmt, index -> stmt.setString(index, projectId) },
                    { stmt, index -> stmt.setString(index, sourceLayer.id) }
                )
                addBusinessQueryFilter(
                    request.businessQuery,
                    "concat_ws(' ', l.id, l.lot_number, l.address, l.land_use, l.status, l.memo)",
                    landFilters,
                    landBinders
                )
                addBusinessChoiceFilter(request.status, "l.status", landFilters, landBinders)
                addBusinessChoiceFilter(request.landUse, "l.land_use", landFilters, landBinders)
                addPartyRelationshipFilter("land", "l.id", "l.project_id", request, landFilters, landBinders)
                selects.add(
                    """
                    SELECT
                        'land' AS business_type,
                        l.id AS business_id,
                        concat(l.lot_number, ' · ', l.address) AS business_label,
                        $geometryRef AS geom
                    FROM app.lands AS l
                    JOIN $tableRef AS src ON l.source_feature_id = $featureIdRef::text
                    WHERE ${landFilters.joinToString(" AND ")}
                    """.trimIndent()
                )
                binders.addAll(landBinders)
            }
            if ("building" in sourceTypes) {
                val buildingFilters = mutableListOf(
                    "b.project_id = ?::uuid",
                    "b.source_layer_id = ?::uuid",
                    "b.source_feature_id IS NOT NULL",
                    "$geometryRef IS NOT NULL"
                )
                val buildingBinders = mutableListOf<(PreparedStatement, Int) -> Unit>(
                    { stmt, index -> stmt.setString(index, projectId) },
                    { stmt, index -> stmt.setString(index, sourceLayer.id) }
                )
                addBusinessQueryFilter(
                    request.businessQuery,
                    "concat_ws(' ', b.id, b.name, b.building_use, b.structure, b.status, b.memo, l.lot_number, l.address)",
                    buildingFilters,
                    buildingBinders
                )
                addBusinessChoiceFilter(request.status, "b.status", buildingFilters, buildingBinders)
                addBusinessChoiceFilter(request.buildingUse, "b.building_use", buildingFilters, buildingBinders)
                addPartyRelationshipFilter("building", "b.id", "b.project_id", request, buildingFilters, buildingBinders)
                selects.add(
                    """
                    SELECT
                        'building' AS business_type,
                        b.id AS business_id,
                        b.name AS business_label,
                        $geometryRef AS geom
                    FROM app.buildings AS b
                    LEFT JOIN app.lands AS l ON l.id = b.land_id
                    JOIN $tableRef AS src ON b.source_feature_id = $featureIdRef::text
                    WHERE ${buildingFilters.joinToString(" AND ")}
                    """.trimIndent()
                )
                binders.addAll(buildingBinders)
            }
        }
        return SqlFragment(selects.joinToString("\nUNION ALL\n"), binders)
    }

    private fun addBusinessQueryFilter(
        query: String?,
        textExpression: String,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val value = query?.trim()?.takeIf { it.isNotEmpty() } ?: return
        filters.add("lower($textExpression) LIKE lower(?)")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }

    private fun addBusinessChoiceFilter(
        value: String?,
        columnExpression: String,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val choice = value?.trim()?.takeIf { it.isNotEmpty() } ?: return
        filters.add("$columnExpression ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, choice) }
    }

    private fun addPartyRelationshipFilter(
        targetType: String,
        targetIdExpression: String,
        projectIdExpression: String,
        request: BusinessSpatialSearchRequest,
        filters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        val partyQuery = request.partyQuery?.trim()?.takeIf { it.isNotEmpty() }
        val partyType = request.partyType?.trim()?.takeIf { it.isNotEmpty() }
        val relationType = request.relationType?.trim()?.takeIf { it.isNotEmpty() }
        if (partyQuery == null && partyType == null && relationType == null) return

        val relationshipFilters = mutableListOf(
            "r.project_id = $projectIdExpression",
            "r.target_type = '$targetType'",
            "r.target_id = $targetIdExpression"
        )
        if (partyQuery != null) {
            relationshipFilters.add("lower(concat_ws(' ', p.id, p.name, p.party_type, p.contact, p.address, p.memo)) LIKE lower(?)")
            binders.add { stmt, index -> stmt.setString(index, "%$partyQuery%") }
        }
        if (partyType != null) {
            relationshipFilters.add("p.party_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$partyType%") }
        }
        if (relationType != null) {
            relationshipFilters.add("r.relation_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$relationType%") }
        }
        filters.add(
            """
            EXISTS (
                SELECT 1
                FROM app.party_relationships AS r
                JOIN app.parties AS p ON p.id = r.party_id
                WHERE ${relationshipFilters.joinToString(" AND ")}
            )
            """.trimIndent()
        )
    }

    private fun spatialPredicateSql(
        targetGeometryExpression: String,
        sourceGeometryExpression: String,
        operator: String,
        distanceMeters: Double?
    ): SqlFragment = when (operator) {
        "contains" -> SqlFragment(
            "$targetGeometryExpression && $sourceGeometryExpression AND ST_Contains($targetGeometryExpression, $sourceGeometryExpression)"
        )
        "within" -> SqlFragment(
            "$targetGeometryExpression && $sourceGeometryExpression AND ST_Within($targetGeometryExpression, $sourceGeometryExpression)"
        )
        "dwithin" -> SqlFragment(
            """
            $targetGeometryExpression && ST_Expand($sourceGeometryExpression, ?::double precision)
            AND ST_DWithin($targetGeometryExpression, $sourceGeometryExpression, ?::double precision)
            """.trimIndent(),
            listOf(
                { stmt, index -> stmt.setDouble(index, distanceMeters ?: 0.0) },
                { stmt, index -> stmt.setDouble(index, distanceMeters ?: 0.0) }
            )
        )
        else -> SqlFragment(
            "$targetGeometryExpression && $sourceGeometryExpression AND ST_Intersects($targetGeometryExpression, $sourceGeometryExpression)"
        )
    }

    private fun decodeBusinessEntityLinks(value: String?): List<BusinessEntityLinkDto> =
        value?.takeIf { it.isNotBlank() }?.let { json.decodeFromString<List<BusinessEntityLinkDto>>(it) } ?: emptyList()

    private fun whereClause(filters: List<String>): String =
        if (filters.isEmpty()) "" else "WHERE ${filters.joinToString(" AND ")}"

    private fun isNumericType(dataType: String): Boolean =
        dataType.lowercase() in setOf(
            "smallint",
            "integer",
            "bigint",
            "numeric",
            "decimal",
            "real",
            "double precision"
        )

    private fun normalizeLayerRole(value: String?): String {
        val role = value?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "generic"
        if (role !in setOf("generic", "zone")) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "layerRole must be generic or zone")
        }
        return role
    }

    private fun generatedTableName(prefix: String): String =
        "${prefix}_${UUID.randomUUID().toString().replace("-", "").take(24)}"

    private fun addTextPatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>,
        required: Boolean = false
    ) {
        if (key !in request) return
        val value = readTextPatch(request, key, required)
        setters.add("${quoteIdent(column)} = ?")
        binders.add { stmt, index ->
            if (value == null) stmt.setNull(index, Types.VARCHAR) else stmt.setString(index, value)
        }
    }

    private fun readTextArray(request: JsonObject, key: String): List<String>? {
        val element = request[key] ?: return null
        if (element is JsonNull) return emptyList()
        val array = try {
            element.jsonArray
        } catch (exc: IllegalArgumentException) {
            return null
        }
        return array.mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.ifBlank { null } }.distinct()
    }

    private fun addTextArrayPatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        if (key !in request) return
        val value = readTextArray(request, key) ?: emptyList()
        setters.add("${quoteIdent(column)} = ?")
        binders.add { stmt, index ->
            stmt.setArray(index, stmt.connection.createArrayOf("text", value.toTypedArray()))
        }
    }

    private fun addUuidPatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        if (key !in request) return
        val value = readUuidPatch(request, key)
        setters.add("${quoteIdent(column)} = ?::uuid")
        binders.add { stmt, index ->
            if (value == null) stmt.setNull(index, Types.OTHER) else stmt.setString(index, value)
        }
    }

    private fun addDatePatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        if (key !in request) return
        val value = readOptionalDate(request, key)
        setters.add("${quoteIdent(column)} = ?::date")
        binders.add { stmt, index -> setNullableDateString(stmt, index, value) }
    }

    private fun addDoublePatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        if (key !in request) return
        val value = readDoublePatch(request, key)
        setters.add("${quoteIdent(column)} = ?")
        binders.add { stmt, index ->
            if (value == null) stmt.setNull(index, Types.DOUBLE) else stmt.setDouble(index, value)
        }
    }

    private fun addIntPatch(
        request: JsonObject,
        key: String,
        column: String,
        setters: MutableList<String>,
        binders: MutableList<(PreparedStatement, Int) -> Unit>
    ) {
        if (key !in request) return
        val value = readIntPatch(request, key)
        setters.add("${quoteIdent(column)} = ?")
        binders.add { stmt, index ->
            if (value == null) stmt.setNull(index, Types.INTEGER) else stmt.setInt(index, value)
        }
    }

    private fun bindPatchValues(stmt: PreparedStatement, binders: List<(PreparedStatement, Int) -> Unit>) {
        binders.forEachIndexed { index, binder -> binder(stmt, index + 1) }
    }

    private fun readTextPatch(request: JsonObject, key: String, required: Boolean): String? {
        val element = request[key] ?: return null
        if (element is JsonNull) {
            if (required) throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")
            return null
        }
        val value = try {
            element.jsonPrimitive.contentOrNull
        } catch (exc: IllegalArgumentException) {
            null
        }
        if (required && value.isNullOrBlank()) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")
        }
        return value?.trim()?.ifBlank { null }
    }

    private fun readRequiredText(request: JsonObject, key: String): String =
        readTextPatch(request, key, required = true)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

    private fun readOptionalText(request: JsonObject, key: String): String? =
        readTextPatch(request, key, required = false)

    private fun readRequiredUuid(request: JsonObject, key: String): String =
        readOptionalUuid(request, key)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

    private fun readOptionalUuid(request: JsonObject, key: String): String? =
        readUuidPatch(request, key)

    private fun readOptionalDouble(request: JsonObject, key: String): Double? =
        if (key in request) readDoublePatch(request, key) else null

    private fun readOptionalInt(request: JsonObject, key: String): Int? =
        if (key in request) readIntPatch(request, key) else null

    private fun readRequiredTargetType(request: JsonObject, key: String): String =
        readOptionalTargetType(request, key)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

    private fun readOptionalTargetType(request: JsonObject, key: String): String? {
        val value = readOptionalText(request, key) ?: return null
        if (value !in setOf("land", "building")) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be land or building")
        }
        return value
    }

    private fun readUuidPatch(request: JsonObject, key: String): String? {
        val value = readTextPatch(request, key, required = false) ?: return null
        try {
            UUID.fromString(value)
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be a UUID")
        }
        return value
    }

    private fun readDoublePatch(request: JsonObject, key: String): Double? {
        val element = request[key] ?: return null
        if (element is JsonNull) return null
        val primitive = try {
            element.jsonPrimitive
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be a number")
        }
        val text = primitive.contentOrNull?.trim()
        if (text.isNullOrEmpty()) return null
        return primitive.doubleOrNull ?: text.toDoubleOrNull()
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be a number")
    }

    private fun readIntPatch(request: JsonObject, key: String): Int? {
        val element = request[key] ?: return null
        if (element is JsonNull) return null
        val primitive = try {
            element.jsonPrimitive
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be an integer")
        }
        val text = primitive.contentOrNull?.trim()
        if (text.isNullOrEmpty()) return null
        return primitive.intOrNull ?: text.toIntOrNull()
            ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be an integer")
    }

    private fun readOptionalDate(request: JsonObject, key: String): String? {
        val value = readOptionalText(request, key) ?: return null
        try {
            LocalDate.parse(value)
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be YYYY-MM-DD")
        }
        return value
    }

    private fun parseBbox(value: String?): DoubleArray? {
        val raw = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val parts = raw.split(",").map { it.trim().toDoubleOrNull() }
        if (parts.size != 4 || parts.any { it == null }) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "bbox must be minLng,minLat,maxLng,maxLat")
        }
        val minLng = parts[0]!!
        val minLat = parts[1]!!
        val maxLng = parts[2]!!
        val maxLat = parts[3]!!
        if (minLng >= maxLng || minLat >= maxLat) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "bbox bounds are invalid")
        }
        return doubleArrayOf(minLng, minLat, maxLng, maxLat)
    }

    private fun setNullableString(stmt: PreparedStatement, index: Int, value: String?) {
        if (value == null) stmt.setNull(index, Types.VARCHAR) else stmt.setString(index, value)
    }

    private fun setNullableUuidString(stmt: PreparedStatement, index: Int, value: String?) {
        if (value == null) stmt.setNull(index, Types.OTHER) else stmt.setString(index, value)
    }

    private fun setNullableDateString(stmt: PreparedStatement, index: Int, value: String?) {
        if (value == null) stmt.setNull(index, Types.DATE) else stmt.setString(index, value)
    }

    private fun ResultSet.toLandDto(): LandDto = LandDto(
        id = getString("id"),
        projectId = getString("project_id"),
        lotNumber = getString("lot_number"),
        address = getString("address"),
        landUse = getString("land_use"),
        areaSqm = nullableDouble("area_sqm"),
        registeredOwner = getString("registered_owner"),
        rightType = getString("right_type"),
        registrationCause = getString("registration_cause"),
        registrationAcceptedOn = getString("registration_accepted_on"),
        status = getString("status"),
        memo = getString("memo"),
        sourceLayerId = getString("source_layer_id"),
        sourceFeatureId = getString("source_feature_id")
    )

    private fun ResultSet.toBuildingDto(): BuildingDto = BuildingDto(
        id = getString("id"),
        projectId = getString("project_id"),
        landId = getString("land_id"),
        landLabel = getString("land_label"),
        name = getString("name"),
        buildingLocation = getString("building_location"),
        houseNumber = getString("house_number"),
        buildingUse = getString("building_use"),
        floors = nullableInt("floors"),
        totalFloorAreaSqm = nullableDouble("total_floor_area_sqm"),
        structure = getString("structure"),
        registeredOwner = getString("registered_owner"),
        rightType = getString("right_type"),
        registrationAcceptedOn = getString("registration_accepted_on"),
        status = getString("status"),
        memo = getString("memo"),
        sourceLayerId = getString("source_layer_id"),
        sourceFeatureId = getString("source_feature_id")
    )

    private fun ResultSet.toPartyDto(): PartyDto = PartyDto(
        id = getString("id"),
        projectId = getString("project_id"),
        name = getString("name"),
        partyType = getString("party_type"),
        contact = getString("contact"),
        address = getString("address"),
        memo = getString("memo"),
        tags = textArray("tags")
    )

    private fun ResultSet.toZoneDto(): ZoneDto = ZoneDto(
        id = getString("id"),
        projectId = getString("project_id"),
        name = getString("name"),
        zoneType = getString("zone_type"),
        status = getString("status"),
        memo = getString("memo"),
        zoneLayerId = getString("zone_layer_id"),
        zoneFeatureId = getString("zone_feature_id"),
        sourceLayerId = getString("source_layer_id"),
        sourceFeatureId = getString("source_feature_id")
    )

    private fun ResultSet.toPartyRelationshipDto(): PartyRelationshipDto = PartyRelationshipDto(
        id = getString("id"),
        projectId = getString("project_id"),
        partyId = getString("party_id"),
        partyName = getString("party_name"),
        targetType = getString("target_type"),
        targetId = getString("target_id"),
        targetLabel = getString("target_label"),
        relationType = getString("relation_type"),
        note = getString("note")
    )

    private fun ResultSet.textArray(column: String): List<String> {
        val array = getArray(column) ?: return emptyList()
        @Suppress("UNCHECKED_CAST")
        val values = array.array as? Array<Any?> ?: return emptyList()
        return values.mapNotNull { it as? String }
    }

    private fun ResultSet.nullableDouble(column: String): Double? =
        (getObject(column) as Number?)?.toDouble()

    private fun ResultSet.nullableInt(column: String): Int? =
        (getObject(column) as Number?)?.toInt()

    private fun ResultSet.toImportJobDto(): ImportJobDto = ImportJobDto(
        id = getString("id"),
        projectId = getString("project_id"),
        filename = getString("filename"),
        format = getString("format"),
        sourceSrid = getObject("source_srid") as Int?,
        status = getString("status"),
        errorMessage = getString("error_message"),
        layerId = getString("layer_id"),
        layerRole = getString("layer_role"),
        createdAt = getString("created_at"),
        startedAt = getString("started_at"),
        finishedAt = getString("finished_at")
    )

    private fun ResultSet.toLayerDto(attributes: List<LayerAttributeDto>): LayerDto = LayerDto(
        id = getString("id"),
        projectId = getString("project_id"),
        name = getString("name"),
        schemaName = getString("schema_name"),
        tableName = getString("table_name"),
        geometryColumn = getString("geometry_column"),
        geometryType = getString("geometry_type"),
        sourceSrid = getObject("source_srid") as Int?,
        displaySrid = getInt("display_srid"),
        featureIdColumn = getString("feature_id_column"),
        bbox4326 = getString("bbox_4326")?.let { json.decodeFromString<List<Double>>(it) },
        rowCount = getLong("row_count"),
        isResult = getBoolean("is_result"),
        layerRole = getString("layer_role"),
        resultSetId = getString("result_set_id"),
        resultSetName = getString("result_set_name"),
        sourceLayerId = getString("source_layer_id"),
        tileSourceId = getString("tile_source_id"),
        attributes = attributes,
        createdAt = getString("created_at")
    )

    private fun ResultSet.toDeletedLayerRef(): DeletedLayerRef = DeletedLayerRef(
        id = getString("id"),
        schemaName = getString("schema_name"),
        tableName = getString("table_name"),
        resultSetId = getString("result_set_id")
    )

    private fun ResultSet.toAnalysisJobDto(): AnalysisJobDto = AnalysisJobDto(
        id = getString("id"),
        projectId = getString("project_id"),
        name = getString("name"),
        criteria = json.parseToJsonElement(getString("criteria")).jsonObject,
        status = getString("status"),
        errorMessage = getString("error_message"),
        resultLayerId = getString("result_layer_id"),
        resultSetId = getString("result_set_id"),
        resultCount = getObject("result_count") as Long?,
        createdAt = getString("created_at"),
        startedAt = getString("started_at"),
        finishedAt = getString("finished_at")
    )
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
