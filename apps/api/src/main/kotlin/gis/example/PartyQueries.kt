// 関係者 (app.parties) と関係 (app.party_relationships) の CRUD・参照ヘルパ

package gis.example

import kotlinx.serialization.json.JsonObject
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.SQLException

fun Database.listParties(query: PartyListQuery): PagedList<PartyDto> = dataSource.connection.use { connection ->
    val filters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    val textQuery = query.q?.trim()?.takeIf { it.isNotEmpty() }
    if (!query.projectId.isNullOrBlank()) {
        filters.add("p.project_id = ?::uuid")
        binders.add { stmt, index -> stmt.setString(index, query.projectId) }
    }
    if (textQuery != null) {
        filters.add(
            """
            (
                lower(${partySearchTextSql("p")}) LIKE lower(?)
                OR EXISTS (
                    SELECT 1
                    FROM app.party_relationships AS r
                    LEFT JOIN app.lands AS l ON r.target_type = 'land' AND l.id = r.target_id
                    LEFT JOIN app.buildings AS b ON r.target_type = 'building' AND b.id = r.target_id
                    WHERE r.party_id = p.id
                      AND lower(${partyRelationshipTargetSearchTextSql("r", "l", "b")}) LIKE lower(?)
                )
            )
            """.trimIndent()
        )
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
        binders.add { stmt, index -> stmt.setString(index, "%$textQuery%") }
    }
    query.partyType?.trim()?.takeIf { it.isNotEmpty() }?.let { value ->
        filters.add("p.party_type ILIKE ?")
        binders.add { stmt, index -> stmt.setString(index, "%$value%") }
    }
    val relationType = query.relationType?.trim()?.takeIf { it.isNotEmpty() }
    val targetType = query.targetType?.trim()?.takeIf { it.isNotEmpty() }
    if (query.linkedOnly || relationType != null || targetType != null) {
        val relationshipFilters = mutableListOf("r.party_id = p.id")
        if (relationType != null) {
            relationshipFilters.add("r.relation_type ILIKE ?")
            binders.add { stmt, index -> stmt.setString(index, "%$relationType%") }
        }
        if (targetType != null) {
            if (targetType !in setOf("land", "building")) {
                throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetType must be land or building")
            }
            relationshipFilters.add("r.target_type = ?")
            binders.add { stmt, index -> stmt.setString(index, targetType) }
        }
        filters.add(
            """
            EXISTS (
                SELECT 1
                FROM app.party_relationships AS r
                WHERE ${relationshipFilters.joinToString(" AND ")}
            )
            """.trimIndent()
        )
    }
    val baseSql = """
        FROM app.parties AS p
        ${whereClause(filters)}
    """.trimIndent()
    val totalCount = queryTotalCount(connection, baseSql, binders)
    val sql = """
        SELECT p.id, p.project_id::text, p.name, p.party_type, p.contact, p.address, p.memo, p.tags
        $baseSql
        ORDER BY p.id${pagingClause(query.limit, query.offset)}
    """.trimIndent()
    val items = connection.prepareStatement(sql).use { stmt ->
        bindPatchValues(stmt, binders)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toPartyDto())
            }
        }
    }
    // 行ごとの個別クエリ (N+1) を避け、ページ内の関係者 ID をまとめて引く
    val relationships = listRelationshipsForParties(connection, items.map { it.id })
    PagedList(
        items = items.map { party -> party.copy(relationships = relationships[party.id].orEmpty()) },
        totalCount = totalCount
    )
}

