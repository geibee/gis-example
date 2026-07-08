// 区域 (app.zones) の CRUD・関係者サマリと、区域レイヤの生成・同期

package gis.example

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.SQLException

fun Database.listZones(query: ZoneListQuery): PagedList<ZoneDto> = dataSource.connection.use { connection ->
    val filters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
    if (!query.projectId.isNullOrBlank()) {
        filters.add("z.project_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, query.projectId) }
    }
    if (textQuery != null) {
        filters.add(
            """
            lower(
                coalesce(z.id, '') || ' ' ||
                coalesce(z.name, '') || ' ' ||
                coalesce(z.zone_type, '') || ' ' ||
                coalesce(z.status, '') || ' ' ||
                coalesce(z.memo, '')
            ) LIKE lower(?)
            """.trimIndent()
        )
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
    }
    query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("z.status ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    query.zoneType?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("z.zone_type ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    val requestedZoneLayerId = query.zoneLayerId?.trim()?.takeIf { it.isNotEmpty() }
        ?: query.sourceLayerId?.trim()?.takeIf { it.isNotEmpty() }
    requestedZoneLayerId?.let { value ->
        filters.add("z.zone_layer_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, value) }
    }
    if (query.linkedOnly) {
        filters.add("z.zone_layer_id IS NOT NULL AND z.zone_feature_id IS NOT NULL")
    }
    val baseSql = """
        FROM app.zones AS z
        ${whereClause(filters)}
    """.trimIndent()
    val totalCount = queryTotalCount(connection, baseSql, binders)
    val sql = """
        SELECT z.id, z.project_id::text, z.name, z.zone_type, z.status, z.memo,
               z.zone_layer_id::text, z.zone_feature_id,
               z.source_layer_id::text, z.source_feature_id
        $baseSql
        ORDER BY z.id${pagingClause(query.limit, query.offset)}
    """.trimIndent()
    val zones = connection.prepareStatement(sql).use { stmt ->
        bindPatchValues(stmt, binders)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toZoneDto())
            }
        }
    }
    // 区域ごとに listLands/listBuildings を呼ぶ N+1 を避け、区域レイヤ単位の一括クエリで数える
    val counts = countZoneBusinessLinksBatch(connection, zones)
    PagedList(
        items = zones.map { zone ->
            val zoneCounts = counts[zone.id] ?: ZoneLinkCounts(0, 0)
            zone.copy(
                landCount = zoneCounts.landCount,
                buildingCount = zoneCounts.buildingCount
            )
        },
        totalCount = totalCount
    )
}

