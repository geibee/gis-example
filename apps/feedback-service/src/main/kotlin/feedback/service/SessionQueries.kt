package feedback.service

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Types
import java.time.OffsetDateTime
import java.time.Instant
import java.util.UUID

fun FeedbackDatabase.getManifest(scope: ResourceScope): Pair<JsonObject, Int> = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT manifest::text, version
        FROM feedback.application_manifests
        WHERE application_id = ?::uuid
        ORDER BY created_at DESC
        LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.applicationId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound("application manifest が登録されていません")
            serviceJson.parseToJsonElement(result.getString(1)) as JsonObject to result.getInt(2)
        }
    }
}

fun FeedbackDatabase.putManifest(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    manifest: JsonObject,
    expectedVersion: Int?
): Pair<JsonObject, Int> = transaction { connection ->
    val current = connection.prepareStatement(
        """
        SELECT manifest_version, manifest::text, version
        FROM feedback.application_manifests
        WHERE application_id = ?::uuid
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.applicationId)
        statement.executeQuery().use { result ->
            if (result.next()) Triple(result.getString(1), result.getString(2), result.getInt(3)) else null
        }
    }
    if (expectedVersion != null && current?.third != expectedVersion) preconditionFailed()
    val versionName = manifest.getValue("manifestVersion").jsonPrimitive.content
    if (current != null && current.first == versionName) {
        val existing = serviceJson.parseToJsonElement(current.second) as JsonObject
        if (existing != manifest) {
            conflict("同じ manifestVersion の内容は変更できません。新しい version を指定してください", "manifest.version_immutable")
        }
        return@transaction existing to current.third
    }
    val version = (current?.third ?: 0) + 1
    connection.prepareStatement(
        """
        INSERT INTO feedback.application_manifests (
            id, application_id, manifest_version, manifest, version, created_by
        ) VALUES (?::uuid, ?::uuid, ?, ?::jsonb, ?, ?)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, scope.applicationId)
        statement.setString(3, versionName)
        statement.setString(4, manifest.toString())
        statement.setInt(5, version)
        statement.setString(6, principal.subject)
        statement.executeUpdate()
    }
    manifest to version
}

fun FeedbackDatabase.listSessions(
    scope: ResourceScope,
    status: String?,
    limit: Int,
    offset: Int
): FeedbackSessionPage = dataSource.connection.use { connection ->
    val filter = if (status == null) "" else "AND s.status = ?"
    val totalCount = connection.prepareStatement(
        """
        SELECT count(*)
        FROM feedback.review_sessions s
        WHERE s.application_id = ?::uuid AND s.environment_id = ?::uuid AND s.workspace_id = ?::uuid
        $filter
        """.trimIndent()
    ).use { statement ->
        bindSessionScope(statement, scope, status)
        statement.executeQuery().use { result -> result.next(); result.getLong(1) }
    }
    val items = connection.prepareStatement(
        """
        SELECT s.*, a.application_key, e.environment_key, w.external_workspace_key
        FROM feedback.review_sessions s
        JOIN feedback.applications a ON a.id = s.application_id
        JOIN feedback.application_environments e ON e.id = s.environment_id
        JOIN feedback.workspaces w ON w.id = s.workspace_id
        WHERE s.application_id = ?::uuid AND s.environment_id = ?::uuid AND s.workspace_id = ?::uuid
        $filter
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ? OFFSET ?
        """.trimIndent()
    ).use { statement ->
        var index = bindSessionScope(statement, scope, status)
        statement.setInt(index++, limit)
        statement.setInt(index, offset)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) add(readSession(connection, result))
            }
        }
    }
    FeedbackSessionPage(
        items = items,
        nextCursor = if (offset + items.size < totalCount) encodeCursor(offset + items.size) else null,
        totalCount = totalCount
    )
}

private fun bindSessionScope(
    statement: java.sql.PreparedStatement,
    scope: ResourceScope,
    status: String?
): Int {
    var index = 1
    statement.setString(index++, scope.applicationId)
    statement.setString(index++, scope.environmentId)
    statement.setString(index++, scope.workspaceId)
    if (status != null) statement.setString(index++, status)
    return index
}

fun FeedbackDatabase.getSession(sessionId: String): FeedbackSession = dataSource.connection.use { connection ->
    readSessionById(connection, sessionId)
}

