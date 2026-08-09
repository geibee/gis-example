package feedback.service

import java.sql.Connection
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class ClaimedExport(
    val id: String,
    val tenantId: String,
    val workspaceId: String,
    val format: String,
    val locale: String,
    val timezone: String,
    val claimToken: String
)

data class PreparedExport(
    val rows: List<FeedbackExportRow>,
    val retentionDays: Int
)

fun FeedbackDatabase.claimExport(): ClaimedExport? = transaction { connection ->
    connection.prepareStatement(
        """
        SELECT id::text, tenant_id::text, workspace_id::text, format, locale, timezone
        FROM feedback.export_jobs
        WHERE status = 'queued'
           OR (status = 'running' AND started_at < now() - interval '5 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            if (!result.next()) return@transaction null
            val claimToken = UUID.randomUUID().toString()
            val claimed = ClaimedExport(
                id = result.getString(1),
                tenantId = result.getString(2),
                workspaceId = result.getString(3),
                format = result.getString(4),
                locale = result.getString(5),
                timezone = result.getString(6),
                claimToken = claimToken
            )
            connection.prepareStatement(
                "UPDATE feedback.export_jobs SET status = 'running', started_at = now(), claim_token = ?::uuid, error = NULL WHERE id = ?::uuid"
            ).use { update ->
                update.setString(1, claimToken)
                update.setString(2, claimed.id)
                update.executeUpdate()
            }
            claimed
        }
    }
}

fun FeedbackDatabase.prepareExport(claimed: ClaimedExport): PreparedExport = dataSource.connection.use { connection ->
    val retentionDays = connection.prepareStatement(
        "SELECT COALESCE((SELECT export_retention_days FROM feedback.retention_policies WHERE workspace_id = ?::uuid), 7)"
    ).use { statement ->
        statement.setString(1, claimed.workspaceId)
        statement.executeQuery().use { result -> result.next(); result.getInt(1) }
    }
    val rows = connection.prepareStatement(
        """
        SELECT t.id::text, t.display_number, t.session_id::text, t.status, t.perspective_code,
               t.location::text, t.target::text,
               COALESCE(t.reporter_participant_name, t.reporter_display_name, t.reporter_principal_id),
               (SELECT count(*) FROM feedback.feedback_messages message WHERE message.thread_id = t.id),
               COALESCE((
                   SELECT message.body FROM feedback.feedback_messages message
                   WHERE message.thread_id = t.id ORDER BY message.created_at DESC, message.id DESC LIMIT 1
               ), ''),
               EXISTS (SELECT 1 FROM feedback.review_evidence evidence WHERE evidence.thread_id = t.id),
               t.created_at, t.updated_at,
               environment.base_url, environment.deep_link_thread_parameter, manifest.manifest::text
        FROM feedback.export_jobs job
        JOIN feedback.feedback_threads t ON t.workspace_id = job.workspace_id
          AND (job.session_id IS NULL OR t.session_id = job.session_id)
        JOIN feedback.review_sessions session ON session.id = t.session_id
        JOIN feedback.application_environments environment ON environment.id = job.environment_id
        JOIN feedback.application_manifests manifest
          ON manifest.application_id = job.application_id AND manifest.manifest_version = session.manifest_version
        WHERE job.id = ?::uuid
        ORDER BY t.created_at, t.id
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, claimed.id)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val location = serviceJson.parseToJsonElement(result.getString(6)).jsonObject
                    val target = serviceJson.parseToJsonElement(result.getString(7)).jsonObject
                    val manifest = serviceJson.parseToJsonElement(result.getString(16)).jsonObject
                    add(
                        FeedbackExportRow(
                            threadId = result.getString(1),
                            displayNumber = result.getInt(2),
                            sessionId = result.getString(3),
                            status = result.getString(4),
                            perspectiveCode = result.getString(5),
                            pageKey = location.getValue("pageKey").jsonPrimitive.content,
                            routeTemplate = location.getValue("routeTemplate").jsonPrimitive.content,
                            targetKind = target.getValue("kind").jsonPrimitive.content,
                            reporterName = result.getString(8),
                            messageCount = result.getInt(9),
                            latestMessage = result.getString(10),
                            deepLink = buildFeedbackDeepLink(
                                result.getString(14),
                                result.getString(15),
                                manifest,
                                location,
                                result.getString(1)
                            ),
                            evidenceAvailable = result.getBoolean(11),
                            createdAt = result.getObject(12, OffsetDateTime::class.java).toInstant().toString(),
                            updatedAt = result.getObject(13, OffsetDateTime::class.java).toInstant().toString()
                        )
                    )
                }
            }
        }
    }
    PreparedExport(rows, retentionDays)
}

