package feedback.service

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

fun FeedbackDatabase.reviewContext(
    scope: ResourceScope,
    pageKey: String,
    routeTemplate: String,
    permissions: Set<FeedbackPermission>,
    evidenceMaxBytes: Long
): FeedbackReviewContext = dataSource.connection.use { connection ->
    val session = connection.prepareStatement(
        """
        SELECT s.*, a.application_key, e.environment_key, w.external_workspace_key
        FROM feedback.review_sessions s
        JOIN feedback.applications a ON a.id = s.application_id
        JOIN feedback.application_environments e ON e.id = s.environment_id
        JOIN feedback.workspaces w ON w.id = s.workspace_id
        WHERE s.application_id = ?::uuid AND s.environment_id = ?::uuid AND s.workspace_id = ?::uuid
          AND s.status = 'open'
          AND (s.start_at IS NULL OR s.start_at <= now())
          AND (s.end_at IS NULL OR s.end_at >= now())
        LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.applicationId)
        statement.setString(2, scope.environmentId)
        statement.setString(3, scope.workspaceId)
        statement.executeQuery().use { result -> if (result.next()) readSessionById(connection, result.getString("id")) else null }
    }
    val manifestRegistered = connection.prepareStatement(
        """
        WITH selected_manifest AS (
            SELECT manifest
            FROM feedback.application_manifests
            WHERE application_id = ?::uuid
              AND (? IS NULL OR manifest_version = ?)
            ORDER BY created_at DESC
            LIMIT 1
        )
        SELECT 1
        FROM selected_manifest m,
             jsonb_array_elements(m.manifest->'routes') route
        WHERE route->>'pageKey' = ?
          AND (route->>'template' = ? OR (route->'aliases') ? ?)
        LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.applicationId)
        statement.setString(2, session?.manifestVersion)
        statement.setString(3, session?.manifestVersion)
        statement.setString(4, pageKey)
        statement.setString(5, routeTemplate)
        statement.setString(6, routeTemplate)
        statement.executeQuery().use { it.next() }
    }
    val matchingScope = session?.scopes?.firstOrNull {
        it.pageKey == pageKey && (it.routeTemplate == null || it.routeTemplate == routeTemplate)
    }
    val scopeValue = when {
        !manifestRegistered -> "unregistered"
        session == null -> "excluded"
        matchingScope == null -> "excluded"
        matchingScope.reviewable -> "reviewable"
        else -> "excluded"
    }
    val posting = when {
        session == null -> "deny"
        scopeValue == "reviewable" -> "allow"
        scopeValue == "unregistered" -> "deny"
        else -> session.outOfScopePosting
    }
    FeedbackReviewContext(
        session = session,
        scope = scopeValue,
        posting = posting,
        permissions = permissions.map { it.wireValue }.sorted(),
        evidencePolicy = EvidencePolicy(maxBytes = evidenceMaxBytes)
    )
}

fun FeedbackDatabase.listThreads(
    sessionId: String,
    status: String?,
    limit: Int,
    offset: Int
): FeedbackThreadPage = dataSource.connection.use { connection ->
    val filter = if (status == null) "" else "AND status = ?"
    val total = connection.prepareStatement(
        "SELECT count(*) FROM feedback.feedback_threads WHERE session_id = ?::uuid $filter"
    ).use { statement ->
        statement.setString(1, sessionId)
        if (status != null) statement.setString(2, status)
        statement.executeQuery().use { result -> result.next(); result.getLong(1) }
    }
    val items = connection.prepareStatement(
        """
        SELECT * FROM feedback.feedback_threads
        WHERE session_id = ?::uuid $filter
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """.trimIndent()
    ).use { statement ->
        var index = 1
        statement.setString(index++, sessionId)
        if (status != null) statement.setString(index++, status)
        statement.setInt(index++, limit)
        statement.setInt(index, offset)
        statement.executeQuery().use { result ->
            buildList { while (result.next()) add(readThread(connection, result)) }
        }
    }
    FeedbackThreadPage(
        items = items,
        nextCursor = if (offset + items.size < total) encodeCursor(offset + items.size) else null,
        totalCount = total
    )
}