fun FeedbackDatabase.createSession(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    request: FeedbackSessionCreateRequest,
    idempotencyKey: String,
    hash: String
): FeedbackSession = try {
    idempotent(
        scope = scope,
        principal = principal,
        endpoint = "POST /sessions",
        key = idempotencyKey,
        requestHash = hash,
        responseStatus = 201,
        serializer = FeedbackSession.serializer()
    ) { connection ->
        validateSessionRequest(request)
        requireManifestVersion(connection, scope.applicationId, request.manifestVersion)
        val id = UUID.randomUUID().toString()
        connection.prepareStatement(
            """
            INSERT INTO feedback.review_sessions (
                id, tenant_id, application_id, environment_id, workspace_id, manifest_version,
                title, description, out_of_scope_posting, start_at, end_at, created_by
            ) VALUES (
                ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?
            )
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.tenantId)
            statement.setString(3, scope.applicationId)
            statement.setString(4, scope.environmentId)
            statement.setString(5, scope.workspaceId)
            statement.setString(6, request.manifestVersion)
            statement.setString(7, request.title.trim())
            statement.setString(8, request.description)
            statement.setString(9, request.outOfScopePosting)
            statement.setString(10, request.startAt)
            statement.setString(11, request.endAt)
            statement.setString(12, principal.subject)
            statement.executeUpdate()
        }
        insertSessionChildren(connection, id, request.scopes, request.perspectives)
        readSessionById(connection, id)
    }
} catch (exception: SQLException) {
    if (exception.sqlState == "23505") conflict("同じ application/environment/workspace に open session が存在します", "session.open_conflict")
    throw exception
}

fun FeedbackDatabase.patchSession(
    sessionId: String,
    expectedVersion: Int,
    patch: JsonObject
): FeedbackSession = try {
    transaction { connection ->
        val current = readSessionById(connection, sessionId)
        if (current.version != expectedVersion) preconditionFailed()
        validateSessionPatch(patch)
        val nextStart = patch["startAt"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content } ?: current.startAt
        val nextEnd = patch["endAt"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content } ?: current.endAt
        if (nextStart != null && nextEnd != null && Instant.parse(nextEnd).isBefore(Instant.parse(nextStart))) {
            badRequest("endAt は startAt 以後を指定してください")
        }
        connection.prepareStatement(
            """
            UPDATE feedback.review_sessions SET
                title = CASE WHEN ? THEN ? ELSE title END,
                description = CASE WHEN ? THEN ? ELSE description END,
                status = CASE WHEN ? THEN ? ELSE status END,
                out_of_scope_posting = CASE WHEN ? THEN ? ELSE out_of_scope_posting END,
                start_at = CASE WHEN ? THEN ?::timestamptz ELSE start_at END,
                end_at = CASE WHEN ? THEN ?::timestamptz ELSE end_at END,
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid AND version = ?
            """.trimIndent()
        ).use { statement ->
            setPatchString(statement, 1, patch, "title")
            setPatchString(statement, 3, patch, "description")
            setPatchString(statement, 5, patch, "status")
            setPatchString(statement, 7, patch, "outOfScopePosting")
            setPatchString(statement, 9, patch, "startAt")
            setPatchString(statement, 11, patch, "endAt")
            statement.setString(13, sessionId)
            statement.setInt(14, expectedVersion)
            if (statement.executeUpdate() != 1) preconditionFailed()
        }
        readSessionById(connection, sessionId)
    }
} catch (exception: SQLException) {
    if (exception.sqlState == "23505") conflict("同じ application/environment/workspace に open session が存在します", "session.open_conflict")
    throw exception
}

private fun setPatchString(
    statement: java.sql.PreparedStatement,
    index: Int,
    patch: JsonObject,
    key: String
) {
    statement.setBoolean(index, key in patch)
    val value = patch[key]
    if (value == null || value is JsonNull) statement.setNull(index + 1, Types.VARCHAR)
    else statement.setString(index + 1, value.jsonPrimitive.content)
}

private fun validateSessionRequest(request: FeedbackSessionCreateRequest) {
    validateApplicationKey(request.applicationKey)
    validateKey(request.environmentKey, "environmentKey", 100)
    validateKey(request.externalWorkspaceKey, "externalWorkspaceKey", 200)
    validateKey(request.manifestVersion, "manifestVersion", 100)
    validateKey(request.title, "title", 200)
    if (request.description != null && request.description.length > 5000) badRequest("description が長すぎます")
    if (request.outOfScopePosting !in setOf("allow", "warn", "deny")) badRequest("outOfScopePosting が不正です")
    validateInstant(request.startAt, "startAt")
    validateInstant(request.endAt, "endAt")
    if (request.startAt != null && request.endAt != null &&
        OffsetDateTime.parse(request.endAt).isBefore(OffsetDateTime.parse(request.startAt))) {
        badRequest("endAt は startAt 以後を指定してください")
    }
    validateSessionChildren(request.scopes, request.perspectives)
}

private fun validateSessionPatch(patch: JsonObject) {
    val allowed = setOf("title", "description", "status", "outOfScopePosting", "startAt", "endAt")
    if (patch.isEmpty()) badRequest("PATCH body が空です")
    if ((patch.keys - allowed).isNotEmpty()) badRequest("PATCH body に未知 field があります")
    patch["title"]?.let { validateKey(it.jsonPrimitive.content, "title", 200) }
    patch["description"]?.takeUnless { it is JsonNull }?.let {
        if (it.jsonPrimitive.content.length > 5000) badRequest("description が長すぎます")
    }
    patch["status"]?.let {
        if (it.jsonPrimitive.content !in setOf("draft", "open", "closed")) badRequest("status が不正です")
    }
    patch["outOfScopePosting"]?.let {
        if (it.jsonPrimitive.content !in setOf("allow", "warn", "deny")) badRequest("outOfScopePosting が不正です")
    }
    for (key in listOf("startAt", "endAt")) {
        patch[key]?.takeUnless { it is JsonNull }?.let { validateInstant(it.jsonPrimitive.content, key) }
    }
}

private fun validateSessionChildren(scopes: List<SessionScope>, perspectives: List<SessionPerspective>) {
    if (scopes.map { it.pageKey to it.routeTemplate }.toSet().size != scopes.size) badRequest("scope が重複しています")
    scopes.forEach {
        validateKey(it.pageKey, "scope.pageKey", 100)
        if (it.routeTemplate != null && it.routeTemplate.length > 500) badRequest("scope.routeTemplate が長すぎます")
    }
    if (perspectives.map { it.code }.toSet().size != perspectives.size) badRequest("perspective code が重複しています")
    perspectives.forEach {
        validateKey(it.code, "perspective.code", 100)
        validateKey(it.label, "perspective.label", 200)
        if (it.status !in setOf("active", "future", "out-of-scope")) badRequest("perspective.status が不正です")
        if (it.guidance != null && it.guidance.length > 5000) badRequest("perspective.guidance が長すぎます")
    }
}

private fun insertSessionChildren(
    connection: Connection,
    sessionId: String,
    scopes: List<SessionScope>,
    perspectives: List<SessionPerspective>
) {
    connection.prepareStatement(
        "INSERT INTO feedback.review_scopes (id, session_id, page_key, route_template, reviewable) VALUES (?::uuid, ?::uuid, ?, ?, ?)"
    ).use { statement ->
        scopes.forEach { scope ->
            statement.setString(1, UUID.randomUUID().toString())
            statement.setString(2, sessionId)
            statement.setString(3, scope.pageKey)
            statement.setString(4, scope.routeTemplate)
            statement.setBoolean(5, scope.reviewable)
            statement.addBatch()
        }
        statement.executeBatch()
    }
    connection.prepareStatement(
        """
        INSERT INTO feedback.review_session_perspectives (session_id, code, label, status, guidance)
        VALUES (?::uuid, ?, ?, ?, ?)
        """.trimIndent()
    ).use { statement ->
        perspectives.forEach { perspective ->
            statement.setString(1, sessionId)
            statement.setString(2, perspective.code)
            statement.setString(3, perspective.label)
            statement.setString(4, perspective.status)
            statement.setString(5, perspective.guidance)
            statement.addBatch()
        }
        statement.executeBatch()
    }
}

private fun requireManifestVersion(connection: Connection, applicationId: String, manifestVersion: String) {
    connection.prepareStatement(
        "SELECT 1 FROM feedback.application_manifests WHERE application_id = ?::uuid AND manifest_version = ?"
    ).use { statement ->
        statement.setString(1, applicationId)
        statement.setString(2, manifestVersion)
        statement.executeQuery().use { if (!it.next()) badRequest("manifestVersion が登録されていません") }
    }
}

internal fun readSessionById(connection: Connection, sessionId: String): FeedbackSession =
    connection.prepareStatement(
        """
        SELECT s.*, a.application_key, e.environment_key, w.external_workspace_key
        FROM feedback.review_sessions s
        JOIN feedback.applications a ON a.id = s.application_id
        JOIN feedback.application_environments e ON e.id = s.environment_id
        JOIN feedback.workspaces w ON w.id = s.workspace_id
        WHERE s.id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, sessionId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            readSession(connection, result)
        }
    }

private fun readSession(connection: Connection, row: ResultSet): FeedbackSession {
    val id = row.getString("id")
    val scopes = connection.prepareStatement(
        """
        SELECT page_key, route_template, reviewable
        FROM feedback.review_scopes WHERE session_id = ?::uuid
        ORDER BY page_key, route_template NULLS FIRST
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) add(SessionScope(result.getString(1), result.getString(2), result.getBoolean(3)))
            }
        }
    }
    val perspectives = connection.prepareStatement(
        """
        SELECT code, label, status, guidance
        FROM feedback.review_session_perspectives WHERE session_id = ?::uuid ORDER BY code
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(SessionPerspective(result.getString(1), result.getString(2), result.getString(3), result.getString(4)))
                }
            }
        }
    }
    return FeedbackSession(
        id = id,
        applicationKey = row.getString("application_key"),
        environmentKey = row.getString("environment_key"),
        externalWorkspaceKey = row.getString("external_workspace_key"),
        manifestVersion = row.getString("manifest_version"),
        title = row.getString("title"),
        description = row.getString("description"),
        status = row.getString("status"),
        outOfScopePosting = row.getString("out_of_scope_posting"),
        startAt = row.offsetDateTime("start_at"),
        endAt = row.offsetDateTime("end_at"),
        scopes = scopes,
        perspectives = perspectives,
        createdAt = requireNotNull(row.offsetDateTime("created_at")),
        updatedAt = requireNotNull(row.offsetDateTime("updated_at")),
        version = row.getInt("version")
    )
}

