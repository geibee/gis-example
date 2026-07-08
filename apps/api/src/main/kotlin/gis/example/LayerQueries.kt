// インポートジョブとレイヤ (app.layers) の CRUD・削除トランザクション・メタデータ管理

package gis.example

import java.sql.Connection
import java.sql.SQLException
import java.sql.Types
import java.util.UUID

fun Database.createImportJob(
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

fun Database.getImportJob(id: String): ImportJobDto? = dataSource.connection.use { connection ->
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

fun Database.listLayers(projectId: String?): List<LayerDto> = dataSource.connection.use { connection ->
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

fun Database.getLayer(id: String): LayerDto? = dataSource.connection.use { connection ->
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

fun Database.listAttributeValues(layerId: String, field: String, limit: Int): List<String> {
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

fun Database.deleteLayer(id: String) {
    try {
        withTransaction { connection ->
            val layer = loadDeletedLayerForUpdate(connection, id)
                ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
            deleteLayerInTransaction(connection, layer)
            layer.resultSetId?.let { deleteResultSetIfEmpty(connection, it) }
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Layer delete failed: ${exc.message ?: "invalid layer delete"}")
    }
}

fun Database.deleteResultSet(id: String) {
    try {
        withTransaction { connection ->
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
        }
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Result set delete failed: ${exc.message ?: "invalid result set delete"}")
    }
}

private fun Database.loadDeletedLayerForUpdate(connection: Connection, id: String): DeletedLayerRef? =
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

private fun Database.listDeletedLayersForResultSet(connection: Connection, resultSetId: String): List<DeletedLayerRef> =
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

private fun Database.deleteLayerInTransaction(connection: Connection, layer: DeletedLayerRef) {
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

private fun Database.deleteResultSetIfEmpty(connection: Connection, resultSetId: String) {
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

private fun Database.deleteResultSetRecord(connection: Connection, resultSetId: String, requireExisting: Boolean = true) {
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

private fun Database.withAttributes(connection: Connection, layers: List<LayerDto>): List<LayerDto> {
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

internal fun Database.getLayerInConnection(connection: Connection, id: String): LayerDto? =
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

internal fun Database.normalizeGeneratedTable(connection: Connection, schemaName: String, tableName: String, geometryColumn: String) {
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

internal fun Database.insertLayerMetadata(
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

private fun Database.tableStats(connection: Connection, schemaName: String, tableName: String, geometryColumn: String): LayerStats {
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

private fun Database.insertLayerAttributes(connection: Connection, layerId: String, schemaName: String, tableName: String) {
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

internal fun Database.refreshLayerMetadata(connection: Connection, layer: LayerDto) {
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

private fun Database.normalizeLayerRole(value: String?): String {
    val role = value?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: "generic"
    if (role !in setOf("generic", "zone")) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "layerRole must be generic or zone")
    }
    return role
}

internal fun Database.generatedTableName(prefix: String): String =
    "${prefix}_${UUID.randomUUID().toString().replace("-", "").take(24)}"
