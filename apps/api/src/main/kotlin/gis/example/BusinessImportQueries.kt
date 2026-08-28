// 取込済み GIS レイヤから土地・建物の業務レコードを同期する橋渡し。
// 形状は gis_data のレイヤ契約に残し、app.lands / app.buildings には参照だけを保持する。
package gis.example

import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.sql.Connection
import java.sql.SQLException

private val landImportFields = linkedMapOf(
    "lotNumber" to listOf("lot_number", "lotnumber", "parcel_no", "parcel_number", "parcel_id", "land_id", "地番", "筆番号"),
    "address" to listOf("address", "location", "所在地", "住所"),
    "landUse" to listOf("land_use", "landuse", "usage", "use", "地目", "用途"),
    "areaSqm" to listOf("area_sqm", "area_m2", "area", "地積", "面積"),
    "registeredOwner" to listOf("registered_owner", "owner", "登記名義人", "所有者"),
    "rightType" to listOf("right_type", "権利種別"),
    "registrationCause" to listOf("registration_cause", "登記原因"),
    "status" to listOf("status", "ステータス"),
    "memo" to listOf("memo", "note", "備考", "メモ")
)

private val buildingImportFields = linkedMapOf(
    "landId" to listOf("land_id", "parcel_id", "土地id", "土地ID"),
    "name" to listOf("building_name", "name", "title", "building_id", "建物名", "名称"),
    "buildingLocation" to listOf("building_location", "location", "address", "所在", "所在地"),
    "houseNumber" to listOf("house_number", "building_number", "家屋番号"),
    "buildingUse" to listOf("building_use", "usage", "use", "用途"),
    "floors" to listOf("floors", "floor_count", "階数"),
    "totalFloorAreaSqm" to listOf("total_floor_area_sqm", "total_floor_area", "floor_area_m2", "延床面積"),
    "structure" to listOf("structure", "構造"),
    "registeredOwner" to listOf("registered_owner", "owner", "登記名義人", "所有者"),
    "rightType" to listOf("right_type", "権利種別"),
    "status" to listOf("status", "ステータス"),
    "memo" to listOf("memo", "note", "備考", "メモ")
)

fun Database.importLandsFromLayer(
    request: BusinessEntityImportRequest,
    audit: AuditTrail
): BusinessEntityImportResultDto {
    val sourceLayer = validateBusinessImportRequest(request, landImportFields)
    val fields = resolveImportFields(sourceLayer, request.fieldMapping, landImportFields)
    val result = try {
        withTransaction { connection ->
            setLocalStatementTimeout(connection, heavyStatementTimeoutMillis)
            executeLandImport(connection, sourceLayer, request, fields)
        }
    } catch (exc: SQLException) {
        throw ApiException(HttpStatusCode.BadRequest, "Land import failed: ${exc.message ?: "invalid source data"}")
    }
    audit.recordImport("landImport", result)
    return result
}

fun Database.importBuildingsFromLayer(
    request: BusinessEntityImportRequest,
    audit: AuditTrail
): BusinessEntityImportResultDto {
    val sourceLayer = validateBusinessImportRequest(request, buildingImportFields)
    val fields = resolveImportFields(sourceLayer, request.fieldMapping, buildingImportFields)
    val result = try {
        withTransaction { connection ->
            setLocalStatementTimeout(connection, heavyStatementTimeoutMillis)
            executeBuildingImport(connection, sourceLayer, request, fields)
        }
    } catch (exc: SQLException) {
        throw ApiException(HttpStatusCode.BadRequest, "Building import failed: ${exc.message ?: "invalid source data"}")
    }
    audit.recordImport("buildingImport", result)
    return result
}

