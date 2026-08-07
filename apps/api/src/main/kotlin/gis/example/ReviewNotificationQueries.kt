// プロトタイプレビュー Phase 7: transactional outbox と配信状態管理。
package gis.example

import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.sql.Connection

enum class ReviewNotificationChannel { EMAIL, TEAMS, ISSUE }

data class ReviewNotificationCapabilities(
    val email: Boolean = false,
    val teams: Boolean = false,
    val issue: Boolean = false
)

internal data class ClaimedReviewNotification(
    val deliveryId: String,
    val outboxId: String,
    val channel: ReviewNotificationChannel,
    val destination: String?,
    val eventType: String,
    val projectId: String,
    val threadId: String,
    val payload: JsonObject,
    val attemptCount: Int
)

private data class NotificationContext(
    val projectId: String,
    val reviewSessionId: String,
    val projectName: String,
    val sessionTitle: String,
    val perspectiveLabel: String,
    val actorName: String?,
    val emailEnabled: Boolean,
    val teamsEnabled: Boolean,
    val issueEnabled: Boolean
)

fun Database.getReviewNotificationSettings(
    projectId: String,
    capabilities: ReviewNotificationCapabilities
): ReviewNotificationSettingsDto = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT p.id::text,
               coalesce(s.email_enabled, false),
               coalesce(s.teams_enabled, false),
               coalesce(s.issue_enabled, false),
               s.updated_at,
               (SELECT count(*)
                  FROM app.review_notification_deliveries AS d
                  JOIN app.review_notification_outbox AS o ON o.id = d.outbox_id
                 WHERE o.project_id = p.id AND d.status IN ('PENDING', 'DELIVERING')) AS pending_count,
               (SELECT count(*)
                  FROM app.review_notification_deliveries AS d
                  JOIN app.review_notification_outbox AS o ON o.id = d.outbox_id
                 WHERE o.project_id = p.id AND d.status = 'FAILED') AS failed_count
        FROM app.projects AS p
        LEFT JOIN app.review_notification_settings AS s ON s.project_id = p.id
        WHERE p.id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, projectId)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) throw ApiException(HttpStatusCode.NotFound, "Project not found")
            ReviewNotificationSettingsDto(
                projectId = rs.getString(1),
                emailEnabled = rs.getBoolean(2),
                teamsEnabled = rs.getBoolean(3),
                issueEnabled = rs.getBoolean(4),
                emailAvailable = capabilities.email,
                teamsAvailable = capabilities.teams,
                issueAvailable = capabilities.issue,
                updatedAt = rs.isoTimestamp("updated_at"),
                pendingDeliveryCount = rs.getLong("pending_count"),
                failedDeliveryCount = rs.getLong("failed_count")
            )
        }
    }
}

fun Database.updateReviewNotificationSettings(
    projectId: String,
    emailEnabled: Boolean,
    teamsEnabled: Boolean,
    issueEnabled: Boolean,
    updatedBy: String,
    capabilities: ReviewNotificationCapabilities,
    audit: AuditTrail
): ReviewNotificationSettingsDto {
    val before = getReviewNotificationSettings(projectId, capabilities)
    withTransaction { connection ->
        connection.prepareStatement(
            """
            INSERT INTO app.review_notification_settings (
                project_id, email_enabled, teams_enabled, issue_enabled, updated_by
            ) VALUES (?::uuid, ?, ?, ?, ?::uuid)
            ON CONFLICT (project_id) DO UPDATE SET
                email_enabled = EXCLUDED.email_enabled,
                teams_enabled = EXCLUDED.teams_enabled,
                issue_enabled = EXCLUDED.issue_enabled,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setBoolean(2, emailEnabled)
            stmt.setBoolean(3, teamsEnabled)
            stmt.setBoolean(4, issueEnabled)
            stmt.setString(5, updatedBy)
            stmt.executeUpdate()
        }
    }
    val after = getReviewNotificationSettings(projectId, capabilities)
    audit.recordUpdate(
        "review_notification_settings",
        projectId,
        before.notificationSettingsAuditSnapshot(),
        after.notificationSettingsAuditSnapshot()
    )
    return after
}

fun Database.retryFailedReviewNotifications(projectId: String, audit: AuditTrail): ReviewNotificationRetryResultDto {
    val retried = withTransaction { connection ->
        connection.prepareStatement(
            """
            UPDATE app.review_notification_deliveries AS d
               SET status = 'PENDING', attempt_count = 0, next_attempt_at = now(),
                   last_error = NULL, updated_at = now()
              FROM app.review_notification_outbox AS o
             WHERE o.id = d.outbox_id
               AND o.project_id = ?::uuid
               AND d.status = 'FAILED'
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeUpdate()
        }
    }
    audit.recordCreate(
        "review_notification_retry",
        projectId,
        buildJsonObject { put("retriedDeliveryCount", retried) }
    )
    return ReviewNotificationRetryResultDto(retried)
}