internal fun encodeCursor(offset: Int): String =
    java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("offset:$offset".toByteArray())

internal fun decodeCursor(cursor: String?): Int {
    if (cursor == null) return 0
    if (cursor.length > 2000) badRequest("cursor が長すぎます")
    val decoded = try {
        java.util.Base64.getUrlDecoder().decode(cursor).decodeToString()
    } catch (_: IllegalArgumentException) {
        badRequest("cursor が不正です")
    }
    return decoded.removePrefix("offset:").takeIf { decoded.startsWith("offset:") }?.toIntOrNull()?.takeIf { it >= 0 }
        ?: badRequest("cursor が不正です")
}

internal fun <T> FeedbackDatabase.idempotent(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    endpoint: String,
    key: String,
    requestHash: String,
    responseStatus: Int,
    serializer: KSerializer<T>,
    block: (Connection) -> T
): T = transaction { connection ->
    connection.lockIdempotency(principal.subject, endpoint, key)
    val existing = connection.prepareStatement(
        """
        SELECT request_hash, response_body::text
        FROM feedback.idempotency_records
        WHERE tenant_id = ?::uuid AND principal_id = ? AND endpoint = ? AND idempotency_key = ?
          AND expires_at > now()
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.tenantId)
        statement.setString(2, principal.subject)
        statement.setString(3, endpoint)
        statement.setString(4, key)
        statement.executeQuery().use { result ->
            if (result.next()) result.getString(1) to result.getString(2) else null
        }
    }
    if (existing != null) {
        if (existing.first != requestHash) conflict("同じ Idempotency-Key が異なる request に使われました", "idempotency.mismatch")
        return@transaction serviceJson.decodeFromString(serializer, existing.second)
    }
    val response = block(connection)
    val body = serviceJson.encodeToString(serializer, response)
    connection.prepareStatement(
        """
        INSERT INTO feedback.idempotency_records (
            tenant_id, principal_id, endpoint, idempotency_key, request_hash,
            response_status, response_body, expires_at
        ) VALUES (?::uuid, ?, ?, ?, ?, ?, ?::jsonb, now() + interval '24 hours')
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.tenantId)
        statement.setString(2, principal.subject)
        statement.setString(3, endpoint)
        statement.setString(4, key)
        statement.setString(5, requestHash)
        statement.setInt(6, responseStatus)
        statement.setString(7, body)
        statement.executeUpdate()
    }
    response
}