private fun Database.validateBusinessImportRequest(
    request: BusinessEntityImportRequest,
    supportedFields: Map<String, List<String>>
): LayerDto {
    val projectId = request.projectId.trim().takeIf { it.isNotEmpty() }
        ?: throw ApiException(HttpStatusCode.BadRequest, "projectId is required")
    val layerId = request.layerId.trim().takeIf { it.isNotEmpty() }
        ?: throw ApiException(HttpStatusCode.BadRequest, "layerId is required")
    val unknownFields = request.fieldMapping.keys - supportedFields.keys
    if (unknownFields.isNotEmpty()) {
        throw ApiException(HttpStatusCode.BadRequest, "Unsupported field mapping: ${unknownFields.sorted().joinToString()}")
    }
    val sourceLayer = getLayer(layerId) ?: throw ApiException(HttpStatusCode.NotFound, "Layer not found")
    if (sourceLayer.projectId != projectId) {
        throw ApiException(HttpStatusCode.BadRequest, "Layer does not belong to the selected project")
    }
    return sourceLayer
}

private fun resolveImportFields(
    layer: LayerDto,
    requested: Map<String, String>,
    candidates: Map<String, List<String>>
): Map<String, String?> {
    val available = layer.attributes
        .map { it.name }
        .filterNot { it == layer.geometryColumn || it == layer.featureIdColumn }
    return candidates.mapValues { (field, aliases) ->
        val explicit = requested[field]?.trim()?.takeIf { it.isNotEmpty() }
        if (explicit != null) {
            available.firstOrNull { it == explicit }
                ?: throw ApiException(HttpStatusCode.BadRequest, "Unknown layer attribute for $field: $explicit")
        } else {
            aliases.firstNotNullOfOrNull { alias ->
                available.firstOrNull { it.equals(alias, ignoreCase = true) }
            }
        }
    }
}

private fun executeLandImport(
    connection: Connection,
    layer: LayerDto,
    request: BusinessEntityImportRequest,
    fields: Map<String, String?>
): BusinessEntityImportResultDto {
    val table = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
    val featureId = "t.${quoteIdent(layer.featureIdColumn)}"
    val geometry = "t.${quoteIdent(layer.geometryColumn)}"
    val lotNumber = textValue(fields["lotNumber"])
    val address = textValue(fields["address"])
    val area = numericValue(fields["areaSqm"])
    val status = textValue(fields["status"])
    val sql = """
        WITH source_stats AS MATERIALIZED (
            SELECT count(*)::int AS total_count,
                   count(*) FILTER (
                       WHERE $geometry IS NOT NULL
                         AND NOT ST_IsEmpty($geometry)
                         AND GeometryType($geometry) ILIKE '%POLYGON%'
                   )::int AS eligible_count
            FROM $table AS t
        ),
        candidates AS MATERIALIZED (
            SELECT concat('L-', replace(?::text, '-', ''), '-', $featureId::text) AS id,
                   ?::uuid AS project_id,
                   COALESCE($lotNumber, $featureId::text) AS lot_number,
                   COALESCE($address, $lotNumber, concat('所在地未設定 (', $featureId::text, ')')) AS address,
                   ${textValue(fields["landUse"])} AS land_use,
                   COALESCE($area, ST_Area($geometry)) AS area_sqm,
                   ${textValue(fields["registeredOwner"])} AS registered_owner,
                   ${textValue(fields["rightType"])} AS right_type,
                   ${textValue(fields["registrationCause"])} AS registration_cause,
                   COALESCE($status, NULLIF(BTRIM(?), ''), '調査中') AS status,
                   ${textValue(fields["memo"])} AS memo,
                   ?::uuid AS source_layer_id,
                   $featureId::text AS source_feature_id
            FROM $table AS t
            WHERE $geometry IS NOT NULL
              AND NOT ST_IsEmpty($geometry)
              AND GeometryType($geometry) ILIKE '%POLYGON%'
        ),
        existing AS MATERIALIZED (
            SELECT count(*)::int AS count
            FROM app.lands AS entity
            JOIN candidates AS candidate ON candidate.id = entity.id
        ),
        upserted AS (
            INSERT INTO app.lands (
                id, project_id, lot_number, address, land_use, area_sqm,
                registered_owner, right_type, registration_cause, status, memo,
                source_layer_id, source_feature_id
            )
            SELECT id, project_id, lot_number, address, land_use, area_sqm,
                   registered_owner, right_type, registration_cause, status, memo,
                   source_layer_id, source_feature_id
            FROM candidates
            ON CONFLICT (id) DO UPDATE
            SET lot_number = EXCLUDED.lot_number,
                address = EXCLUDED.address,
                land_use = COALESCE(EXCLUDED.land_use, app.lands.land_use),
                area_sqm = EXCLUDED.area_sqm,
                registered_owner = COALESCE(EXCLUDED.registered_owner, app.lands.registered_owner),
                right_type = COALESCE(EXCLUDED.right_type, app.lands.right_type),
                registration_cause = COALESCE(EXCLUDED.registration_cause, app.lands.registration_cause),
                status = ${if (fields["status"] != null || !request.status.isNullOrBlank()) "EXCLUDED.status" else "app.lands.status"},
                memo = COALESCE(EXCLUDED.memo, app.lands.memo),
                source_layer_id = EXCLUDED.source_layer_id,
                source_feature_id = EXCLUDED.source_feature_id,
                updated_at = now()
            RETURNING id
        )
        SELECT ((SELECT count(*) FROM upserted) - existing.count)::int AS created_count,
               existing.count AS updated_count,
               (source_stats.total_count - source_stats.eligible_count)::int AS skipped_count
        FROM existing
        CROSS JOIN source_stats
    """.trimIndent()
    return connection.prepareStatement(sql).use { stmt ->
        stmt.setString(1, layer.id)
        stmt.setString(2, request.projectId.trim())
        stmt.setString(3, request.status.orEmpty())
        stmt.setString(4, layer.id)
        stmt.executeQuery().use { rs ->
            rs.next()
            BusinessEntityImportResultDto(
                layerId = layer.id,
                createdCount = rs.getInt("created_count"),
                updatedCount = rs.getInt("updated_count"),
                skippedCount = rs.getInt("skipped_count")
            )
        }
    }
}

