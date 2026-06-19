package gis.example

import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.JsonNull

private val allowedAttributeOperators = setOf("=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL")
private val allowedSpatialOperators = setOf("intersects", "contains", "within", "dwithin")

fun validateAnalysisRequest(db: Database, request: AnalysisJobRequest) {
    val projectId = request.projectId ?: db.defaultProjectId()
    if (!db.projectExists(projectId)) {
        throw ApiException(HttpStatusCode.BadRequest, "Project does not exist")
    }

    val operation = request.operation?.takeIf { it.isNotBlank() }?.lowercase() ?: "and_filter"
    if (operation !in setOf("and_filter", "outer_boundary", "condition_search")) {
        throw ApiException(HttpStatusCode.BadRequest, "Unsupported analysis operation: ${request.operation}")
    }

    val layersById = db.listLayers(projectId).associateBy { it.id }

    if (operation == "condition_search") {
        val conditionQuery = request.conditionQuery
            ?: throw ApiException(HttpStatusCode.BadRequest, "conditionQuery is required for condition_search")
        val targetLayerIds = conditionQuery.targetLayerIds.mapNotNull { it.trim().takeIf(String::isNotEmpty) }.distinct()
        if (targetLayerIds.isEmpty()) {
            throw ApiException(HttpStatusCode.BadRequest, "conditionQuery.targetLayerIds is required")
        }
        targetLayerIds.forEach { layerId ->
            if (!layersById.containsKey(layerId)) {
                throw ApiException(HttpStatusCode.BadRequest, "Target layer does not exist in project: $layerId")
            }
        }
        conditionQuery.conditions.forEach { condition ->
            val layerId = condition.layerId?.trim()?.takeIf { it.isNotEmpty() }
            if (layerId != null && !layersById.containsKey(layerId)) {
                throw ApiException(HttpStatusCode.BadRequest, "Referenced layer does not exist in project: $layerId")
            }
        }
        return
    }

    val targetLayerId = request.targetLayerId?.takeIf { it.isNotBlank() }
        ?: throw ApiException(HttpStatusCode.BadRequest, "targetLayerId is required")
    val target = layersById[targetLayerId]
        ?: throw ApiException(HttpStatusCode.BadRequest, "Target layer does not exist in project")

    if (operation == "outer_boundary") {
        if (!target.isPolygonLike()) {
            throw ApiException(HttpStatusCode.BadRequest, "Outer boundary target layer must be polygon")
        }
        val boundaryLayerId = request.boundaryLayerId?.takeIf { it.isNotBlank() }
            ?: throw ApiException(HttpStatusCode.BadRequest, "boundaryLayerId is required for outer_boundary")
        val boundary = layersById[boundaryLayerId]
            ?: throw ApiException(HttpStatusCode.BadRequest, "Boundary layer does not exist in project")
        if (!boundary.isPolygonLike() && !boundary.isLineLike()) {
            throw ApiException(HttpStatusCode.BadRequest, "Boundary layer must be polygon or line")
        }
        if ((request.bufferMeters ?: 1000.0) <= 0.0) {
            throw ApiException(HttpStatusCode.BadRequest, "bufferMeters must be positive")
        }
        return
    }

    val referencedLayerIds = buildSet {
        add(target.id)
        request.attributeConditions.forEach { add(it.layerId) }
        request.spatialConditions.forEach { add(it.layerId) }
    }
    referencedLayerIds.forEach { layerId ->
        if (!layersById.containsKey(layerId)) {
            throw ApiException(HttpStatusCode.BadRequest, "Referenced layer does not exist in project: $layerId")
        }
    }

    request.attributeConditions.forEach { condition ->
        val layer = layersById.getValue(condition.layerId)
        val operator = condition.operator.uppercase()
        if (operator !in allowedAttributeOperators) {
            throw ApiException(HttpStatusCode.BadRequest, "Unsupported attribute operator: ${condition.operator}")
        }
        if (layer.attributes.none { it.name == condition.field }) {
            throw ApiException(HttpStatusCode.BadRequest, "Unknown attribute '${condition.field}' for layer '${layer.name}'")
        }
        when (operator) {
            "IN" -> {
                if (condition.values.isNullOrEmpty()) {
                    throw ApiException(HttpStatusCode.BadRequest, "IN operator requires non-empty values")
                }
            }
            "IS NULL" -> Unit
            else -> {
                if (condition.value == null || condition.value is JsonNull) {
                    throw ApiException(HttpStatusCode.BadRequest, "$operator operator requires a value")
                }
            }
        }
    }

    request.spatialConditions.forEach { condition ->
        val operator = condition.operator.lowercase()
        if (operator !in allowedSpatialOperators) {
            throw ApiException(HttpStatusCode.BadRequest, "Unsupported spatial operator: ${condition.operator}")
        }
        if (condition.layerId == target.id) {
            throw ApiException(HttpStatusCode.BadRequest, "Spatial condition layer must differ from target layer")
        }
        if (operator == "dwithin" && ((condition.distanceMeters ?: 0.0) <= 0.0)) {
            throw ApiException(HttpStatusCode.BadRequest, "dwithin requires a positive distanceMeters value")
        }
    }
}

private fun LayerDto.isPolygonLike(): Boolean = geometryType.uppercase().contains("POLYGON")

private fun LayerDto.isLineLike(): Boolean = geometryType.uppercase().contains("LINE")
