// 業務エンティティ (土地・建物) の CRUD と業務リンク・リスト用の検索/空間フィルタ

package gis.example

import kotlinx.serialization.json.JsonObject
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.SQLException
import java.sql.Types

fun Database.getBusinessLinks(layerId: String, featureId: String): BusinessLinksDto = dataSource.connection.use { connection ->
    getBusinessLinks(connection, layerId, featureId)
}

internal fun Database.getBusinessLinks(connection: Connection, layerId: String, featureId: String): BusinessLinksDto = BusinessLinksDto(
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

fun Database.listLands(query: LandListQuery): List<LandDto> = dataSource.connection.use { connection ->
    val filters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
    if (!query.projectId.isNullOrBlank()) {
        filters.add("l.project_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, query.projectId) }
    }
    if (textQuery != null) {
        filters.add(
            """
            (
                lower(${landSearchTextSql("l")}) LIKE lower(?)
                OR EXISTS (
                    SELECT 1
                    FROM app.party_relationships AS r
                    JOIN app.parties AS p ON p.id = r.party_id
                    WHERE r.project_id = l.project_id
                      AND r.target_type = 'land'
                      AND r.target_id = l.id
                      AND lower(${relationshipSearchTextSql("r", "p")}) LIKE lower(?)
                )
            )
            """.trimIndent()
        )
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
    }
    query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("l.status ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    query.landUse?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("l.land_use ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    addRelationshipListFilter(
        targetType = "land",
        targetIdExpression = "l.id",
        projectIdExpression = "l.project_id",
        partyType = query.partyType,
        relationType = query.relationType,
        filters = filters,
        binders = binders
    )
    addBusinessListSpatialFilters(
        entityAlias = "l",
        projectId = query.projectId,
        linkedOnly = query.linkedOnly,
        sourceLayerId = query.sourceLayerId,
        bbox = query.bbox,
        intersectsLayerId = query.intersectsLayerId,
        intersectsFeatureId = query.intersectsFeatureId,
        distanceMeters = query.distanceMeters,
        filters = filters,
        binders = binders
    )
    val sql = """
        SELECT l.id, l.project_id::text, l.lot_number, l.address, l.land_use, l.area_sqm,
               l.registered_owner, l.right_type, l.registration_cause, l.registration_accepted_on::text,
               l.status, l.memo, l.source_layer_id::text, l.source_feature_id
        FROM app.lands AS l
        ${whereClause(filters)}
        ORDER BY l.id
    """.trimIndent()
    connection.prepareStatement(sql).use { stmt ->
        bindPatchValues(stmt, binders)
        stmt.executeQuery().use { rs ->
            val items = buildList {
                while (rs.next()) add(rs.toLandDto())
            }
            items.map { land ->
                land.copy(
                    buildings = listBuildingLinksForLand(connection, land.id),
                    relationships = listRelationshipsForTarget(connection, "land", land.id)
                )
            }
        }
    }
}

fun Database.getLand(id: String): LandDto? = dataSource.connection.use { connection ->
    val land = connection.prepareStatement(
        """
        SELECT id, project_id::text, lot_number, address, land_use, area_sqm,
               registered_owner, right_type, registration_cause, registration_accepted_on::text,
               status, memo, source_layer_id::text, source_feature_id
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

fun Database.createLand(request: JsonObject): LandDto = try {
    dataSource.connection.use { connection ->
        val id = readRequiredText(request, "id")
        val projectId = readRequiredUuid(request, "projectId")
        val lotNumber = readRequiredText(request, "lotNumber")
        val address = readRequiredText(request, "address")
        val landUse = readOptionalText(request, "landUse")
        val areaSqm = readOptionalDouble(request, "areaSqm")
        val registeredOwner = readOptionalText(request, "registeredOwner")
        val rightType = readOptionalText(request, "rightType")
        val registrationCause = readOptionalText(request, "registrationCause")
        val registrationAcceptedOn = readOptionalDate(request, "registrationAcceptedOn")
        val status = readOptionalText(request, "status") ?: "調査中"
        val memo = readOptionalText(request, "memo")
        val sourceLayerId = readOptionalUuid(request, "sourceLayerId")
        val sourceFeatureId = readOptionalText(request, "sourceFeatureId")
        connection.prepareStatement(
            """
            INSERT INTO app.lands (
                id, project_id, lot_number, address, land_use, area_sqm,
                registered_owner, right_type, registration_cause, registration_accepted_on,
                status, memo, source_layer_id, source_feature_id
            )
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?::uuid, ?)
            RETURNING id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.setString(2, projectId)
            stmt.setString(3, lotNumber)
            stmt.setString(4, address)
            setNullableString(stmt, 5, landUse)
            if (areaSqm == null) stmt.setNull(6, Types.DOUBLE) else stmt.setDouble(6, areaSqm)
            setNullableString(stmt, 7, registeredOwner)
            setNullableString(stmt, 8, rightType)
            setNullableString(stmt, 9, registrationCause)
            setNullableDateString(stmt, 10, registrationAcceptedOn)
            stmt.setString(11, status)
            setNullableString(stmt, 12, memo)
            setNullableUuidString(stmt, 13, sourceLayerId)
            setNullableString(stmt, 14, sourceFeatureId)
            stmt.executeQuery().use { rs ->
                rs.next()
                getLand(rs.getString("id")) ?: error("Created land disappeared")
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Land create failed: ${exc.message ?: "invalid land create"}")
}

fun Database.updateLand(id: String, request: JsonObject): LandDto = try {
    dataSource.connection.use { connection ->
        val setters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        addTextPatch(request, "lotNumber", "lot_number", setters, binders, required = true)
        addTextPatch(request, "address", "address", setters, binders, required = true)
        addTextPatch(request, "landUse", "land_use", setters, binders)
        addDoublePatch(request, "areaSqm", "area_sqm", setters, binders)
        addTextPatch(request, "registeredOwner", "registered_owner", setters, binders)
        addTextPatch(request, "rightType", "right_type", setters, binders)
        addTextPatch(request, "registrationCause", "registration_cause", setters, binders)
        addDatePatch(request, "registrationAcceptedOn", "registration_accepted_on", setters, binders)
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
                      registered_owner, right_type, registration_cause, registration_accepted_on::text,
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

fun Database.deleteLand(id: String) {
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

fun Database.listBuildings(query: BuildingListQuery): List<BuildingDto> = dataSource.connection.use { connection ->
    val filters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
    if (!query.projectId.isNullOrBlank()) {
        filters.add("b.project_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, query.projectId) }
    }
    if (!query.landId.isNullOrBlank()) {
        filters.add("b.land_id = ?")
        binders.add { stmt, index -> stmt.setString(index, query.landId) }
    }
    if (textQuery != null) {
        filters.add(
            """
            (
                lower(${buildingSearchTextSql("b", "l")}) LIKE lower(?)
                OR EXISTS (
                    SELECT 1
                    FROM app.party_relationships AS r
                    JOIN app.parties AS p ON p.id = r.party_id
                    WHERE r.project_id = b.project_id
                      AND r.target_type = 'building'
                      AND r.target_id = b.id
                      AND lower(${relationshipSearchTextSql("r", "p")}) LIKE lower(?)
                )
            )
            """.trimIndent()
        )
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
    }
    query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("b.status ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    query.buildingUse?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("b.building_use ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    addRelationshipListFilter(
        targetType = "building",
        targetIdExpression = "b.id",
        projectIdExpression = "b.project_id",
        partyType = query.partyType,
        relationType = query.relationType,
        filters = filters,
        binders = binders
    )
    addBusinessListSpatialFilters(
        entityAlias = "b",
        projectId = query.projectId,
        linkedOnly = query.linkedOnly,
        sourceLayerId = query.sourceLayerId,
        bbox = query.bbox,
        intersectsLayerId = query.intersectsLayerId,
        intersectsFeatureId = query.intersectsFeatureId,
        distanceMeters = query.distanceMeters,
        filters = filters,
        binders = binders
    )
    val sql = """
        SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
               b.name, b.building_location, b.house_number, b.building_use, b.floors,
               b.total_floor_area_sqm, b.structure, b.registered_owner, b.right_type,
               b.registration_accepted_on::text, b.status, b.memo, b.source_layer_id::text, b.source_feature_id
        FROM app.buildings AS b
        LEFT JOIN app.lands AS l ON l.id = b.land_id
        ${whereClause(filters)}
        ORDER BY b.id
    """.trimIndent()
    connection.prepareStatement(sql).use { stmt ->
        bindPatchValues(stmt, binders)
        stmt.executeQuery().use { rs ->
            val items = buildList {
                while (rs.next()) add(rs.toBuildingDto())
            }
            items.map { building ->
                building.copy(relationships = listRelationshipsForTarget(connection, "building", building.id))
            }
        }
    }
}

fun Database.getBuilding(id: String): BuildingDto? = dataSource.connection.use { connection ->
    val building = connection.prepareStatement(
        """
        SELECT b.id, b.project_id::text, b.land_id, concat(l.lot_number, ' · ', l.address) AS land_label,
               b.name, b.building_location, b.house_number, b.building_use, b.floors,
               b.total_floor_area_sqm, b.structure, b.registered_owner, b.right_type,
               b.registration_accepted_on::text, b.status, b.memo, b.source_layer_id::text, b.source_feature_id
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

fun Database.createBuilding(request: JsonObject): BuildingDto = try {
    dataSource.connection.use { connection ->
        val id = readRequiredText(request, "id")
        val projectId = readRequiredUuid(request, "projectId")
        val landId = readOptionalText(request, "landId")
        val name = readRequiredText(request, "name")
        val buildingLocation = readOptionalText(request, "buildingLocation")
        val houseNumber = readOptionalText(request, "houseNumber")
        val buildingUse = readOptionalText(request, "buildingUse")
        val floors = readOptionalInt(request, "floors")
        val totalFloorAreaSqm = readOptionalDouble(request, "totalFloorAreaSqm")
        val structure = readOptionalText(request, "structure")
        val registeredOwner = readOptionalText(request, "registeredOwner")
        val rightType = readOptionalText(request, "rightType")
        val registrationAcceptedOn = readOptionalDate(request, "registrationAcceptedOn")
        val status = readOptionalText(request, "status") ?: "調査中"
        val memo = readOptionalText(request, "memo")
        val sourceLayerId = readOptionalUuid(request, "sourceLayerId")
        val sourceFeatureId = readOptionalText(request, "sourceFeatureId")
        connection.prepareStatement(
            """
            INSERT INTO app.buildings (
                id, project_id, land_id, name, building_location, house_number,
                building_use, floors, total_floor_area_sqm, structure,
                registered_owner, right_type, registration_accepted_on,
                status, memo, source_layer_id, source_feature_id
            )
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?::uuid, ?)
            RETURNING id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.setString(2, projectId)
            setNullableString(stmt, 3, landId)
            stmt.setString(4, name)
            setNullableString(stmt, 5, buildingLocation)
            setNullableString(stmt, 6, houseNumber)
            setNullableString(stmt, 7, buildingUse)
            if (floors == null) stmt.setNull(8, Types.INTEGER) else stmt.setInt(8, floors)
            if (totalFloorAreaSqm == null) stmt.setNull(9, Types.DOUBLE) else stmt.setDouble(9, totalFloorAreaSqm)
            setNullableString(stmt, 10, structure)
            setNullableString(stmt, 11, registeredOwner)
            setNullableString(stmt, 12, rightType)
            setNullableDateString(stmt, 13, registrationAcceptedOn)
            stmt.setString(14, status)
            setNullableString(stmt, 15, memo)
            setNullableUuidString(stmt, 16, sourceLayerId)
            setNullableString(stmt, 17, sourceFeatureId)
            stmt.executeQuery().use { rs ->
                rs.next()
                getBuilding(rs.getString("id")) ?: error("Created building disappeared")
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Building create failed: ${exc.message ?: "invalid building create"}")
}

fun Database.updateBuilding(id: String, request: JsonObject): BuildingDto = try {
    dataSource.connection.use { connection ->
        val setters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        addTextPatch(request, "landId", "land_id", setters, binders)
        addTextPatch(request, "name", "name", setters, binders, required = true)
        addTextPatch(request, "buildingLocation", "building_location", setters, binders)
        addTextPatch(request, "houseNumber", "house_number", setters, binders)
        addTextPatch(request, "buildingUse", "building_use", setters, binders)
        addIntPatch(request, "floors", "floors", setters, binders)
        addDoublePatch(request, "totalFloorAreaSqm", "total_floor_area_sqm", setters, binders)
        addTextPatch(request, "structure", "structure", setters, binders)
        addTextPatch(request, "registeredOwner", "registered_owner", setters, binders)
        addTextPatch(request, "rightType", "right_type", setters, binders)
        addDatePatch(request, "registrationAcceptedOn", "registration_accepted_on", setters, binders)
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

fun Database.deleteBuilding(id: String) {
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

private fun Database.listBuildingLinksForLand(connection: Connection, landId: String): List<BusinessEntityLinkDto> =
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

private fun Database.landSearchTextSql(alias: String): String =
    """
    (
        coalesce($alias.id, '') || ' ' ||
        coalesce($alias.lot_number, '') || ' ' ||
        coalesce($alias.address, '') || ' ' ||
        coalesce($alias.land_use, '') || ' ' ||
        coalesce($alias.status, '') || ' ' ||
        coalesce($alias.memo, '') || ' ' ||
        coalesce($alias.registered_owner, '') || ' ' ||
        coalesce($alias.right_type, '') || ' ' ||
        coalesce($alias.registration_cause, '') || ' ' ||
        coalesce($alias.registration_accepted_on::text, '')
    )
    """.trimIndent()

private fun Database.buildingSearchTextSql(alias: String, landAlias: String): String =
    """
    (
        coalesce($alias.id, '') || ' ' ||
        coalesce($alias.name, '') || ' ' ||
        coalesce($alias.building_location, '') || ' ' ||
        coalesce($alias.house_number, '') || ' ' ||
        coalesce($alias.building_use, '') || ' ' ||
        coalesce($alias.structure, '') || ' ' ||
        coalesce($alias.status, '') || ' ' ||
        coalesce($alias.memo, '') || ' ' ||
        coalesce($alias.registered_owner, '') || ' ' ||
        coalesce($alias.right_type, '') || ' ' ||
        coalesce($alias.registration_accepted_on::text, '') || ' ' ||
        coalesce($landAlias.id, '') || ' ' ||
        coalesce($landAlias.lot_number, '') || ' ' ||
        coalesce($landAlias.address, '')
    )
    """.trimIndent()

private fun Database.relationshipSearchTextSql(relationAlias: String, partyAlias: String): String =
    """
    (
        coalesce($relationAlias.relation_type, '') || ' ' ||
        coalesce($relationAlias.note, '') || ' ' ||
        coalesce($partyAlias.id, '') || ' ' ||
        coalesce($partyAlias.name, '') || ' ' ||
        coalesce($partyAlias.party_type, '') || ' ' ||
        coalesce($partyAlias.contact, '') || ' ' ||
        coalesce($partyAlias.address, '') || ' ' ||
        coalesce($partyAlias.memo, '')
    )
    """.trimIndent()

private fun Database.addRelationshipListFilter(
    targetType: String,
    targetIdExpression: String,
    projectIdExpression: String,
    partyType: String?,
    relationType: String?,
    filters: MutableList<String>,
    binders: MutableList<(PreparedStatement, Int) -> Unit>
) {
    val requestedPartyType = partyType?.trim()?.takeIf { it.isNotEmpty() }
    val requestedRelationType = relationType?.trim()?.takeIf { it.isNotEmpty() }
    if (requestedPartyType == null && requestedRelationType == null) return
    val relationshipFilters = mutableListOf(
        "r.project_id = $projectIdExpression",
        "r.target_type = '$targetType'",
        "r.target_id = $targetIdExpression"
    )
    if (requestedPartyType != null) {
        relationshipFilters.add("p.party_type ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$requestedPartyType%") }
    }
    if (requestedRelationType != null) {
        relationshipFilters.add("r.relation_type ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$requestedRelationType%") }
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

private fun Database.addBusinessListSpatialFilters(
    entityAlias: String,
    projectId: String?,
    linkedOnly: Boolean,
    sourceLayerId: String?,
    bbox: String?,
    intersectsLayerId: String?,
    intersectsFeatureId: String?,
    distanceMeters: Double?,
    filters: MutableList<String>,
    binders: MutableList<(PreparedStatement, Int) -> Unit>
) {
    val requestedSourceLayerId = sourceLayerId?.trim()?.takeIf { it.isNotEmpty() }
    if (linkedOnly) {
        filters.add("$entityAlias.source_layer_id IS NOT NULL AND $entityAlias.source_feature_id IS NOT NULL")
    }
    if (requestedSourceLayerId != null) {
        filters.add("$entityAlias.source_layer_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, requestedSourceLayerId) }
    }

    val bboxBounds = parseBbox(bbox)
    val targetLayerId = intersectsLayerId?.trim()?.takeIf { it.isNotEmpty() }
    val targetFeatureId = intersectsFeatureId?.trim()?.takeIf { it.isNotEmpty() }
    if (bboxBounds == null && (targetLayerId == null || targetFeatureId == null)) return

    val sourceLayers = resolveSpatialSourceLayers(projectId, requestedSourceLayerId)
    val targetLayer = if (targetLayerId != null && targetFeatureId != null) {
        getLayer(targetLayerId) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "intersectsLayerId not found")
    } else {
        null
    }
    if (projectId != null && targetLayer != null && targetLayer.projectId != projectId) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "intersectsLayerId belongs to another project")
    }

    val spatialClauses = mutableListOf<String>()
    val spatialBinders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    for (sourceLayer in sourceLayers) {
        val sourceTableRef = "${quoteIdent(sourceLayer.schemaName)}.${quoteIdent(sourceLayer.tableName)}"
        val sourceFeatureIdRef = "src.${quoteIdent(sourceLayer.featureIdColumn)}"
        val sourceGeomRef = "src.${quoteIdent(sourceLayer.geometryColumn)}"
        val clauseBinders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        val joins = StringBuilder()
        var targetGeomRef: String? = null
        if (targetLayer != null && targetFeatureId != null) {
            val targetTableRef = "${quoteIdent(targetLayer.schemaName)}.${quoteIdent(targetLayer.tableName)}"
            val targetFeatureIdRef = "target.${quoteIdent(targetLayer.featureIdColumn)}"
            joins.append(" JOIN $targetTableRef AS target ON $targetFeatureIdRef::text = ?")
            clauseBinders.add { stmt, index -> stmt.setString(index, targetFeatureId) }
            val rawTargetGeom = "target.${quoteIdent(targetLayer.geometryColumn)}"
            targetGeomRef = if (targetLayer.displaySrid == sourceLayer.displaySrid) {
                rawTargetGeom
            } else {
                "ST_Transform($rawTargetGeom, ${sourceLayer.displaySrid})"
            }
        }
        if (bboxBounds != null) {
            if (joins.isNotEmpty()) joins.append('\n')
            joins.append(
                """
                CROSS JOIN (
                    SELECT ST_Transform(ST_MakeEnvelope(?::double precision, ?::double precision, ?::double precision, ?::double precision, 4326), ${sourceLayer.displaySrid}) AS geom
                ) AS bbox
                """.trimIndent()
            )
            clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[0]) }
            clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[1]) }
            clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[2]) }
            clauseBinders.add { stmt, index -> stmt.setDouble(index, bboxBounds[3]) }
        }
        val geometryFilters = mutableListOf(
            "$entityAlias.source_layer_id = ?::uuid",
            "$entityAlias.source_feature_id = $sourceFeatureIdRef::text",
            "$sourceGeomRef IS NOT NULL"
        )
        clauseBinders.add { stmt, index -> stmt.setString(index, sourceLayer.id) }
        if (bboxBounds != null) {
            geometryFilters.add("$sourceGeomRef && bbox.geom")
            geometryFilters.add("ST_Intersects($sourceGeomRef, bbox.geom)")
        }
        if (targetGeomRef != null) {
            geometryFilters.add("target.${quoteIdent(targetLayer!!.geometryColumn)} IS NOT NULL")
            if (distanceMeters != null && distanceMeters > 0.0) {
                geometryFilters.add("ST_DWithin($sourceGeomRef, $targetGeomRef, ?::double precision)")
                clauseBinders.add { stmt, index -> stmt.setDouble(index, distanceMeters) }
            } else {
                geometryFilters.add("$sourceGeomRef && $targetGeomRef")
                geometryFilters.add("ST_Intersects($sourceGeomRef, $targetGeomRef)")
            }
        }
        spatialClauses.add(
            """
            EXISTS (
                SELECT 1
                FROM $sourceTableRef AS src
                $joins
                WHERE ${geometryFilters.joinToString(" AND ")}
            )
            """.trimIndent()
        )
        spatialBinders.addAll(clauseBinders)
    }
    if (spatialClauses.isEmpty()) {
        filters.add("false")
    } else {
        filters.add(spatialClauses.joinToString(separator = "\nOR\n", prefix = "(", postfix = ")"))
        binders.addAll(spatialBinders)
    }
}

private fun Database.resolveSpatialSourceLayers(projectId: String?, sourceLayerId: String?): List<LayerDto> {
    if (sourceLayerId != null) {
        val layer = getLayer(sourceLayerId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "sourceLayerId not found")
        if (projectId != null && layer.projectId != projectId) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "sourceLayerId belongs to another project")
        }
        return listOf(layer)
    }
    return listLayers(projectId).filter { !it.isResult && it.layerRole != "zone" }
}

internal fun Database.businessGeometrySql(
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
            addBusinessChoiceFilter(request.status, "l.status", landFilters, landBinders)
            addBusinessChoiceFilter(request.landUse, "l.land_use", landFilters, landBinders)
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
            addBusinessChoiceFilter(request.status, "b.status", buildingFilters, buildingBinders)
            addBusinessChoiceFilter(request.buildingUse, "b.building_use", buildingFilters, buildingBinders)
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

internal fun Database.addBusinessQueryFilter(
    query: String?,
    textExpression: String,
    filters: MutableList<String>,
    binders: MutableList<(PreparedStatement, Int) -> Unit>
) {
    val value = query?.trim()?.takeIf { it.isNotEmpty() } ?: return
    filters.add("lower($textExpression) LIKE lower(?)")
    binders.add { stmt, index -> stmt.setString(index, "%$value%") }
}

internal fun Database.addBusinessChoiceFilter(
    value: String?,
    columnExpression: String,
    filters: MutableList<String>,
    binders: MutableList<(PreparedStatement, Int) -> Unit>
) {
    val choice = value?.trim()?.takeIf { it.isNotEmpty() } ?: return
    filters.add("$columnExpression ILIKE ?")
    binders.add { stmt, index -> stmt.setString(index, choice) }
}

internal fun Database.addPartyRelationshipFilter(
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

internal fun Database.spatialPredicateSql(
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