fun Database.getParty(id: String): PartyDto? = dataSource.connection.use { connection ->
    val party = connection.prepareStatement(
        """
        SELECT id, project_id::text, name, party_type, contact, address, memo, tags
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

fun Database.createParty(request: JsonObject, audit: AuditTrail): PartyDto = try {
    dataSource.connection.use { connection ->
        val id = readRequiredText(request, "id")
        val projectId = readRequiredUuid(request, "projectId")
        val name = readRequiredText(request, "name")
        val partyType = readRequiredText(request, "partyType")
        val contact = readOptionalText(request, "contact")
        val address = readOptionalText(request, "address")
        val memo = readOptionalText(request, "memo")
        val tags = readTextArray(request, "tags") ?: emptyList()
        connection.prepareStatement(
            """
            INSERT INTO app.parties (id, project_id, name, party_type, contact, address, memo, tags)
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.setString(2, projectId)
            stmt.setString(3, name)
            stmt.setString(4, partyType)
            setNullableString(stmt, 5, contact)
            setNullableString(stmt, 6, address)
            setNullableString(stmt, 7, memo)
            stmt.setArray(8, connection.createArrayOf("text", tags.toTypedArray()))
            stmt.executeQuery().use { rs ->
                rs.next()
                val created = getParty(rs.getString("id")) ?: error("Created party disappeared")
                audit.recordCreate("party", created.id, created.auditSnapshot())
                created
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party create failed: ${exc.message ?: "invalid party create"}")
}

fun Database.updateParty(id: String, request: JsonObject, audit: AuditTrail): PartyDto = try {
    dataSource.connection.use { connection ->
        // 監査 diff 用の変更前スナップショット (存在しない ID は従来どおり 404)
        val before = getParty(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
        val setters = mutableListOf<String>()
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
        addTextPatch(request, "name", "name", setters, binders, required = true)
        addTextPatch(request, "partyType", "party_type", setters, binders, required = true)
        addTextPatch(request, "contact", "contact", setters, binders)
        addTextPatch(request, "address", "address", setters, binders)
        addTextPatch(request, "memo", "memo", setters, binders)
        addTextArrayPatch(request, "tags", "tags", setters, binders)
        if (setters.isEmpty()) {
            audit.recordUpdate("party", id, before.auditSnapshot(), before.auditSnapshot())
            return@use before
        }

        val updated = connection.prepareStatement(
            """
            UPDATE app.parties
            SET ${setters.joinToString(", ")}, updated_at = now()
            WHERE id = ?
            RETURNING id, project_id::text, name, party_type, contact, address, memo, tags
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
        val result = updated.copy(relationships = listRelationshipsForParty(connection, id))
        audit.recordUpdate("party", id, before.auditSnapshot(), result.auditSnapshot())
        result
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party update failed: ${exc.message ?: "invalid party update"}")
}

fun Database.deleteParty(id: String, audit: AuditTrail) {
    // 監査 diff 用の削除前スナップショット (存在しない ID は従来どおり 404)
    val before = getParty(id) ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
    dataSource.connection.use { connection ->
        val deleted = connection.prepareStatement("DELETE FROM app.parties WHERE id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate()
        }
        if (deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Party not found")
        }
    }
    audit.recordDelete("party", id, before.auditSnapshot())
}

fun Database.createPartyRelationship(request: JsonObject, audit: AuditTrail): PartyRelationshipDto = try {
    dataSource.connection.use { connection ->
        val projectId = readRequiredUuid(request, "projectId")
        val partyId = readRequiredText(request, "partyId")
        val targetType = readRequiredTargetType(request, "targetType")
        val targetId = readRequiredText(request, "targetId")
        val relationType = readRequiredText(request, "relationType")
        val note = readOptionalText(request, "note")
        validateRelationshipTarget(connection, projectId, partyId, targetType, targetId)
        connection.prepareStatement(
            """
            INSERT INTO app.party_relationships (project_id, party_id, target_type, target_id, relation_type, note)
            VALUES (?::uuid, ?, ?, ?, ?, ?)
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setString(2, partyId)
            stmt.setString(3, targetType)
            stmt.setString(4, targetId)
            stmt.setString(5, relationType)
            setNullableString(stmt, 6, note)
            stmt.executeQuery().use { rs ->
                rs.next()
                val created = getPartyRelationship(connection, rs.getString("id"))
                    ?: error("Created relationship disappeared")
                audit.recordCreate("partyRelationship", created.id, created.auditSnapshot())
                created
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Relationship create failed: ${exc.message ?: "invalid relationship create"}")
}

fun Database.updatePartyRelationship(id: String, request: JsonObject, audit: AuditTrail): PartyRelationshipDto = try {
    dataSource.connection.use { connection ->
        val current = getPartyRelationship(connection, id)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
        val partyId = readOptionalText(request, "partyId") ?: current.partyId
        val targetType = readOptionalTargetType(request, "targetType") ?: current.targetType
        val targetId = readOptionalText(request, "targetId") ?: current.targetId
        val relationType = readOptionalText(request, "relationType") ?: current.relationType
        val note = if ("note" in request) readOptionalText(request, "note") else current.note
        validateRelationshipTarget(connection, current.projectId, partyId, targetType, targetId)
        connection.prepareStatement(
            """
            UPDATE app.party_relationships
            SET party_id = ?, target_type = ?, target_id = ?, relation_type = ?, note = ?
            WHERE id = ?::uuid
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, partyId)
            stmt.setString(2, targetType)
            stmt.setString(3, targetId)
            stmt.setString(4, relationType)
            setNullableString(stmt, 5, note)
            stmt.setString(6, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
                val updated = getPartyRelationship(connection, rs.getString("id"))
                    ?: error("Updated relationship disappeared")
                audit.recordUpdate("partyRelationship", id, current.auditSnapshot(), updated.auditSnapshot())
                updated
            }
        }
    }
} catch (exc: SQLException) {
    throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Relationship update failed: ${exc.message ?: "invalid relationship update"}")
}

fun Database.deletePartyRelationship(id: String, audit: AuditTrail) {
    dataSource.connection.use { connection ->
        // 監査 diff 用の削除前スナップショット (存在しない ID は従来どおり 404)
        val before = getPartyRelationship(connection, id)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
        val deleted = connection.prepareStatement("DELETE FROM app.party_relationships WHERE id = ?::uuid").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate()
        }
        if (deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Relationship not found")
        }
        audit.recordDelete("partyRelationship", id, before.auditSnapshot())
    }
}

internal fun Database.listRelationshipsForTarget(connection: Connection, targetType: String, targetId: String): List<PartyRelationshipDto> =
    connection.prepareStatement(relationshipSelectSql("WHERE r.target_type = ? AND r.target_id = ? ORDER BY r.relation_type, p.name")).use { stmt ->
        stmt.setString(1, targetType)
        stmt.setString(2, targetId)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toPartyRelationshipDto())
            }
        }
    }

// listRelationshipsForTarget の一括版。並び順は単体版と同じで、対象 ID ごとにグループ化して返す
internal fun Database.listRelationshipsForTargets(
    connection: Connection,
    targetType: String,
    targetIds: List<String>
): Map<String, List<PartyRelationshipDto>> {
    if (targetIds.isEmpty()) return emptyMap()
    return connection.prepareStatement(
        relationshipSelectSql("WHERE r.target_type = ? AND r.target_id = ANY(?) ORDER BY r.relation_type, p.name")
    ).use { stmt ->
        stmt.setString(1, targetType)
        stmt.setArray(2, connection.createArrayOf("text", targetIds.toTypedArray()))
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toPartyRelationshipDto())
            }
        }
    }.groupBy { it.targetId }
}

// listRelationshipsForParty の一括版
private fun Database.listRelationshipsForParties(connection: Connection, partyIds: List<String>): Map<String, List<PartyRelationshipDto>> {
    if (partyIds.isEmpty()) return emptyMap()
    return connection.prepareStatement(
        relationshipSelectSql("WHERE r.party_id = ANY(?) ORDER BY r.target_type, r.target_id")
    ).use { stmt ->
        stmt.setArray(1, connection.createArrayOf("text", partyIds.toTypedArray()))
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toPartyRelationshipDto())
            }
        }
    }.groupBy { it.partyId }
}

private fun Database.listRelationshipsForParty(connection: Connection, partyId: String): List<PartyRelationshipDto> =
    connection.prepareStatement(relationshipSelectSql("WHERE r.party_id = ? ORDER BY r.target_type, r.target_id")).use { stmt ->
        stmt.setString(1, partyId)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.toPartyRelationshipDto())
            }
        }
    }

private fun Database.getPartyRelationship(connection: Connection, id: String): PartyRelationshipDto? =
    connection.prepareStatement(relationshipSelectSql("WHERE r.id = ?::uuid")).use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) null else rs.toPartyRelationshipDto()
        }
    }

private fun Database.validateRelationshipTarget(
    connection: Connection,
    projectId: String,
    partyId: String,
    targetType: String,
    targetId: String
) {
    val partyProject = connection.prepareStatement("SELECT project_id::text FROM app.parties WHERE id = ?").use { stmt ->
        stmt.setString(1, partyId)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    } ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "partyId does not exist")
    if (partyProject != projectId) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Party belongs to another project")
    }
    val targetProjectSql = when (targetType) {
        "land" -> "SELECT project_id::text FROM app.lands WHERE id = ?"
        "building" -> "SELECT project_id::text FROM app.buildings WHERE id = ?"
        else -> throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetType must be land or building")
    }
    val targetProject = connection.prepareStatement(targetProjectSql).use { stmt ->
        stmt.setString(1, targetId)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    } ?: throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "targetId does not exist")
    if (targetProject != projectId) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "Target belongs to another project")
    }
}

private fun Database.relationshipSelectSql(where: String): String = """
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

private fun Database.partySearchTextSql(alias: String): String =
    """
    (
        coalesce($alias.id, '') || ' ' ||
        coalesce($alias.name, '') || ' ' ||
        coalesce($alias.party_type, '') || ' ' ||
        coalesce($alias.contact, '') || ' ' ||
        coalesce($alias.address, '') || ' ' ||
        coalesce($alias.memo, '')
    )
    """.trimIndent()

private fun Database.partyRelationshipTargetSearchTextSql(relationAlias: String, landAlias: String, buildingAlias: String): String =
    """
    (
        coalesce($relationAlias.relation_type, '') || ' ' ||
        coalesce($relationAlias.note, '') || ' ' ||
        coalesce($relationAlias.target_type, '') || ' ' ||
        coalesce($relationAlias.target_id, '') || ' ' ||
        coalesce($landAlias.lot_number, '') || ' ' ||
        coalesce($landAlias.address, '') || ' ' ||
        coalesce($landAlias.registered_owner, '') || ' ' ||
        coalesce($buildingAlias.name, '') || ' ' ||
        coalesce($buildingAlias.building_location, '') || ' ' ||
        coalesce($buildingAlias.house_number, '') || ' ' ||
        coalesce($buildingAlias.registered_owner, '')
    )
    """.trimIndent()
