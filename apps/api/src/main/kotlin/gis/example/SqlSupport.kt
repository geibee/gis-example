// SQL 組み立て・JSON リクエスト読み取り・ResultSet から DTO への変換を担う共有ヘルパ

package gis.example

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Types
import java.time.LocalDate
import java.util.UUID

internal data class SqlFragment(
    val sql: String,
    val binders: List<(PreparedStatement, Int) -> Unit> = emptyList()
)

internal data class FeatureSearchRow(
    val featureId: String,
    val properties: JsonObject,
    val geometry: JsonElement? = null,
    val matchedBusinessLinks: BusinessLinksDto
)

internal data class DeletedLayerRef(
    val id: String,
    val schemaName: String,
    val tableName: String,
    val resultSetId: String?
)

internal data class AnalysisJobOutcome(
    val resultLayerId: String?,
    val resultSetId: String?,
    val resultCount: Long
)

internal data class ZoneLayerSyncCounts(
    val created: Int,
    val updated: Int
)

internal data class LayerStats(
    val rowCount: Long,
    val geometryType: String,
    val bbox4326: String?
)

internal fun decodeBusinessEntityLinks(value: String?): List<BusinessEntityLinkDto> =
    value?.takeIf { it.isNotBlank() }?.let { databaseJson.decodeFromString<List<BusinessEntityLinkDto>>(it) } ?: emptyList()

internal fun whereClause(filters: List<String>): String =
    if (filters.isEmpty()) "" else "WHERE ${filters.joinToString(" AND ")}"

internal fun isNumericType(dataType: String): Boolean =
    dataType.lowercase() in setOf(
        "smallint",
        "integer",
        "bigint",
        "numeric",
        "decimal",
        "real",
        "double precision"
    )

internal fun addTextPatch(
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

internal fun readTextArray(request: JsonObject, key: String): List<String>? {
    val element = request[key] ?: return null
    if (element is JsonNull) return emptyList()
    val array = try {
        element.jsonArray
    } catch (exc: IllegalArgumentException) {
        return null
    }
    return array.mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.ifBlank { null } }.distinct()
}

internal fun addTextArrayPatch(
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

internal fun addUuidPatch(
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

internal fun addDatePatch(
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

internal fun addDoublePatch(
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

internal fun addIntPatch(
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

internal fun bindPatchValues(stmt: PreparedStatement, binders: List<(PreparedStatement, Int) -> Unit>) {
    binders.forEachIndexed { index, binder -> binder(stmt, index + 1) }
}

internal fun readTextPatch(request: JsonObject, key: String, required: Boolean): String? {
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

internal fun readRequiredText(request: JsonObject, key: String): String =
    readTextPatch(request, key, required = true)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

internal fun readOptionalText(request: JsonObject, key: String): String? =
    readTextPatch(request, key, required = false)

internal fun readRequiredUuid(request: JsonObject, key: String): String =
    readOptionalUuid(request, key)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

internal fun readOptionalUuid(request: JsonObject, key: String): String? =
    readUuidPatch(request, key)

internal fun readOptionalDouble(request: JsonObject, key: String): Double? =
    if (key in request) readDoublePatch(request, key) else null

internal fun readOptionalInt(request: JsonObject, key: String): Int? =
    if (key in request) readIntPatch(request, key) else null

internal fun readRequiredTargetType(request: JsonObject, key: String): String =
    readOptionalTargetType(request, key)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key is required")

internal fun readOptionalTargetType(request: JsonObject, key: String): String? {
    val value = readOptionalText(request, key) ?: return null
    if (value !in setOf("land", "building")) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be land or building")
    }
    return value
}

internal fun readUuidPatch(request: JsonObject, key: String): String? {
    val value = readTextPatch(request, key, required = false) ?: return null
    try {
        UUID.fromString(value)
    } catch (exc: IllegalArgumentException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be a UUID")
    }
    return value
}

internal fun readDoublePatch(request: JsonObject, key: String): Double? {
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

internal fun readIntPatch(request: JsonObject, key: String): Int? {
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

internal fun readOptionalDate(request: JsonObject, key: String): String? {
    val value = readOptionalText(request, key) ?: return null
    try {
        LocalDate.parse(value)
    } catch (exc: IllegalArgumentException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "$key must be YYYY-MM-DD")
    }
    return value
}

internal fun parseBbox(value: String?): DoubleArray? {
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

internal fun setNullableString(stmt: PreparedStatement, index: Int, value: String?) {
    if (value == null) stmt.setNull(index, Types.VARCHAR) else stmt.setString(index, value)
}

internal fun setNullableUuidString(stmt: PreparedStatement, index: Int, value: String?) {
    if (value == null) stmt.setNull(index, Types.OTHER) else stmt.setString(index, value)
}

internal fun setNullableDateString(stmt: PreparedStatement, index: Int, value: String?) {
    if (value == null) stmt.setNull(index, Types.DATE) else stmt.setString(index, value)
}

internal fun ResultSet.toLandDto(): LandDto = LandDto(
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

internal fun ResultSet.toBuildingDto(): BuildingDto = BuildingDto(
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

internal fun ResultSet.toPartyDto(): PartyDto = PartyDto(
    id = getString("id"),
    projectId = getString("project_id"),
    name = getString("name"),
    partyType = getString("party_type"),
    contact = getString("contact"),
    address = getString("address"),
    memo = getString("memo"),
    tags = textArray("tags")
)

internal fun ResultSet.toZoneDto(): ZoneDto = ZoneDto(
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

internal fun ResultSet.toPartyRelationshipDto(): PartyRelationshipDto = PartyRelationshipDto(
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

internal fun ResultSet.textArray(column: String): List<String> {
    val array = getArray(column) ?: return emptyList()
    @Suppress("UNCHECKED_CAST")
    val values = array.array as? Array<Any?> ?: return emptyList()
    return values.mapNotNull { it as? String }
}

internal fun ResultSet.nullableDouble(column: String): Double? =
    (getObject(column) as Number?)?.toDouble()

internal fun ResultSet.nullableInt(column: String): Int? =
    (getObject(column) as Number?)?.toInt()

internal fun ResultSet.toImportJobDto(): ImportJobDto = ImportJobDto(
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

internal fun ResultSet.toLayerDto(attributes: List<LayerAttributeDto>): LayerDto = LayerDto(
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
    bbox4326 = getString("bbox_4326")?.let { databaseJson.decodeFromString<List<Double>>(it) },
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

internal fun ResultSet.toDeletedLayerRef(): DeletedLayerRef = DeletedLayerRef(
    id = getString("id"),
    schemaName = getString("schema_name"),
    tableName = getString("table_name"),
    resultSetId = getString("result_set_id")
)

internal fun ResultSet.toAnalysisJobDto(): AnalysisJobDto = AnalysisJobDto(
    id = getString("id"),
    projectId = getString("project_id"),
    name = getString("name"),
    criteria = databaseJson.parseToJsonElement(getString("criteria")).jsonObject,
    status = getString("status"),
    errorMessage = getString("error_message"),
    resultLayerId = getString("result_layer_id"),
    resultSetId = getString("result_set_id"),
    resultCount = getObject("result_count") as Long?,
    createdAt = getString("created_at"),
    startedAt = getString("started_at"),
    finishedAt = getString("finished_at")
)