/** レビュー更新と同じ DB トランザクション内で呼び、commit と通知要求を不可分にする。 */
internal fun enqueueReviewNotification(
    connection: Connection,
    threadId: String,
    messageId: String?,
    eventType: String,
    actorId: String?,
    body: String
) {
    val context = connection.prepareStatement(
        """
        SELECT t.project_id::text, t.review_session_id::text, p.name, s.title,
               rp.label, actor.display_name,
               coalesce(ns.email_enabled, false),
               coalesce(ns.teams_enabled, false),
               coalesce(ns.issue_enabled, false)
        FROM app.feedback_threads AS t
        JOIN app.projects AS p ON p.id = t.project_id
        JOIN app.review_sessions AS s ON s.id = t.review_session_id
        JOIN app.review_perspectives AS rp ON rp.code = t.perspective_code
        LEFT JOIN app.users AS actor ON actor.id = ?::uuid
        LEFT JOIN app.review_notification_settings AS ns ON ns.project_id = t.project_id
        WHERE t.id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        setNullableUuidString(stmt, 1, actorId)
        stmt.setString(2, threadId)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) return
            NotificationContext(
                projectId = rs.getString(1),
                reviewSessionId = rs.getString(2),
                projectName = rs.getString(3),
                sessionTitle = rs.getString(4),
                perspectiveLabel = rs.getString(5),
                actorName = rs.getString(6),
                emailEnabled = rs.getBoolean(7),
                teamsEnabled = rs.getBoolean(8),
                issueEnabled = rs.getBoolean(9)
            )
        }
    }
    if (!context.emailEnabled && !context.teamsEnabled && !context.issueEnabled) return

    val payload = buildJsonObject {
        put("projectName", context.projectName)
        put("sessionTitle", context.sessionTitle)
        put("perspectiveLabel", context.perspectiveLabel)
        put("actorName", context.actorName ?: "ユーザー")
        put("body", body)
    }
    val outboxId = connection.prepareStatement(
        """
        INSERT INTO app.review_notification_outbox (
            project_id, review_session_id, thread_id, message_id, event_type, actor_id, payload
        ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?::uuid, ?::jsonb)
        RETURNING id::text
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, context.projectId)
        stmt.setString(2, context.reviewSessionId)
        stmt.setString(3, threadId)
        setNullableUuidString(stmt, 4, messageId)
        stmt.setString(5, eventType)
        setNullableUuidString(stmt, 6, actorId)
        stmt.setString(7, payload.toString())
        stmt.executeQuery().use { rs ->
            rs.next()
            rs.getString(1)
        }
    }

    if (context.emailEnabled) {
        connection.prepareStatement(
            """
            INSERT INTO app.review_notification_deliveries (outbox_id, channel, destination)
            SELECT DISTINCT ?::uuid, 'EMAIL', u.email
            FROM app.project_members AS pm
            JOIN app.users AS u ON u.id = pm.user_id
            WHERE pm.project_id = ?::uuid
              AND u.is_active
              AND u.email IS NOT NULL
              AND btrim(u.email) <> ''
              AND (?::uuid IS NULL OR u.id <> ?::uuid)
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, outboxId)
            stmt.setString(2, context.projectId)
            setNullableUuidString(stmt, 3, actorId)
            setNullableUuidString(stmt, 4, actorId)
            stmt.executeUpdate()
        }
    }
    if (context.teamsEnabled) insertChannelDelivery(connection, outboxId, ReviewNotificationChannel.TEAMS)
    // 外部 Issue はスレッドにつき 1 件だけ生成し、返信や状態更新から別 Issue を増殖させない。
    if (context.issueEnabled && eventType == "THREAD_CREATED") {
        insertChannelDelivery(connection, outboxId, ReviewNotificationChannel.ISSUE)
    }
    // Email の宛先が投稿者本人だけ、かつ他チャネル無効の場合などは空イベントを残さない。
    connection.prepareStatement(
        """
        DELETE FROM app.review_notification_outbox AS o
        WHERE o.id = ?::uuid
          AND NOT EXISTS (
              SELECT 1 FROM app.review_notification_deliveries AS d WHERE d.outbox_id = o.id
          )
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, outboxId)
        stmt.executeUpdate()
    }
}