fun FeedbackDatabase.getThread(threadId: String): FeedbackThread = dataSource.connection.use { connection ->
    readThreadById(connection, threadId)
}

fun FeedbackDatabase.createThread(
    scope: ResourceScope,
    sessionId: String,
    principal: FeedbackPrincipal,
    request: FeedbackThreadCreateRequest,
    idempotencyKey: String,
    hash: String,
    evidenceStorage: EvidenceStorage,
    evidenceKeyPrefix: String,
    evidenceMaxBytes: Long
): FeedbackThread {
    var storedObjectKey: String? = null
    try {
        return idempotent(
            scope = scope,
            principal = principal,
            endpoint = "POST /sessions/{sessionId}/threads",
            key = idempotencyKey,
            requestHash = hash,
            responseStatus = 201,
            serializer = FeedbackThread.serializer()
        ) { connection ->
            validateKey(request.perspectiveCode, "perspectiveCode", 100)
            validateBody(request.body)
            request.participantName?.let { validateKey(it, "participantName", 100) }
            val session = readSessionById(connection, sessionId)
            if (session.status != "open") conflict("open session にだけ投稿できます", "session.not_open")
            val now = java.time.Instant.now()
            if (session.startAt?.let(java.time.Instant::parse)?.isAfter(now) == true ||
                session.endAt?.let(java.time.Instant::parse)?.isBefore(now) == true) {
                conflict("session の実施期間外です", "session.outside_period")
            }
            val manifest = connection.prepareStatement(
                """
                SELECT manifest::text FROM feedback.application_manifests
                WHERE application_id = ?::uuid AND manifest_version = ?
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, scope.applicationId)
                statement.setString(2, session.manifestVersion)
                statement.executeQuery().use { result ->
                    if (!result.next()) badRequest("session の manifestVersion が見つかりません")
                    serviceJson.parseToJsonElement(result.getString(1)) as JsonObject
                }
            }
            val location = sanitizeLocation(request.location, manifest)
            val target = validateTarget(request.target)
            val matchedScope = session.scopes.firstOrNull {
                it.pageKey == location.getValue("pageKey").jsonPrimitive.content &&
                    (it.routeTemplate == null || it.routeTemplate == location.getValue("routeTemplate").jsonPrimitive.content)
            }
            if (matchedScope?.reviewable != true && session.outOfScopePosting == "deny") {
                throw FeedbackApiException(
                    io.ktor.http.HttpStatusCode.Forbidden,
                    "session.out_of_scope",
                    "この画面は session scope 外です"
                )
            }
            if (session.perspectives.none { it.code == request.perspectiveCode && it.status == "active" }) {
                badRequest("active な perspectiveCode を指定してください")
            }
            val displayNumber = nextThreadNumber(connection, sessionId)
            val threadId = UUID.randomUUID().toString()
            connection.prepareStatement(
                """
                INSERT INTO feedback.feedback_threads (
                    id, tenant_id, application_id, environment_id, workspace_id, session_id,
                    display_number, location, target, perspective_code,
                    reporter_principal_id, reporter_display_name, reporter_participant_name
                ) VALUES (
                    ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid,
                    ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?
                )
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, threadId)
                statement.setString(2, scope.tenantId)
                statement.setString(3, scope.applicationId)
                statement.setString(4, scope.environmentId)
                statement.setString(5, scope.workspaceId)
                statement.setString(6, sessionId)
                statement.setInt(7, displayNumber)
                statement.setString(8, location.toString())
                statement.setString(9, target.toString())
                statement.setString(10, request.perspectiveCode)
                statement.setString(11, principal.subject)
                statement.setString(12, principal.displayName)
                statement.setString(13, request.participantName)
                statement.executeUpdate()
            }
            insertMessage(connection, threadId, principal, request.body.trim(), request.participantName)
            request.evidence?.let { evidence ->
                val bytes = decodeEvidence(evidence, evidenceMaxBytes)
                val objectKey = "$evidenceKeyPrefix${scope.tenantId}/${scope.workspaceId}/$threadId"
                evidenceStorage.put(objectKey, evidence.contentType, bytes)
                storedObjectKey = objectKey
                connection.prepareStatement(
                    """
                    INSERT INTO feedback.review_evidence (
                        id, thread_id, object_key, content_type, byte_size, sha256,
                        viewport_width, viewport_height, pixel_ratio, captured_at
                    ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)
                    """.trimIndent()
                ).use { statement ->
                    statement.setString(1, UUID.randomUUID().toString())
                    statement.setString(2, threadId)
                    statement.setString(3, objectKey)
                    statement.setString(4, evidence.contentType)
                    statement.setLong(5, bytes.size.toLong())
                    statement.setString(6, sha256(bytes))
                    statement.setInt(7, evidence.viewportWidth)
                    statement.setInt(8, evidence.viewportHeight)
                    statement.setDouble(9, evidence.pixelRatio)
                    statement.setString(10, evidence.capturedAt)
                    statement.executeUpdate()
                }
            }
            enqueueEvent(connection, scope, "feedback.thread.created.v1", sessionId, threadId, principal, request.body)
            readThreadById(connection, threadId)
        }
    } catch (exception: Exception) {
        storedObjectKey?.let { key -> runCatching { evidenceStorage.delete(key) } }
        throw exception
    }
}