fun Database.getZone(id: String): ZoneDto? = dataSource.connection.use { connection ->
    val zone = connection.prepareStatement(
        """
        SELECT id, project_id::text, name, zone_type, status, memo,
               zone_layer_id::text, zone_feature_id,
               source_layer_id::text, source_feature_id
        FROM app.zones
        WHERE id = ?
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) null else rs.toZoneDto()
        }
    } ?: return@use null
    val contained = listZoneBusinessLinks(zone)
    zone.copy(
        landCount = contained.lands.size,
        buildingCount = contained.buildings.size,
        lands = contained.lands,
        buildings = contained.buildings
    )
}

fun Database.getZonePartySummary(id: String): ZonePartySummaryDto? {
    val zone = getZone(id) ?: return null
    val landIds = zone.lands.map { it.id }
    val buildingIds = zone.buildings.map { it.id }
    val containedCount = landIds.size + buildingIds.size
    if (landIds.isEmpty() && buildingIds.isEmpty()) {
        return ZonePartySummaryDto(zoneId = id, containedCount = 0, partyCount = 0)
    }
    data class PartyAcc(
        val id: String,
        val name: String,
        val partyType: String,
        val tags: List<String>,
        val targets: MutableSet<String> = mutableSetOf(),
        val relationTypes: MutableSet<String> = mutableSetOf()
    )
    return dataSource.connection.use { connection ->
        val targetConds = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        if (landIds.isNotEmpty()) {
            targetConds.add("(r.target_type = 'land' AND r.target_id = ANY(?))")
            binders.add { stmt, index -> stmt.setArray(index, connection.createArrayOf("text", landIds.toTypedArray())) }
        }
        if (buildingIds.isNotEmpty()) {
            targetConds.add("(r.target_type = 'building' AND r.target_id = ANY(?))")
            binders.add { stmt, index -> stmt.setArray(index, connection.createArrayOf("text", buildingIds.toTypedArray())) }
        }
        val accById = linkedMapOf<String, PartyAcc>()
        connection.prepareStatement(
            """
            SELECT p.id, p.name, p.party_type, p.tags, r.target_type, r.target_id, r.relation_type
            FROM app.party_relationships AS r
            JOIN app.parties AS p ON p.id = r.party_id
            WHERE ${targetConds.joinToString(" OR ")}
            """.trimIndent()
        ).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    val partyId = rs.getString("id")
                    val acc = accById.getOrPut(partyId) {
                        PartyAcc(
                            id = partyId,
                            name = rs.getString("name"),
                            partyType = rs.getString("party_type"),
                            tags = rs.textArray("tags")
                        )
                    }
                    acc.targets.add("${rs.getString("target_type")}:${rs.getString("target_id")}")
                    rs.getString("relation_type")?.let { acc.relationTypes.add(it) }
                }
            }
        }

        val projectInvolvement = mutableMapOf<String, Int>()
        if (accById.isNotEmpty()) {
            connection.prepareStatement(
                """
                SELECT party_id, count(DISTINCT (target_type, target_id)) AS cnt
                FROM app.party_relationships
                WHERE party_id = ANY(?)
                GROUP BY party_id
                """.trimIndent()
            ).use { stmt ->
                stmt.setArray(1, connection.createArrayOf("text", accById.keys.toTypedArray()))
                stmt.executeQuery().use { rs ->
                    while (rs.next()) projectInvolvement[rs.getString("party_id")] = rs.getInt("cnt")
                }
            }
        }

        val parties = accById.values
            .map { acc ->
                val zoneInvolvement = acc.targets.size
                ZonePartySummaryEntryDto(
                    id = acc.id,
                    name = acc.name,
                    partyType = acc.partyType,
                    tags = acc.tags,
                    zoneInvolvement = zoneInvolvement,
                    projectInvolvement = projectInvolvement[acc.id] ?: zoneInvolvement,
                    relationTypes = acc.relationTypes.sorted(),
                    coverageRatio = if (containedCount > 0) zoneInvolvement.toDouble() / containedCount else 0.0
                )
            }
            .sortedWith(compareByDescending<ZonePartySummaryEntryDto> { it.zoneInvolvement }.thenBy { it.id })

        val typeBreakdown = parties.groupingBy { it.partyType }.eachCount()
            .map { (key, count) -> ZonePartyBreakdownDto(key, count) }
            .sortedWith(compareByDescending<ZonePartyBreakdownDto> { it.count }.thenBy { it.key })
        val tagBreakdown = parties.flatMap { it.tags }.groupingBy { it }.eachCount()
            .map { (key, count) -> ZonePartyBreakdownDto(key, count) }
            .sortedWith(compareByDescending<ZonePartyBreakdownDto> { it.count }.thenBy { it.key })

        ZonePartySummaryDto(
            zoneId = id,
            containedCount = containedCount,
            partyCount = parties.size,
            typeBreakdown = typeBreakdown,
            tagBreakdown = tagBreakdown,
            parties = parties
        )
    }
}

fun Database.createZone(request: JsonObject, audit: AuditTrail): ZoneDto = try {
    val id = readRequiredText(request, "id")
    val projectId = readRequiredUuid(request, "projectId")
    val name = readRequiredText(request, "name")
    val zoneType = readOptionalText(request, "zoneType")
    val status = readOptionalText(request, "status") ?: "有効"
    val memo = readOptionalText(request, "memo")
    val zoneLayerId = readOptionalUuid(request, "zoneLayerId") ?: readRequiredUuid(request, "sourceLayerId")
    val zoneFeatureId = readOptionalText(request, "zoneFeatureId") ?: readRequiredText(request, "sourceFeatureId")
    validateZoneFeature(projectId, zoneLayerId, zoneFeatureId)
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            INSERT INTO app.zones (
                id, project_id, name, zone_type, status, memo,
                zone_layer_id, zone_feature_id, source_layer_id, source_feature_id
            )
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?::uuid, ?)
            RETURNING id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.setString(2, projectId)
            stmt.setString(3, name)
            setNullableString(stmt, 4, zoneType)
            stmt.setString(5, status)
            setNullableString(stmt, 6, memo)
            stmt.setString(7, zoneLayerId)
            stmt.setString(8, zoneFeatureId)
            stmt.setString(9, zoneLayerId)
            stmt.setString(10, zoneFeatureId)
            stmt.executeQuery().use { rs ->
                rs.next()
                val created = getZone(rs.getString("id")) ?: error("Created zone disappeared")
                audit.recordCreate("zone", created.id, created.auditSnapshot())
                created
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone create failed: ${exc.message ?: "invalid zone create"}")
}

fun Database.updateZone(id: String, request: JsonObject, audit: AuditTrail): ZoneDto = try {
    dataSource.connection.use { connection ->
        val existing = getZone(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
        val setters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        addTextPatch(request, "name", "name", setters, binders, required = true)
        addTextPatch(request, "zoneType", "zone_type", setters, binders)
        addTextPatch(request, "status", "status", setters, binders, required = true)
        addTextPatch(request, "memo", "memo", setters, binders)
        if (setters.isEmpty()) {
            audit.recordUpdate("zone", id, existing.auditSnapshot(), existing.auditSnapshot())
            return@use existing
        }

        val updatedId = connection.prepareStatement(
            """
            UPDATE app.zones
            SET ${setters.joinToString(", ")}, updated_at = now()
            WHERE id = ?
            RETURNING id
            """.trimIndent()
        ).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.setString(binders.size + 1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) {
                    throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
                }
                rs.getString("id")
            }
        }
        val result = getZone(updatedId) ?: error("Updated zone disappeared")
        audit.recordUpdate("zone", id, existing.auditSnapshot(), result.auditSnapshot())
        result
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone update failed: ${exc.message ?: "invalid zone update"}")
}

fun Database.deleteZone(id: String, audit: AuditTrail) {
    // 監査 diff 用の削除前スナップショット (存在しない ID は従来どおり 404)
    val before = getZone(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
    dataSource.connection.use { connection ->
        val deleted = connection.prepareStatement("DELETE FROM app.zones WHERE id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate()
        }
        if (deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Zone not found")
        }
    }
    audit.recordDelete("zone", id, before.auditSnapshot())
}

fun Database.createZoneLayerFromImport(request: ZoneLayerFromImportRequest, audit: AuditTrail): ZoneLayerOperationDto {
    val requestedLayerId = request.layerId.trim().takeIf { it.isNotEmpty() }
        ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "layerId is required")
    val sourceLayer = getLayer(requestedLayerId)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Layer not found")
    val projectId = request.projectId?.trim()?.takeIf { it.isNotEmpty() } ?: sourceLayer.projectId
    if (sourceLayer.projectId != projectId) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Layer does not belong to the selected project")
    }
    validateZoneSourceLayerGeometry(sourceLayer)

    val layerName = request.name?.trim()?.takeIf { it.isNotEmpty() } ?: "${sourceLayer.name} 区域"
    val tableName = generatedTableName("zone_buffer")
    return try {
        val (layerId, counts) = withTransaction { connection ->
            // ST_MemUnion + ST_Buffer は大規模レイヤで長時間かかるため、生成系専用の上限に差し替える
            setLocalStatementTimeout(connection, heavyStatementTimeoutMillis)
            createSourceZoneBufferTable(
                connection = connection,
                tableName = tableName,
                sourceLayer = sourceLayer,
                layerName = layerName
            )
            normalizeGeneratedTable(connection, "gis_data", tableName, "geom")
            val count = connection.prepareStatement("SELECT count(*)::int FROM ${quoteIdent("gis_data")}.${quoteIdent(tableName)}").use { stmt ->
                stmt.executeQuery().use { rs ->
                    rs.next()
                    rs.getInt(1)
                }
            }
            if (count == 0) {
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Source layer has no point or polygon geometry")
            }
            val layerId = insertLayerMetadata(
                connection = connection,
                projectId = projectId,
                name = layerName,
                tableName = tableName,
                sourceSrid = 3857,
                isResult = false,
                layerRole = "zone",
                sourceLayerId = sourceLayer.id
            )
            val layer = getLayerInConnection(connection, layerId)
                ?: throw ApiException(io.ktor.http.HttpStatusCode.InternalServerError, "Created layer disappeared")
            layerId to syncZonesForLayer(
                connection = connection,
                layer = layer,
                zoneType = request.zoneType,
                status = request.status,
                nameField = "name"
            )
        }
        val createdLayer = getLayer(layerId) ?: error("Created layer disappeared")
        // 生成された区域レイヤ本体を記録する。区域行の一括 upsert は件数が多く detail を
        // 肥大化させるため個別には記録しない (レイヤ ID から app.zones を辿れる)
        audit.recordCreate("layer", createdLayer.id, createdLayer.auditSnapshot())
        ZoneLayerOperationDto(
            layer = createdLayer,
            zonesCreated = counts.created,
            zonesUpdated = counts.updated,
            zones = listZones(
                ZoneListQuery(
                    projectId = projectId,
                    q = null,
                    status = null,
                    zoneType = null,
                    linkedOnly = false,
                    zoneLayerId = layerId,
                    sourceLayerId = null
                )
            ).items
        )
    } catch (exc: SQLException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer generation failed: ${exc.message ?: "invalid zone layer generation"}")
    }
}

internal data class ZoneLinkCounts(val landCount: Int, val buildingCount: Int)

// listZoneBusinessLinks (詳細取得用) と同じ結合条件で、一覧向けに区域内の土地・建物件数だけを数える。
// (プロジェクト, 区域レイヤ) ごとに 1 クエリへまとめ、区域ごとの空間検索 N+1 を避ける
private fun Database.countZoneBusinessLinksBatch(connection: Connection, zones: List<ZoneDto>): Map<String, ZoneLinkCounts> {
    val result = mutableMapOf<String, ZoneLinkCounts>()
    val sourceLayersByProject = mutableMapOf<String, List<LayerDto>>()
    for ((key, group) in zones.groupBy { it.projectId to it.zoneLayerId }) {
        val (projectId, zoneLayerId) = key
        val targetLayer = getLayer(zoneLayerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "intersectsLayerId not found")
        if (targetLayer.projectId != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "intersectsLayerId belongs to another project")
        }
        val sourceLayers = sourceLayersByProject.getOrPut(projectId) {
            listLayers(projectId).filter { !it.isResult && it.layerRole != "zone" }
        }
        if (sourceLayers.isEmpty()) {
            group.forEach { result[it.id] = ZoneLinkCounts(0, 0) }
            continue
        }
        val counts = queryZoneLinkCounts(connection, targetLayer, sourceLayers, projectId, group.map { it.zoneFeatureId })
        for (zone in group) {
            result[zone.id] = counts[zone.zoneFeatureId] ?: ZoneLinkCounts(0, 0)
        }
    }
    return result
}

// 区域レイヤの各フィーチャに対し、ソースレイヤ経由で紐づく土地・建物の件数を 1 クエリで数える。
// 結合条件 (source_layer_id / source_feature_id / && + ST_Intersects / SRID 変換) は
// addBusinessListSpatialFilters の intersects 述語と同じ意味論を保つこと
private fun Database.queryZoneLinkCounts(
    connection: Connection,
    targetLayer: LayerDto,
    sourceLayers: List<LayerDto>,
    projectId: String,
    zoneFeatureIds: List<String>
): Map<String, ZoneLinkCounts> {
    val targetTableRef = "${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)}"
    val targetFeatureIdRef = "target.${quoteIdent(targetLayer.featureIdColumn)}"
    val rawTargetGeom = "target.${quoteIdent(targetLayer.geometryColumn)}"
    val selects = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    for (sourceLayer in sourceLayers) {
        val sourceTableRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
        val sourceFeatureIdRef = "src.${quoteIdent(sourceLayer.featureIdColumn)}"
        val sourceGeomRef = "src.${quoteIdent(sourceLayer.geometryColumn)}"
        val targetGeomRef = if (targetLayer.displaySrid == sourceLayer.displaySrid) {
            rawTargetGeom
        } else {
            "ST_Transform($rawTargetGeom, ${sourceLayer.displaySrid})"
        }
        for ((entityType, entityTable) in listOf("land" to "app.lands", "building" to "app.buildings")) {
            selects.add(
                """
                SELECT $targetFeatureIdRef::text AS zone_feature_id, '$entityType' AS entity_type, e.id AS entity_id
                FROM $targetTableRef AS target
                JOIN $sourceTableRef AS src
                  ON $sourceGeomRef IS NOT NULL
                 AND $rawTargetGeom IS NOT NULL
                 AND $sourceGeomRef && $targetGeomRef
                 AND ST_Intersects($sourceGeomRef, $targetGeomRef)
                JOIN $entityTable AS e
                  ON e.source_layer_id = ?::uuid
                 AND e.source_feature_id = $sourceFeatureIdRef::text
                WHERE e.project_id = ?::uuid
                  AND $targetFeatureIdRef::text = ANY(?)
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, sourceLayer.id) }
            binders.add { stmt, index -> stmt.setString(index, projectId) }
            binders.add { stmt, index -> stmt.setArray(index, connection.createArrayOf("text", zoneFeatureIds.toTypedArray())) }
        }
    }
    val sql = """
        SELECT zone_feature_id, entity_type, count(DISTINCT entity_id)::int AS cnt
        FROM (
        ${selects.joinToString("\nUNION ALL\n")}
        ) AS matches
        GROUP BY zone_feature_id, entity_type
    """.trimIndent()
    val landCounts = mutableMapOf<String, Int>()
    val buildingCounts = mutableMapOf<String, Int>()
    connection.prepareStatement(sql).use { stmt ->
        bindPatchValues(stmt, binders)
        stmt.executeQuery().use { rs ->
            while (rs.next()) {
                val featureId = rs.getString("zone_feature_id")
                when (rs.getString("entity_type")) {
                    "land" -> landCounts[featureId] = rs.getInt("cnt")
                    "building" -> buildingCounts[featureId] = rs.getInt("cnt")
                }
            }
        }
    }
    return (landCounts.keys + buildingCounts.keys).associateWith { featureId ->
        ZoneLinkCounts(landCounts[featureId] ?: 0, buildingCounts[featureId] ?: 0)
    }
}