private fun executeBuildingImport(
    connection: Connection,
    layer: LayerDto,
    request: BusinessEntityImportRequest,
    fields: Map<String, String?>
): BusinessEntityImportResultDto {
    val table = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
    val featureId = "t.${quoteIdent(layer.featureIdColumn)}"
    val geometry = "t.${quoteIdent(layer.geometryColumn)}"
    val sourceLandId = textValue(fields["landId"])
    val name = textValue(fields["name"])
    val status = textValue(fields["status"])
    val sql = """
        WITH source_stats AS MATERIALIZED (
            SELECT count(*)::int AS total_count,
                   count(*) FILTER (
                       WHERE $geometry IS NOT NULL
                         AND NOT ST_IsEmpty($geometry)
                         AND GeometryType($geometry) ILIKE '%POLYGON%'
                   )::int AS eligible_count
            FROM $table AS t
        ),
        candidates AS MATERIALIZED (
            SELECT concat('B-', replace(?::text, '-', ''), '-', $featureId::text) AS id,
                   ?::uuid AS project_id,
                   CASE WHEN land.id IS NOT NULL THEN land.id END AS land_id,
                   COALESCE($name, concat('建物 ', $featureId::text)) AS name,
                   ${textValue(fields["buildingLocation"])} AS building_location,
                   ${textValue(fields["houseNumber"])} AS house_number,
                   ${textValue(fields["buildingUse"])} AS building_use,
                   ${integerValue(fields["floors"])} AS floors,
                   ${numericValue(fields["totalFloorAreaSqm"])} AS total_floor_area_sqm,
                   ${textValue(fields["structure"])} AS structure,
                   ${textValue(fields["registeredOwner"])} AS registered_owner,
                   ${textValue(fields["rightType"])} AS right_type,
                   COALESCE($status, NULLIF(BTRIM(?), ''), '調査中') AS status,
                   ${textValue(fields["memo"])} AS memo,
                   ?::uuid AS source_layer_id,
                   $featureId::text AS source_feature_id
            FROM $table AS t
            LEFT JOIN app.lands AS land
              ON land.id = $sourceLandId
             AND land.project_id = ?::uuid
            WHERE $geometry IS NOT NULL
              AND NOT ST_IsEmpty($geometry)
              AND GeometryType($geometry) ILIKE '%POLYGON%'
        ),
        existing AS MATERIALIZED (
            SELECT count(*)::int AS count
            FROM app.buildings AS entity
            JOIN candidates AS candidate ON candidate.id = entity.id
        ),
        upserted AS (
            INSERT INTO app.buildings (
                id, project_id, land_id, name, building_location, house_number,
                building_use, floors, total_floor_area_sqm, structure,
                registered_owner, right_type, status, memo, source_layer_id, source_feature_id
            )
            SELECT id, project_id, land_id, name, building_location, house_number,
                   building_use, floors, total_floor_area_sqm, structure,
                   registered_owner, right_type, status, memo, source_layer_id, source_feature_id
            FROM candidates
            ON CONFLICT (id) DO UPDATE
            SET land_id = COALESCE(EXCLUDED.land_id, app.buildings.land_id),
                name = EXCLUDED.name,
                building_location = COALESCE(EXCLUDED.building_location, app.buildings.building_location),
                house_number = COALESCE(EXCLUDED.house_number, app.buildings.house_number),
                building_use = COALESCE(EXCLUDED.building_use, app.buildings.building_use),
                floors = COALESCE(EXCLUDED.floors, app.buildings.floors),
                total_floor_area_sqm = COALESCE(EXCLUDED.total_floor_area_sqm, app.buildings.total_floor_area_sqm),
                structure = COALESCE(EXCLUDED.structure, app.buildings.structure),
                registered_owner = COALESCE(EXCLUDED.registered_owner, app.buildings.registered_owner),
                right_type = COALESCE(EXCLUDED.right_type, app.buildings.right_type),
                status = ${if (fields["status"] != null || !request.status.isNullOrBlank()) "EXCLUDED.status" else "app.buildings.status"},
                memo = COALESCE(EXCLUDED.memo, app.buildings.memo),
                source_layer_id = EXCLUDED.source_layer_id,
                source_feature_id = EXCLUDED.source_feature_id,
                updated_at = now()
            RETURNING id
        )
        SELECT ((SELECT count(*) FROM upserted) - existing.count)::int AS created_count,
               existing.count AS updated_count,
               (source_stats.total_count - source_stats.eligible_count)::int AS skipped_count
        FROM existing
        CROSS JOIN source_stats
    """.trimIndent()
    return connection.prepareStatement(sql).use { stmt ->
        stmt.setString(1, layer.id)
        stmt.setString(2, request.projectId.trim())
        stmt.setString(3, request.status.orEmpty())
        stmt.setString(4, layer.id)
        stmt.setString(5, request.projectId.trim())
        stmt.executeQuery().use { rs ->
            rs.next()
            BusinessEntityImportResultDto(
                layerId = layer.id,
                createdCount = rs.getInt("created_count"),
                updatedCount = rs.getInt("updated_count"),
                skippedCount = rs.getInt("skipped_count")
            )
        }
    }
}

private fun textValue(column: String?): String =
    column?.let { "NULLIF(BTRIM(t.${quoteIdent(it)}::text), '')" } ?: "NULL::text"

private fun numericValue(column: String?): String {
    val value = textValue(column)
    return if (column == null) {
        "NULL::double precision"
    } else {
        "CASE WHEN $value ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN $value::double precision END"
    }
}

private fun integerValue(column: String?): String {
    val value = textValue(column)
    return if (column == null) {
        "NULL::integer"
    } else {
        "CASE WHEN $value ~ '^[+-]?[0-9]+$' THEN $value::integer END"
    }
}

private fun AuditTrail.recordImport(entityType: String, result: BusinessEntityImportResultDto) {
    recordCreate(
        entityType,
        result.layerId,
        buildJsonObject {
            put("layerId", result.layerId)
            put("createdCount", result.createdCount)
            put("updatedCount", result.updatedCount)
            put("skippedCount", result.skippedCount)
        }
    )
}