fun FeedbackDatabase.createMessage(
    scope: ResourceScope,
    threadId: String,
    principal: FeedbackPrincipal,
    request: FeedbackMessageCreateRequest,
    idempotencyKey: String,
    hash: String
): FeedbackMessage = idempotent(
    scope = scope,
    principal = principal,
    endpoint = "POST /threads/{threadId}/messages",
    key = idempotencyKey,
    requestHash = hash,
    responseStatus = 201,
    serializer = FeedbackMessage.serializer()
) { connection ->
    validateBody(request.body)
    request.participantName?.let { validateKey(it, "participantName", 100) }
    val thread = readThreadById(connection, threadId)
    val message = insertMessage(connection, threadId, principal, request.body.trim(), request.participantName)
    connection.prepareStatement("UPDATE feedback.feedback_threads SET version = version + 1, updated_at = now() WHERE id = ?::uuid").use {
        it.setString(1, threadId)
        it.executeUpdate()
    }
    enqueueEvent(connection, scope, "feedback.message.created.v1", thread.sessionId, threadId, principal, request.body)
    message
}

fun FeedbackDatabase.patchMessage(
    messageId: String,
    principal: FeedbackPrincipal,
    expectedVersion: Int,
    request: FeedbackMessagePatchRequest
): FeedbackMessage = transaction { connection ->
    validateBody(request.body)
    request.participantName?.let { validateKey(it, "participantName", 100) }
    val current = readMessageById(connection, messageId)
    if (current.version != expectedVersion) preconditionFailed()
    if (current.author.principalId != principal.subject) {
        throw FeedbackApiException(io.ktor.http.HttpStatusCode.Forbidden, "message.not_owner", "自分の message だけを編集できます")
    }
    connection.prepareStatement(
        """
        INSERT INTO feedback.feedback_message_versions (
            message_id, thread_id, version, author_principal_id, author_display_name,
            author_participant_name, body, created_at, edited_at
        )
        SELECT id, thread_id, version, author_principal_id, author_display_name,
               author_participant_name, body, created_at, edited_at
        FROM feedback.feedback_messages WHERE id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, messageId)
        statement.executeUpdate()
    }
    connection.prepareStatement(
        """
        UPDATE feedback.feedback_messages SET
            body = ?, author_participant_name = ?, version = version + 1, edited_at = now()
        WHERE id = ?::uuid AND version = ?
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, request.body.trim())
        statement.setString(2, request.participantName)
        statement.setString(3, messageId)
        statement.setInt(4, expectedVersion)
        if (statement.executeUpdate() != 1) preconditionFailed()
    }
    connection.prepareStatement(
        """
        UPDATE feedback.feedback_threads SET version = version + 1, updated_at = now()
        WHERE id = (SELECT thread_id FROM feedback.feedback_messages WHERE id = ?::uuid)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, messageId)
        statement.executeUpdate()
    }
    readMessageById(connection, messageId)
}

fun FeedbackDatabase.listMessageVersions(messageId: String): List<FeedbackMessageVersion> =
    dataSource.connection.use { connection ->
        val history = connection.prepareStatement(
            """
            SELECT message_id::text AS id, thread_id::text, author_principal_id, author_display_name,
                   author_participant_name, body, created_at, edited_at, version
            FROM feedback.feedback_message_versions
            WHERE message_id = ?::uuid ORDER BY version
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, messageId)
            statement.executeQuery().use { result ->
                buildList { while (result.next()) add(readMessageVersion(result, current = false)) }
            }
        }
        val current = readMessageById(connection, messageId)
        history + FeedbackMessageVersion(
            id = current.id,
            threadId = current.threadId,
            author = current.author,
            body = current.body,
            createdAt = current.createdAt,
            editedAt = current.editedAt,
            version = current.version,
            current = true
        )
    }

