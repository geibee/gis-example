package gis.example

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.postgresql.util.PGobject
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import java.util.UUID

class Database(private val dataSource: HikariDataSource) : AutoCloseable {
    companion object {
        private val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

        fun fromEnv(): Database {
            val config = HikariConfig().apply {
                jdbcUrl = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
                username = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
                password = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"
                maximumPoolSize = (System.getenv("DATABASE_POOL_SIZE") ?: "10").toInt()
                poolName = "web-gis-api"
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

    fun createImportJob(
        projectId: String?,
        filename: String,
        format: String,
        sourceSrid: Int?,
        uploadPath: String
    ): ImportJobDto {
        val resolvedProjectId = projectId ?: defaultProjectId()
        return dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path)
                VALUES (?::uuid, ?, ?, ?, ?)
                RETURNING id::text
                """.trimIndent()
            ).use { stmt ->
                stmt.setString(1, resolvedProjectId)
                stmt.setString(2, filename)
                stmt.setString(3, format)
                if (sourceSrid == null) stmt.setNull(4, java.sql.Types.INTEGER) else stmt.setInt(4, sourceSrid)
                stmt.setString(5, uploadPath)
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
                   error_message, layer_id::text, created_at::text, started_at::text, finished_at::text
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
            SELECT id::text, project_id::text, name, schema_name, table_name, geometry_column,
                   geometry_type, source_srid, display_srid, feature_id_column,
                   bbox_4326::text, row_count, is_result, tile_source_id, created_at::text
            FROM app.layers
            ORDER BY created_at DESC
            """.trimIndent()
        } else {
            """
            SELECT id::text, project_id::text, name, schema_name, table_name, geometry_column,
                   geometry_type, source_srid, display_srid, feature_id_column,
                   bbox_4326::text, row_count, is_result, tile_source_id, created_at::text
            FROM app.layers
            WHERE project_id = ?::uuid
            ORDER BY created_at DESC
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
            SELECT id::text, project_id::text, name, schema_name, table_name, geometry_column,
                   geometry_type, source_srid, display_srid, feature_id_column,
                   bbox_4326::text, row_count, is_result, tile_source_id, created_at::text
            FROM app.layers
            WHERE id = ?::uuid
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
        val criteriaJson = json.encodeToString(request.copy(projectId = projectId))
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
                   result_layer_id::text, result_count, created_at::text, started_at::text, finished_at::text
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

    private fun ResultSet.toImportJobDto(): ImportJobDto = ImportJobDto(
        id = getString("id"),
        projectId = getString("project_id"),
        filename = getString("filename"),
        format = getString("format"),
        sourceSrid = getObject("source_srid") as Int?,
        status = getString("status"),
        errorMessage = getString("error_message"),
        layerId = getString("layer_id"),
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
        tileSourceId = getString("tile_source_id"),
        attributes = attributes,
        createdAt = getString("created_at")
    )

    private fun ResultSet.toAnalysisJobDto(): AnalysisJobDto = AnalysisJobDto(
        id = getString("id"),
        projectId = getString("project_id"),
        name = getString("name"),
        criteria = json.parseToJsonElement(getString("criteria")).jsonObject,
        status = getString("status"),
        errorMessage = getString("error_message"),
        resultLayerId = getString("result_layer_id"),
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
