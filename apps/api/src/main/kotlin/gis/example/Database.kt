package gis.example

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Types
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

    override fun close() {
        dataSource.close()
    }

    fun ensureBusinessSchema() {
        dataSource.connection.use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app.lands (
                        id text PRIMARY KEY,
                        project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                        lot_number text NOT NULL,
                        address text NOT NULL,
                        land_use text,
                        area_sqm double precision,
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
                        building_use text,
                        floors integer,
                        total_floor_area_sqm double precision,
                        structure text,
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
                        created_at timestamptz NOT NULL DEFAULT now(),
                        updated_at timestamptz NOT NULL DEFAULT now()
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
                    ALTER TABLE app.analysis_jobs
                        ADD COLUMN IF NOT EXISTS result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL;

                    CREATE INDEX IF NOT EXISTS lands_project_search_idx ON app.lands(project_id, id);
                    CREATE INDEX IF NOT EXISTS lands_source_feature_idx ON app.lands(source_layer_id, source_feature_id);
                    CREATE INDEX IF NOT EXISTS buildings_project_search_idx ON app.buildings(project_id, id);
                    CREATE INDEX IF NOT EXISTS buildings_land_idx ON app.buildings(land_id);
                    CREATE INDEX IF NOT EXISTS buildings_source_feature_idx ON app.buildings(source_layer_id, source_feature_id);
                    CREATE INDEX IF NOT EXISTS parties_project_search_idx ON app.parties(project_id, id);
                    CREATE INDEX IF NOT EXISTS party_relationships_party_idx ON app.party_relationships(party_id);
                    CREATE INDEX IF NOT EXISTS party_relationships_target_idx ON app.party_relationships(target_type, target_id);
                    CREATE INDEX IF NOT EXISTS result_sets_project_created_idx ON app.result_sets(project_id, created_at);
                    CREATE INDEX IF NOT EXISTS layers_result_set_idx ON app.layers(result_set_id, created_at);
                    CREATE INDEX IF NOT EXISTS layers_source_layer_idx ON app.layers(source_layer_id);

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
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.result_set_id::text, rs.name AS result_set_name,
                   l.source_layer_id::text, l.tile_source_id, l.created_at::text
            FROM app.layers AS l
            LEFT JOIN app.result_sets AS rs ON rs.id = l.result_set_id
            ORDER BY l.created_at DESC
            """.trimIndent()
        } else {
            """
            SELECT l.id::text, l.project_id::text, l.name, l.schema_name, l.table_name, l.geometry_column,
                   l.geometry_type, l.source_srid, l.display_srid, l.feature_id_column,
                   l.bbox_4326::text, l.row_count, l.is_result, l.result_set_id::text, rs.name AS result_set_name,
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
                   l.bbox_4326::text, l.row_count, l.is_result, l.result_set_id::text, rs.name AS result_set_name,
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
            val businessRequest = businessSearchRequest(projectId, targetLayer.id, businessFilter, sourceTypes, limit)
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

        val sql = """
            SELECT
                t.${quoteIdent(targetLayer.featureIdColumn)}::text AS feature_id,
                (to_jsonb(t) - ?)::text AS properties,
                ST_AsGeoJSON(ST_Transform(t.${quoteIdent(targetLayer.geometryColumn)}, 4326), 6)::text AS geometry
            FROM ${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)} AS t
            ${whereClause(filters)}
            ORDER BY t.${quoteIdent(targetLayer.featureIdColumn)}::text
            LIMIT ?
        """.trimIndent()

        return connection.prepareStatement(sql).use { stmt ->
            var index = 1
            stmt.setString(index++, targetLayer.geometryColumn)
            for (binder in binders) {
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

    fun listLands(projectId: String?, q: String?): List<LandDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val query = q?.trim()?.takeIf { it.isNotEmpty() }
        if (!projectId.isNullOrBlank()) filters.add("project_id = ?::uuid")
        if (query != null) {
            filters.add("lower(concat_ws(' ', id, lot_number, address, land_use, status, memo)) LIKE lower(?)")
        }
        val sql = """
            SELECT id, project_id::text, lot_number, address, land_use, area_sqm, status, memo,
                   source_layer_id::text, source_feature_id
            FROM app.lands
            ${whereClause(filters)}
            ORDER BY id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            var index = 1
            if (!projectId.isNullOrBlank()) stmt.setString(index++, projectId)
            if (query != null) stmt.setString(index, "%$query%")
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toLandDto())
                }
            }
        }
    }

    fun getLand(id: String): LandDto? = dataSource.connection.use { connection ->
        val land = connection.prepareStatement(
            """
            SELECT id, project_id::text, lot_number, address, land_use, area_sqm, status, memo,
                   source_layer_id::text, source_feature_id
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

    fun updateLand(id: String, request: JsonObject): LandDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "lotNumber", "lot_number", setters, binders, required = true)
            addTextPatch(request, "address", "address", setters, binders, required = true)
            addTextPatch(request, "landUse", "land_use", setters, binders)
            addDoublePatch(request, "areaSqm", "area_sqm", setters, binders)
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

    fun listBuildings(projectId: String?, q: String?, landId: String?): List<BuildingDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val query = q?.trim()?.takeIf { it.isNotEmpty() }
        if (!projectId.isNullOrBlank()) filters.add("b.project_id = ?::uuid")
        if (!landId.isNullOrBlank()) filters.add("b.land_id = ?")
        if (query != null) {
            filters.add("lower(concat_ws(' ', b.id, b.name, b.building_use, b.structure, b.status, b.memo, l.lot_number, l.address)) LIKE lower(?)")
        }
        val sql = """
            SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
                   b.name, b.building_use, b.floors, b.total_floor_area_sqm, b.structure, b.status, b.memo,
                   b.source_layer_id::text, b.source_feature_id
            FROM app.buildings AS b
            LEFT JOIN app.lands AS l ON l.id = b.land_id
            ${whereClause(filters)}
            ORDER BY b.id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            var index = 1
            if (!projectId.isNullOrBlank()) stmt.setString(index++, projectId)
            if (!landId.isNullOrBlank()) stmt.setString(index++, landId)
            if (query != null) stmt.setString(index, "%$query%")
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toBuildingDto())
                }
            }
        }
    }

    fun getBuilding(id: String): BuildingDto? = dataSource.connection.use { connection ->
        val building = connection.prepareStatement(
            """
            SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
                   b.name, b.building_use, b.floors, b.total_floor_area_sqm, b.structure, b.status, b.memo,
                   b.source_layer_id::text, b.source_feature_id
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

    fun updateBuilding(id: String, request: JsonObject): BuildingDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "landId", "land_id", setters, binders)
            addTextPatch(request, "name", "name", setters, binders, required = true)
            addTextPatch(request, "buildingUse", "building_use", setters, binders)
            addIntPatch(request, "floors", "floors", setters, binders)
            addDoublePatch(request, "totalFloorAreaSqm", "total_floor_area_sqm", setters, binders)
            addTextPatch(request, "structure", "structure", setters, binders)
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

    fun listParties(projectId: String?, q: String?): List<PartyDto> = dataSource.connection.use { connection ->
        val filters = mutableListOf<String>()
        val query = q?.trim()?.takeIf { it.isNotEmpty() }
        if (!projectId.isNullOrBlank()) filters.add("project_id = ?::uuid")
        if (query != null) {
            filters.add("lower(concat_ws(' ', id, name, party_type, contact, address, memo)) LIKE lower(?)")
        }
        val sql = """
            SELECT id, project_id::text, name, party_type, contact, address, memo
            FROM app.parties
            ${whereClause(filters)}
            ORDER BY id
        """.trimIndent()
        connection.prepareStatement(sql).use { stmt ->
            var index = 1
            if (!projectId.isNullOrBlank()) stmt.setString(index++, projectId)
            if (query != null) stmt.setString(index, "%$query%")
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toPartyDto())
                }
            }
        }
    }

    fun getParty(id: String): PartyDto? = dataSource.connection.use { connection ->
        val party = connection.prepareStatement(
            """
            SELECT id, project_id::text, name, party_type, contact, address, memo
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

    fun updateParty(id: String, request: JsonObject): PartyDto = try {
        dataSource.connection.use { connection ->
            val setters = mutableListOf<String>()
            val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
            addTextPatch(request, "name", "name", setters, binders, required = true)
            addTextPatch(request, "partyType", "party_type", setters, binders, required = true)
            addTextPatch(request, "contact", "contact", setters, binders)
            addTextPatch(request, "address", "address", setters, binders)
            addTextPatch(request, "memo", "memo", setters, binders)
            if (setters.isEmpty()) {
                return@use getParty(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
            }

            val updated = connection.prepareStatement(
                """
                UPDATE app.parties
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?
                RETURNING id, project_id::text, name, party_type, contact, address, memo
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

    private fun ResultSet.toLandDto(): LandDto = LandDto(
        id = getString("id"),
        projectId = getString("project_id"),
        lotNumber = getString("lot_number"),
        address = getString("address"),
        landUse = getString("land_use"),
        areaSqm = nullableDouble("area_sqm"),
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
        buildingUse = getString("building_use"),
        floors = nullableInt("floors"),
        totalFloorAreaSqm = nullableDouble("total_floor_area_sqm"),
        structure = getString("structure"),
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
        memo = getString("memo")
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
        resultSetId = getString("result_set_id"),
        resultSetName = getString("result_set_name"),
        sourceLayerId = getString("source_layer_id"),
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