fun FeedbackDatabase.patchThreadStatus(
    scope: ResourceScope,
    threadId: String,
    principal: FeedbackPrincipal,
    expectedVersion: Int,
    status: String
): FeedbackThread = transaction { connection ->
    if (status !in setOf("open", "resolved")) badRequest("status が不正です")
    val current = readThreadById(connection, threadId)
    if (current.version != expectedVersion) preconditionFailed()
    connection.prepareStatement(
        """
        UPDATE feedback.feedback_threads
        SET status = ?, version = version + 1, updated_at = now()
        WHERE id = ?::uuid AND version = ?
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, status)
        statement.setString(2, threadId)
        statement.setInt(3, expectedVersion)
        if (statement.executeUpdate() != 1) preconditionFailed()
    }
    val eventType = if (status == "resolved") "feedback.thread.resolved.v1" else "feedback.thread.reopened.v1"
    enqueueEvent(connection, scope, eventType, current.sessionId, threadId, principal, null)
    readThreadById(connection, threadId)
}

fun FeedbackDatabase.getEvidence(threadId: String, storage: EvidenceStorage): StoredEvidence =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            "SELECT object_key, content_type, sha256 FROM feedback.review_evidence WHERE thread_id = ?::uuid"
        ).use { statement ->
            statement.setString(1, threadId)
            statement.executeQuery().use { result ->
                if (!result.next()) notFound("evidence がありません")
                val objectKey = result.getString(1)
                val contentType = result.getString(2)
                val expectedHash = result.getString(3)
                val bytes = try {
                    storage.get(objectKey)
                } catch (_: Exception) {
                    throw FeedbackApiException(
                        io.ktor.http.HttpStatusCode.ServiceUnavailable,
                        "evidence.storage_unavailable",
                        "evidence storage を読み取れません"
                    )
                }
                if (sha256(bytes) != expectedHash) {
                    throw FeedbackApiException(
                        io.ktor.http.HttpStatusCode.ServiceUnavailable,
                        "evidence.integrity_error",
                        "evidence の整合性を確認できません"
                    )
                }
                StoredEvidence(objectKey, contentType, bytes)
            }
        }
    }

private fun nextThreadNumber(connection: Connection, sessionId: String): Int =
    connection.prepareStatement(
        """
        INSERT INTO feedback.thread_sequences (session_id, next_number)
        VALUES (?::uuid, 2)
        ON CONFLICT (session_id) DO UPDATE SET next_number = feedback.thread_sequences.next_number + 1
        RETURNING next_number - 1
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, sessionId)
        statement.executeQuery().use { result -> result.next(); result.getInt(1) }
    }

