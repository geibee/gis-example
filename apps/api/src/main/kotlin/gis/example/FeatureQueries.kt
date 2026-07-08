// レイヤ内フィーチャの取得・検索・更新と MVT タイル生成

package gis.example

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.sql.PreparedStatement
import java.sql.SQLException

fun Database.getFeature(layerId: String, featureId: String): FeatureDto {
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
                    properties = databaseJson.parseToJsonElement(rs.getString("properties")).jsonObject,
                    geometry = rs.getString("geometry")?.let { databaseJson.parseToJsonElement(it) }
                )
            }
        }
    }
}

fun Database.searchFeatures(
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
                                properties = databaseJson.parseToJsonElement(rs.getString("properties")).jsonObject,
                                geometry = rs.getString("geometry")?.let { databaseJson.parseToJsonElement(it) },
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

fun Database.updateFeature(layerId: String, featureId: String, request: FeatureUpdateRequest): FeatureDto {
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

    return try {
        withTransaction { connection ->
            val updated = connection.prepareStatement(sql).use { stmt ->
                var index = 1
                stmt.setString(index++, databaseJson.encodeToString(filteredProperties))
                if (geometry != null) {
                    stmt.setString(index++, databaseJson.encodeToString(geometry))
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
                        properties = databaseJson.parseToJsonElement(rs.getString("properties")).jsonObject,
                        geometry = rs.getString("geometry")?.let { databaseJson.parseToJsonElement(it) }
                    )
                }
            }
            if (geometry != null) {
                refreshLayerMetadata(connection, layer)
            }
            updated
        }
    } catch (exc: SQLException) {
        throw ApiException(
            io.ktor.http.HttpStatusCode.BadRequest,
            "Feature update failed: ${exc.message ?: "invalid feature update"}"
        )
    }
}

fun Database.getMvtTile(layerId: String, z: Int, x: Int, y: Int): ByteArray {
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