private fun insertChannelDelivery(
    connection: Connection,
    outboxId: String,
    channel: ReviewNotificationChannel
) {
    connection.prepareStatement(
        "INSERT INTO app.review_notification_deliveries (outbox_id, channel) VALUES (?::uuid, ?)"
    ).use { stmt ->
        stmt.setString(1, outboxId)
        stmt.setString(2, channel.name)
        stmt.executeUpdate()
    }
}

internal fun Database.claimReviewNotification(
    maxAttempts: Int,
    leaseSeconds: Long,
    capabilities: ReviewNotificationCapabilities
): ClaimedReviewNotification? = withTransaction { connection ->
    val deliveryId = connection.prepareStatement(
        """
        SELECT d.id::text
        FROM app.review_notification_deliveries AS d
        WHERE d.attempt_count < ?
          AND (
              (d.channel = 'EMAIL' AND ?)
              OR (d.channel = 'TEAMS' AND ?)
              OR (d.channel = 'ISSUE' AND ?)
          )
          AND (
              (d.status IN ('PENDING', 'FAILED') AND d.next_attempt_at <= now())
              OR (d.status = 'DELIVERING' AND d.last_attempt_at <= now() - make_interval(secs => ?))
          )
        ORDER BY d.next_attempt_at, d.created_at, d.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        """.trimIndent()
    ).use { stmt ->
        stmt.setInt(1, maxAttempts)
        stmt.setBoolean(2, capabilities.email)
        stmt.setBoolean(3, capabilities.teams)
        stmt.setBoolean(4, capabilities.issue)
        stmt.setLong(5, leaseSeconds)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    } ?: return@withTransaction null

    connection.prepareStatement(
        """
        UPDATE app.review_notification_deliveries
        SET status = 'DELIVERING', attempt_count = attempt_count + 1,
            last_attempt_at = now(), updated_at = now()
        WHERE id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, deliveryId)
        stmt.executeUpdate()
    }
    connection.prepareStatement(
        """
        SELECT d.id::text, o.id::text, d.channel, d.destination, o.event_type,
               o.project_id::text, o.thread_id::text, o.payload::text, d.attempt_count
        FROM app.review_notification_deliveries AS d
        JOIN app.review_notification_outbox AS o ON o.id = d.outbox_id
        WHERE d.id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, deliveryId)
        stmt.executeQuery().use { rs ->
            rs.next()
            ClaimedReviewNotification(
                deliveryId = rs.getString(1),
                outboxId = rs.getString(2),
                channel = ReviewNotificationChannel.valueOf(rs.getString(3)),
                destination = rs.getString(4),
                eventType = rs.getString(5),
                projectId = rs.getString(6),
                threadId = rs.getString(7),
                payload = Json.parseToJsonElement(rs.getString(8)) as JsonObject,
                attemptCount = rs.getInt(9)
            )
        }
    }
}

internal fun Database.completeReviewNotification(deliveryId: String, externalReference: String?) {
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            UPDATE app.review_notification_deliveries
            SET status = 'SUCCEEDED', delivered_at = now(), last_error = NULL,
                external_reference = ?, updated_at = now()
            WHERE id = ?::uuid AND status = 'DELIVERING'
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, externalReference)
            stmt.setString(2, deliveryId)
            stmt.executeUpdate()
        }
    }
}

internal fun Database.failReviewNotification(deliveryId: String, error: String, retryDelaySeconds: Long) {
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            UPDATE app.review_notification_deliveries
            SET status = 'FAILED', last_error = left(?, 1000),
                next_attempt_at = now() + make_interval(secs => ?), updated_at = now()
            WHERE id = ?::uuid AND status = 'DELIVERING'
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, error)
            stmt.setLong(2, retryDelaySeconds)
            stmt.setString(3, deliveryId)
            stmt.executeUpdate()
        }
    }
}

private fun ReviewNotificationSettingsDto.notificationSettingsAuditSnapshot(): JsonObject = buildJsonObject {
    put("projectId", projectId)
    put("emailEnabled", emailEnabled)
    put("teamsEnabled", teamsEnabled)
    put("issueEnabled", issueEnabled)
    if (updatedAt == null) put("updatedAt", JsonNull) else put("updatedAt", updatedAt)
}