private fun Database.listZoneBusinessLinks(zone: ZoneDto): BusinessLinksDto {
    val landLinks = listLands(
        LandListQuery(
            projectId = zone.projectId,
            q = null,
            status = null,
            landUse = null,
            partyType = null,
            relationType = null,
            linkedOnly = true,
            sourceLayerId = null,
            bbox = null,
            intersectsLayerId = zone.zoneLayerId,
            intersectsFeatureId = zone.zoneFeatureId,
            distanceMeters = null
        )
    ).items.map { land -> BusinessEntityLinkDto(land.id, "${land.lotNumber} · ${land.address}") }
    val buildingLinks = listBuildings(
        BuildingListQuery(
            projectId = zone.projectId,
            q = null,
            landId = null,
            status = null,
            buildingUse = null,
            partyType = null,
            relationType = null,
            linkedOnly = true,
            sourceLayerId = null,
            bbox = null,
            intersectsLayerId = zone.zoneLayerId,
            intersectsFeatureId = zone.zoneFeatureId,
            distanceMeters = null
        )
    ).items.map { building -> BusinessEntityLinkDto(building.id, building.name) }
    return BusinessLinksDto(lands = landLinks, buildings = buildingLinks)
}

private fun Database.validateZoneFeature(projectId: String, zoneLayerId: String, zoneFeatureId: String) {
    val layer = getLayer(zoneLayerId)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "zoneLayerId not found")
    if (layer.projectId != projectId) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "zoneLayerId belongs to another project")
    }
    val layerGeometryType = layer.geometryType.uppercase()
    if (!layerGeometryType.contains("POLYGON") && layerGeometryType != "GEOMETRY") {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer must be a polygon layer")
    }
    val feature = getFeature(zoneLayerId, zoneFeatureId)
    val featureGeometryType = feature.geometry?.jsonObject?.get("type")?.jsonPrimitive?.contentOrNull?.uppercase()
    if (featureGeometryType?.contains("POLYGON") != true) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone feature must be a polygon")
    }
}