private fun insertMessage(
    connection: Connection,
    threadId: String,
    principal: FeedbackPrincipal,
    body: String,
    participantName: String?
): FeedbackMessage {
    val id = UUID.randomUUID().toString()
    connection.prepareStatement(
        """
        INSERT INTO feedback.feedback_messages (
            id, thread_id, author_principal_id, author_display_name, author_participant_name, body
        ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.setString(2, threadId)
        statement.setString(3, principal.subject)
        statement.setString(4, principal.displayName)
        statement.setString(5, participantName)
        statement.setString(6, body)
        statement.executeUpdate()
    }
    return readMessageById(connection, id)
}

private fun validateBody(body: String) {
    if (body.trim().isEmpty() || body.length > 20000) badRequest("body は 1 文字以上 20000 文字以下で指定してください")
}

private fun readThreadById(connection: Connection, threadId: String): FeedbackThread =
    connection.prepareStatement("SELECT * FROM feedback.feedback_threads WHERE id = ?::uuid").use { statement ->
        statement.setString(1, threadId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            readThread(connection, result)
        }
    }

private fun readThread(connection: Connection, row: ResultSet): FeedbackThread {
    val id = row.getString("id")
    val messages = connection.prepareStatement(
        "SELECT * FROM feedback.feedback_messages WHERE thread_id = ?::uuid ORDER BY created_at, id"
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result ->
            buildList { while (result.next()) add(readMessage(result)) }
        }
    }
    val evidenceAvailable = connection.prepareStatement(
        "SELECT 1 FROM feedback.review_evidence WHERE thread_id = ?::uuid"
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { it.next() }
    }
    return FeedbackThread(
        id = id,
        sessionId = row.getString("session_id"),
        displayNumber = row.getInt("display_number"),
        location = serviceJson.parseToJsonElement(row.getString("location")) as JsonObject,
        target = serviceJson.parseToJsonElement(row.getString("target")) as JsonObject,
        perspectiveCode = row.getString("perspective_code"),
        status = row.getString("status"),
        reporter = Participant(
            principalId = row.getString("reporter_principal_id"),
            displayName = row.getString("reporter_display_name"),
            participantName = row.getString("reporter_participant_name")
        ),
        evidenceAvailable = evidenceAvailable,
        messages = messages,
        createdAt = requireNotNull(row.offsetDateTime("created_at")),
        updatedAt = requireNotNull(row.offsetDateTime("updated_at")),
        version = row.getInt("version")
    )
}

private fun readMessageById(connection: Connection, messageId: String): FeedbackMessage =
    connection.prepareStatement("SELECT * FROM feedback.feedback_messages WHERE id = ?::uuid").use { statement ->
        statement.setString(1, messageId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            readMessage(result)
        }
    }

private fun readMessage(row: ResultSet): FeedbackMessage = FeedbackMessage(
    id = row.getString("id"),
    threadId = row.getString("thread_id"),
    author = Participant(
        principalId = row.getString("author_principal_id"),
        displayName = row.getString("author_display_name"),
        participantName = row.getString("author_participant_name")
    ),
    body = row.getString("body"),
    createdAt = requireNotNull(row.offsetDateTime("created_at")),
    editedAt = row.offsetDateTime("edited_at"),
    version = row.getInt("version")
)

private fun readMessageVersion(row: ResultSet, current: Boolean): FeedbackMessageVersion = FeedbackMessageVersion(
    id = row.getString("id"),
    threadId = row.getString("thread_id"),
    author = Participant(
        principalId = row.getString("author_principal_id"),
        displayName = row.getString("author_display_name"),
        participantName = row.getString("author_participant_name")
    ),
    body = row.getString("body"),
    createdAt = requireNotNull(row.offsetDateTime("created_at")),
    editedAt = row.offsetDateTime("edited_at"),
    version = row.getInt("version"),
    current = current
)

private fun enqueueEvent(
    connection: Connection,
    scope: ResourceScope,
    eventType: String,
    sessionId: String,
    threadId: String,
    principal: FeedbackPrincipal,
    body: String?
) {
    val eventId = UUID.randomUUID().toString()
    val payload = NotificationWebhookEvent(
        eventId = eventId,
        eventType = eventType,
        occurredAt = java.time.Instant.now().toString(),
        tenantKey = scope.tenantKey,
        applicationKey = scope.applicationKey,
        environmentKey = requireNotNull(scope.environmentKey),
        externalWorkspaceKey = requireNotNull(scope.externalWorkspaceKey),
        sessionId = sessionId,
        threadId = threadId,
        actor = principal.participant(),
        body = body
    )
    connection.prepareStatement(
        """
        INSERT INTO feedback.notification_outbox (id, tenant_id, workspace_id, event_type, payload)
        VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::jsonb)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, eventId)
        statement.setString(2, scope.tenantId)
        statement.setString(3, scope.workspaceId)
        statement.setString(4, eventType)
        statement.setString(5, serviceJson.encodeToString(NotificationWebhookEvent.serializer(), payload))
        statement.executeUpdate()
    }
}
