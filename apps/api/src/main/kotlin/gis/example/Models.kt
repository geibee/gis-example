package gis.example

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class ErrorResponse(val error: String)

@Serializable
data class ProjectDto(
    val id: String,
    val name: String,
    val createdAt: String
)

@Serializable
data class LayerAttributeDto(
    val name: String,
    val dataType: String,
    val ordinalPosition: Int
)

@Serializable
data class LayerDto(
    val id: String,
    val projectId: String,
    val name: String,
    val schemaName: String,
    val tableName: String,
    val geometryColumn: String,
    val geometryType: String,
    val sourceSrid: Int? = null,
    val displaySrid: Int,
    val featureIdColumn: String,
    val bbox4326: List<Double>? = null,
    val rowCount: Long,
    val isResult: Boolean,
    val tileSourceId: String,
    val attributes: List<LayerAttributeDto> = emptyList(),
    val createdAt: String
)

@Serializable
data class ImportJobDto(
    val id: String,
    val projectId: String,
    val filename: String,
    val format: String,
    val sourceSrid: Int? = null,
    val status: String,
    val errorMessage: String? = null,
    val layerId: String? = null,
    val createdAt: String,
    val startedAt: String? = null,
    val finishedAt: String? = null
)

@Serializable
data class AttributeConditionDto(
    val layerId: String,
    val field: String,
    val operator: String,
    val value: JsonElement? = null,
    val values: List<String>? = null
)

@Serializable
data class SpatialConditionDto(
    val layerId: String,
    val operator: String,
    val distanceMeters: Double? = null
)

@Serializable
data class AnalysisJobRequest(
    val projectId: String? = null,
    val name: String? = null,
    val targetLayerId: String,
    val operation: String? = null,
    val boundaryLayerId: String? = null,
    val bufferMeters: Double? = null,
    val attributeConditions: List<AttributeConditionDto> = emptyList(),
    val spatialConditions: List<SpatialConditionDto> = emptyList()
)

@Serializable
data class AnalysisJobDto(
    val id: String,
    val projectId: String,
    val name: String,
    val criteria: JsonObject,
    val status: String,
    val errorMessage: String? = null,
    val resultLayerId: String? = null,
    val resultCount: Long? = null,
    val createdAt: String,
    val startedAt: String? = null,
    val finishedAt: String? = null
)

@Serializable
data class FeatureDto(
    val layerId: String,
    val featureId: String,
    val properties: JsonObject,
    val geometry: JsonElement? = null
)

@Serializable
data class FeatureUpdateRequest(
    val properties: JsonObject = JsonObject(emptyMap()),
    val geometry: JsonElement? = null
)

@Serializable
data class VectorLayerDto(
    val id: String,
    val fields: Map<String, String>
)

@Serializable
data class TileJsonDto(
    val tilejson: String = "3.0.0",
    val name: String,
    val tiles: List<String>,
    @SerialName("vector_layers")
    val vectorLayers: List<VectorLayerDto>,
    val bounds: List<Double>? = null,
    val minzoom: Int = 0,
    val maxzoom: Int = 22
)