private fun Database.validateZoneLayerGeometry(layer: LayerDto) {
    val geometryType = layer.geometryType.uppercase()
    if (!geometryType.contains("POLYGON") && geometryType != "GEOMETRY") {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Zone layer must be polygon geometry")
    }
}

private fun Database.validateZoneSourceLayerGeometry(layer: LayerDto) {
    val geometryType = layer.geometryType.uppercase()
    if (!geometryType.contains("POINT") && !geometryType.contains("POLYGON") && geometryType != "GEOMETRY") {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Source layer must be point or polygon geometry")
    }
}

private fun Database.syncZonesForLayer(
    connection: Connection,
    layer: LayerDto,
    zoneType: String?,
    status: String?,
    nameField: String?
): ZoneLayerSyncCounts {
    validateZoneLayerGeometry(layer)
    val tableRef = "${quoteIdent(layer.schemaName)}.${quoteIdent(layer.tableName)}"
    val featureIdRef = "t.${quoteIdent(layer.featureIdColumn)}"
    val geometryRef = "t.${quoteIdent(layer.geometryColumn)}"
    val existingCount = connection.prepareStatement("SELECT count(*)::int FROM app.zones WHERE zone_layer_id = ?::uuid").use { stmt ->
        stmt.setString(1, layer.id)
        stmt.executeQuery().use { rs ->
            rs.next()
            rs.getInt(1)
        }
    }
    val nameExpression = zoneNameExpression(layer, nameField)
    val normalizedStatus = status?.trim()?.takeIf { it.isNotEmpty() } ?: "有効"
    val normalizedZoneType = zoneType?.trim()?.takeIf { it.isNotEmpty() }
    val affected = connection.prepareStatement(
        """
        INSERT INTO app.zones (
            id, project_id, name, zone_type, status, memo,
            zone_layer_id, zone_feature_id, source_layer_id, source_feature_id
        )
        SELECT
            concat('Z-', replace(?::text, '-', ''), '-', $featureIdRef::text) AS id,
            ?::uuid AS project_id,
            COALESCE($nameExpression, concat('区域 ', $featureIdRef::text)) AS name,
            ? AS zone_type,
            ? AS status,
            NULL::text AS memo,
            ?::uuid AS zone_layer_id,
            $featureIdRef::text AS zone_feature_id,
            ?::uuid AS source_layer_id,
            $featureIdRef::text AS source_feature_id
        FROM $tableRef AS t
        WHERE $geometryRef IS NOT NULL
          AND GeometryType($geometryRef) ILIKE '%POLYGON%'
        ON CONFLICT (zone_layer_id, zone_feature_id) DO UPDATE
        SET name = EXCLUDED.name,
            zone_type = COALESCE(app.zones.zone_type, EXCLUDED.zone_type),
            status = COALESCE(app.zones.status, EXCLUDED.status),
            source_layer_id = EXCLUDED.source_layer_id,
            source_feature_id = EXCLUDED.source_feature_id,
            updated_at = now()
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, layer.id)
        stmt.setString(2, layer.projectId)
        setNullableString(stmt, 3, normalizedZoneType)
        stmt.setString(4, normalizedStatus)
        stmt.setString(5, layer.id)
        stmt.setString(6, layer.id)
        stmt.executeUpdate()
    }
    val nextCount = connection.prepareStatement("SELECT count(*)::int FROM app.zones WHERE zone_layer_id = ?::uuid").use { stmt ->
        stmt.setString(1, layer.id)
        stmt.executeQuery().use { rs ->
            rs.next()
            rs.getInt(1)
        }
    }
    val created = (nextCount - existingCount).coerceAtLeast(0)
    return ZoneLayerSyncCounts(created = created, updated = (affected - created).coerceAtLeast(0))
}

private fun Database.zoneNameExpression(layer: LayerDto, requestedNameField: String?): String {
    val attributeNames = layer.attributes.map { it.name }.toSet()
    val requested = requestedNameField?.trim()?.takeIf { it.isNotEmpty() }
    if (requested != null && requested !in attributeNames) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Unknown zone name field: $requested")
    }
    val candidates = buildList {
        if (requested != null) add(requested)
        addAll(listOf("name", "区域名", "title", "zone_name", "Name", "NAME"))
    }.distinct().filter { it in attributeNames }
    if (candidates.isEmpty()) return "NULL"
    return candidates.joinToString(", ") { "NULLIF(t.${quoteIdent(it)}::text, '')" }
}

private fun Database.createSourceZoneBufferTable(
    connection: Connection,
    tableName: String,
    sourceLayer: LayerDto,
    layerName: String
) {
    val tableRef = "${quoteIdent("gis_data")}.${quoteIdent(tableName)}"
    val sourceRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
    val rawSourceGeom = "s.${quoteIdent(sourceLayer.geometryColumn)}"
    val sourceGeom = if (sourceLayer.displaySrid == 3857) rawSourceGeom else "ST_Transform($rawSourceGeom, 3857)"
    connection.createStatement().use { stmt ->
        stmt.execute("DROP TABLE IF EXISTS $tableRef")
    }
    val sql = """
        CREATE TABLE $tableRef AS
        WITH source_parts AS (
            SELECT ST_CollectionExtract(ST_MakeValid($sourceGeom), 3) AS geom
            FROM $sourceRef AS s
            WHERE $rawSourceGeom IS NOT NULL

            UNION ALL

            SELECT ST_CollectionExtract(ST_MakeValid($sourceGeom), 1) AS geom
            FROM $sourceRef AS s
            WHERE $rawSourceGeom IS NOT NULL
        ),
        source_geoms AS (
            SELECT geom
            FROM source_parts
            WHERE geom IS NOT NULL
              AND NOT ST_IsEmpty(geom)
        ),
        merged AS (
            SELECT count(*)::integer AS source_feature_count,
                   ST_MemUnion(ST_Buffer(geom, ?::double precision)) AS geom
            FROM source_geoms
        )
        SELECT
            1::integer AS fid,
            ?::text AS name,
            'source_buffer'::text AS operation,
            ?::double precision AS buffer_meters,
            ?::uuid AS source_layer_id,
            source_feature_count,
            ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))::geometry(MultiPolygon, 3857) AS geom
        FROM merged
        WHERE geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND source_feature_count > 0
    """.trimIndent()
    connection.prepareStatement(sql).use { stmt ->
        stmt.setDouble(1, SOURCE_ZONE_BUFFER_METERS)
        stmt.setString(2, layerName)
        stmt.setDouble(3, SOURCE_ZONE_BUFFER_METERS)
        stmt.setString(4, sourceLayer.id)
        stmt.execute()
    }
}
