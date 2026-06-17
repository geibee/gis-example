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

    val layersById = db.listLayers(projectId).associateBy { it.id }
    val target = layersById[request.targetLayerId]
        ?: throw ApiException(HttpStatusCode.BadRequest, "Target layer does not exist in project")

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
