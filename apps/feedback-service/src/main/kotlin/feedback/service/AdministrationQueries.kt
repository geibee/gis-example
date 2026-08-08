package feedback.service

import java.sql.Connection
import java.util.UUID

fun FeedbackDatabase.getRetentionPolicy(scope: ResourceScope): Pair<FeedbackRetentionPolicy, Int> =
    transaction { connection ->
        ensureRetentionPolicy(connection, requireNotNull(scope.workspaceId))
        connection.prepareStatement(
            """
            SELECT evidence_retention_days, export_retention_days, version
            FROM feedback.retention_policies WHERE workspace_id = ?::uuid
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.executeQuery().use { result ->
                check(result.next())
                FeedbackRetentionPolicy(
                    evidenceRetentionDays = result.getInt(1).let { if (result.wasNull()) null else it },
                    exportRetentionDays = result.getInt(2)
                ) to result.getInt(3)
            }
        }
    }

fun FeedbackDatabase.patchRetentionPolicy(
    scope: ResourceScope,
    expectedVersion: Int,
    value: FeedbackRetentionPolicy
): Pair<FeedbackRetentionPolicy, Int> = transaction { connection ->
    validateRetentionPolicy(value)
    ensureRetentionPolicy(connection, requireNotNull(scope.workspaceId))
    connection.prepareStatement(
        """
        UPDATE feedback.retention_policies
        SET evidence_retention_days = ?, export_retention_days = ?, version = version + 1, updated_at = now()
        WHERE workspace_id = ?::uuid AND version = ?
        RETURNING version
        """.trimIndent()
    ).use { statement ->
        if (value.evidenceRetentionDays == null) statement.setNull(1, java.sql.Types.INTEGER)
        else statement.setInt(1, value.evidenceRetentionDays)
        statement.setInt(2, value.exportRetentionDays)
        statement.setString(3, scope.workspaceId)
        statement.setInt(4, expectedVersion)
        statement.executeQuery().use { result ->
            if (!result.next()) preconditionFailed()
            value to result.getInt(1)
        }
    }
}

private fun ensureRetentionPolicy(connection: Connection, workspaceId: String) {
    connection.prepareStatement(
        """
        INSERT INTO feedback.retention_policies (workspace_id)
        VALUES (?::uuid) ON CONFLICT (workspace_id) DO NOTHING
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, workspaceId)
        statement.executeUpdate()
    }
}

fun FeedbackDatabase.getNotificationSettings(
    scope: ResourceScope,
    cipher: NotificationCipher
): Pair<FeedbackNotificationSettings, Int> =
    transaction { connection ->
        ensureNotificationSettings(connection, requireNotNull(scope.workspaceId))
        connection.prepareStatement(
            """
            SELECT webhook_enabled, webhook_endpoint_ciphertext, webhook_endpoint_nonce,
                   include_body, include_evidence, version
            FROM feedback.notification_settings WHERE workspace_id = ?::uuid
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.executeQuery().use { result ->
                check(result.next())
                FeedbackNotificationSettings(
                    webhookEnabled = result.getBoolean(1),
                    webhookEndpoint = result.getBytes(2)?.let { ciphertext ->
                        cipher.decrypt(ciphertext, result.getBytes(3))
                    },
                    includeBody = result.getBoolean(4),
                    includeEvidence = result.getBoolean(5)
                ) to result.getInt(6)
            }
        }
    }

fun FeedbackDatabase.patchNotificationSettings(
    scope: ResourceScope,
    expectedVersion: Int,
    value: FeedbackNotificationSettings,
    cipher: NotificationCipher
): Pair<FeedbackNotificationSettings, Int> = transaction { connection ->
    validateNotificationSettings(value)
    ensureNotificationSettings(connection, requireNotNull(scope.workspaceId))
    val encrypted = value.webhookEndpoint?.let(cipher::encrypt)
    connection.prepareStatement(
        """
        UPDATE feedback.notification_settings SET
            webhook_enabled = ?, webhook_endpoint_ciphertext = ?, webhook_endpoint_nonce = ?,
            include_body = ?, include_evidence = ?,
            version = version + 1, updated_at = now()
        WHERE workspace_id = ?::uuid AND version = ?
        RETURNING version
        """.trimIndent()
    ).use { statement ->
        statement.setBoolean(1, value.webhookEnabled)
        statement.setBytes(2, encrypted?.ciphertext)
        statement.setBytes(3, encrypted?.nonce)
        statement.setBoolean(4, value.includeBody)
        statement.setBoolean(5, value.includeEvidence)
        statement.setString(6, scope.workspaceId)
        statement.setInt(7, expectedVersion)
        statement.executeQuery().use { result ->
            if (!result.next()) preconditionFailed()
            value to result.getInt(1)
        }
    }
}

private fun ensureNotificationSettings(connection: Connection, workspaceId: String) {
    connection.prepareStatement(
        """
        INSERT INTO feedback.notification_settings (workspace_id)
        VALUES (?::uuid) ON CONFLICT (workspace_id) DO NOTHING
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, workspaceId)
        statement.executeUpdate()
    }
}

fun FeedbackDatabase.createExport(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    request: FeedbackExportRequest,
    idempotencyKey: String,
    hash: String
): FeedbackExportJob = idempotent(
    scope = scope,
    principal = principal,
    endpoint = "POST /exports",
    key = idempotencyKey,
    requestHash = hash,
    responseStatus = 202,
    serializer = FeedbackExportJob.serializer()
) { connection ->
    if (request.format !in setOf("csv", "xlsx")) badRequest("format は csv または xlsx を指定してください")
    validateKey(request.locale, "locale", 35)
    validateKey(request.timezone, "timezone", 100)
    request.sessionId?.let { sessionId ->
        connection.prepareStatement(
            "SELECT 1 FROM feedback.review_sessions WHERE id = ?::uuid AND workspace_id = ?::uuid"
        ).use { statement ->
            statement.setString(1, sessionId)
            statement.setString(2, scope.workspaceId)
            statement.executeQuery().use { if (!it.next()) notFound() }
        }
    }
    val id = UUID.randomUUID().toString()
    connection.prepareStatement(
        """
        INSERT INTO feedback.export_jobs (
            id, tenant_id, application_id, environment_id, workspace_id, session_id,
            requested_by, format, locale, timezone
        ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?)
        RETURNING created_at
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.setString(2, scope.tenantId)
        statement.setString(3, scope.applicationId)
        statement.setString(4, scope.environmentId)
        statement.setString(5, scope.workspaceId)
        statement.setString(6, request.sessionId)
        statement.setString(7, principal.subject)
        statement.setString(8, request.format)
        statement.setString(9, request.locale)
        statement.setString(10, request.timezone)
        statement.executeQuery().use { result ->
            result.next()
            FeedbackExportJob(id = id, status = "queued", createdAt = result.getObject(1, java.time.OffsetDateTime::class.java).toInstant().toString())
        }
    }
}
