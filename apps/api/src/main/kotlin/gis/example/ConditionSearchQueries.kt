// 条件検索 (属性・空間・業務条件) と業務エンティティ起点の空間検索

package gis.example

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.PreparedStatement

fun Database.searchBusinessSpatialFeatures(request: BusinessSpatialSearchRequest): List<FeatureSearchResultDto> {
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

private fun Database.searchBusinessSpatialFeaturesForLayer(
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
                            properties = databaseJson.parseToJsonElement(rs.getString("properties")).jsonObject,
                            geometry = rs.getString("geometry")?.let { databaseJson.parseToJsonElement(it) },
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

fun Database.conditionSearchFeatures(request: ConditionQueryDto): List<FeatureSearchResultDto> {
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

private fun Database.conditionSearchRowsForLayer(
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
                            properties = databaseJson.parseToJsonElement(rs.getString("properties")).jsonObject,
                            geometry = rs.getString("geometry")?.let { databaseJson.parseToJsonElement(it) },
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
internal fun Database.conditionSearchFilters(
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

internal fun Database.validateConditionSearchConditions(
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

private fun Database.addAttributeConditionFilter(
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

private fun Database.conditionLayerId(condition: ConditionQueryConditionDto): String? =
    condition.layerId?.trim()?.takeIf { it.isNotEmpty() }

private fun Database.spatialComparisonTarget(condition: ConditionQueryConditionDto): String =
    condition.comparisonTarget?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        ?: if (condition.type.lowercase() == "spatial" && conditionLayerId(condition) == null) "business" else "layer"

private fun Database.mergedBusinessCondition(conditions: List<ConditionQueryConditionDto>): ConditionQueryConditionDto? =
    conditions.firstOrNull()

private fun Database.businessSourceTypes(condition: ConditionQueryConditionDto?): List<String> =
    condition?.sourceTypes
        ?.mapNotNull { it.trim().lowercase().takeIf(String::isNotEmpty) }
        ?.ifEmpty { listOf("land", "building") }
        ?: listOf("land", "building")

private fun Database.businessSearchRequest(
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

private fun Database.businessLinkPredicateSql(
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

private fun Database.conditionValueText(condition: ConditionQueryConditionDto): String? {
    val value = condition.value ?: return null
    if (value is JsonNull) return null
    return try {
        value.jsonPrimitive.contentOrNull
    } catch (exc: IllegalArgumentException) {
        value.toString()
    }?.trim()?.takeIf { it.isNotEmpty() }
}

internal fun Database.conditionLabels(conditions: List<ConditionQueryConditionDto>): List<String> =
    conditions.mapNotNull { condition ->
        when (condition.type.lowercase()) {
            "attribute" -> "属性条件"
            "spatial" -> "空間条件"
            "business" -> "業務条件"
            else -> null
        }
    }.distinct()

internal fun Database.conditionSearchSummary(keyword: String?, labels: List<String>): String {
    val parts = mutableListOf<String>()
    keyword?.trim()?.takeIf { it.isNotEmpty() }?.let { parts.add("キーワード: $it") }
    parts.addAll(labels)
    return if (parts.isEmpty()) "条件なし" else parts.joinToString(" AND ")
}