fun FeedbackDatabase.completeExport(claimed: ClaimedExport, objectKey: String, retentionDays: Int) {
    transaction { connection ->
        connection.prepareStatement(
            """
            UPDATE feedback.export_jobs SET
                status = 'completed', object_key = ?,
                expires_at = now() + (? * interval '1 day'), completed_at = now(), error = NULL, claim_token = NULL
            WHERE id = ?::uuid AND status = 'running' AND claim_token = ?::uuid
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, objectKey)
            statement.setInt(2, retentionDays)
            statement.setString(3, claimed.id)
            statement.setString(4, claimed.claimToken)
            check(statement.executeUpdate() == 1) { "export job の完了状態を更新できません" }
        }
    }
}

fun FeedbackDatabase.failExport(claimed: ClaimedExport, error: String) {
    transaction { connection ->
        connection.prepareStatement(
            """
            UPDATE feedback.export_jobs
            SET status = 'failed', error = ?, completed_at = now(), claim_token = NULL
            WHERE id = ?::uuid AND status = 'running' AND claim_token = ?::uuid
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, error.take(2000))
            statement.setString(2, claimed.id)
            statement.setString(3, claimed.claimToken)
            statement.executeUpdate()
        }
    }
}

fun FeedbackDatabase.getExportJob(id: String): FeedbackExportJob = dataSource.connection.use { connection ->
    readExportJob(connection, id)
}

fun FeedbackDatabase.getStoredExport(id: String, storage: EvidenceStorage): StoredExport =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT object_key, format FROM feedback.export_jobs
            WHERE id = ?::uuid AND status = 'completed' AND expires_at > now() AND object_key IS NOT NULL
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.executeQuery().use { result ->
                if (!result.next()) notFound("export file がないか期限切れです")
                val format = result.getString(2)
                val bytes = try {
                    storage.get(result.getString(1))
                } catch (_: Exception) {
                    throw FeedbackApiException(
                        io.ktor.http.HttpStatusCode.ServiceUnavailable,
                        "export.storage_unavailable",
                        "export storage を読み取れません"
                    )
                }
                StoredExport(
                    fileName = "feedback-$id.$format",
                    contentType = if (format == "csv") "text/csv; charset=utf-8" else
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    bytes = bytes
                )
            }
        }
    }

fun FeedbackDatabase.getThreadDeepLink(threadId: String): FeedbackDeepLink = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT thread.location::text, environment.base_url, environment.deep_link_thread_parameter, manifest.manifest::text
        FROM feedback.feedback_threads thread
        JOIN feedback.review_sessions session ON session.id = thread.session_id
        JOIN feedback.application_environments environment ON environment.id = thread.environment_id
        JOIN feedback.application_manifests manifest
          ON manifest.application_id = thread.application_id AND manifest.manifest_version = session.manifest_version
        WHERE thread.id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, threadId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            FeedbackDeepLink(
                buildFeedbackDeepLink(
                    result.getString(2),
                    result.getString(3),
                    serviceJson.parseToJsonElement(result.getString(4)).jsonObject,
                    serviceJson.parseToJsonElement(result.getString(1)).jsonObject,
                    threadId
                )
            )
        }
    }
}

private fun readExportJob(connection: Connection, id: String): FeedbackExportJob =
    connection.prepareStatement(
        """
        SELECT id::text, status, expires_at, created_at, error
        FROM feedback.export_jobs WHERE id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            val status = result.getString(2)
            val expiresAt = result.getObject(3, OffsetDateTime::class.java)?.toInstant()?.toString()
            FeedbackExportJob(
                id = result.getString(1),
                status = status,
                downloadUrl = if (
                    status == "completed" && expiresAt != null && java.time.Instant.parse(expiresAt).isAfter(java.time.Instant.now())
                ) "/feedback/v1/exports/$id/download" else null,
                expiresAt = expiresAt,
                createdAt = result.getObject(4, OffsetDateTime::class.java).toInstant().toString(),
                error = result.getString(5)
            )
        }
    }
