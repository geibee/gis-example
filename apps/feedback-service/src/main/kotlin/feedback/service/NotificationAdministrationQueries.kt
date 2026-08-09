package feedback.service

import java.sql.Connection
import java.time.OffsetDateTime

fun FeedbackDatabase.listNotificationDeliveries(
    scope: ResourceScope,
    status: String?,
    limit: Int
): List<FeedbackNotificationDelivery> = dataSource.connection.use { connection ->
    if (status != null && status !in setOf("pending", "processing", "delivered", "failed")) {
        badRequest("notification status が不正です")
    }
    val filter = if (status == null) "" else "AND status = ?"
    connection.prepareStatement(
        """
        SELECT id::text, event_type, status, retry_cycle, attempt_count,
               available_at, delivered_at, last_error, created_at
        FROM feedback.notification_outbox
        WHERE workspace_id = ?::uuid $filter
        ORDER BY created_at DESC
        LIMIT ?
        """.trimIndent()
    ).use { statement ->
        var index = 1
        statement.setString(index++, scope.workspaceId)
        if (status != null) statement.setString(index++, status)
        statement.setInt(index, limit)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val id = result.getString(1)
                    add(
                        FeedbackNotificationDelivery(
                            id = id,
                            eventType = result.getString(2),
                            status = result.getString(3),
                            retryCycle = result.getInt(4),
                            attemptCount = result.getInt(5),
                            availableAt = result.instant(6),
                            deliveredAt = result.nullableInstant(7),
                            lastError = result.getString(8),
                            createdAt = result.instant(9),
                            attempts = readDeliveryAttempts(connection, id)
                        )
                    )
                }
            }
        }
    }
}

fun FeedbackDatabase.retryNotificationDelivery(scope: ResourceScope, id: String): FeedbackNotificationDelivery =
    transaction { connection ->
        connection.prepareStatement(
            """
            UPDATE feedback.notification_outbox SET
                status = 'pending', retry_cycle = retry_cycle + 1, attempt_count = 0,
                available_at = now(), claimed_at = NULL, delivered_at = NULL, last_error = NULL
            WHERE id = ?::uuid AND workspace_id = ?::uuid AND status = 'failed'
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.workspaceId)
            if (statement.executeUpdate() != 1) {
                val exists = connection.prepareStatement(
                    "SELECT 1 FROM feedback.notification_outbox WHERE id = ?::uuid AND workspace_id = ?::uuid"
                ).use { lookup ->
                    lookup.setString(1, id)
                    lookup.setString(2, scope.workspaceId)
                    lookup.executeQuery().use { it.next() }
                }
                if (!exists) notFound()
                conflict("failed deliveryだけを再送できます", "notification.not_failed")
            }
        }
        readNotificationDelivery(connection, requireNotNull(scope.workspaceId), id)
    }

private fun readNotificationDelivery(
    connection: Connection,
    workspaceId: String,
    id: String
): FeedbackNotificationDelivery = connection.prepareStatement(
    """
    SELECT id::text, event_type, status, retry_cycle, attempt_count,
           available_at, delivered_at, last_error, created_at
    FROM feedback.notification_outbox WHERE id = ?::uuid AND workspace_id = ?::uuid
    """.trimIndent()
).use { statement ->
    statement.setString(1, id)
    statement.setString(2, workspaceId)
    statement.executeQuery().use { result ->
        if (!result.next()) notFound()
        FeedbackNotificationDelivery(
            id = result.getString(1),
            eventType = result.getString(2),
            status = result.getString(3),
            retryCycle = result.getInt(4),
            attemptCount = result.getInt(5),
            availableAt = result.instant(6),
            deliveredAt = result.nullableInstant(7),
            lastError = result.getString(8),
            createdAt = result.instant(9),
            attempts = readDeliveryAttempts(connection, id)
        )
    }
}

private fun readDeliveryAttempts(connection: Connection, outboxId: String): List<FeedbackNotificationAttempt> =
    connection.prepareStatement(
        """
        SELECT retry_cycle, attempt, status, response_status, error, created_at
        FROM feedback.notification_deliveries
        WHERE outbox_id = ?::uuid ORDER BY retry_cycle, attempt
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, outboxId)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        FeedbackNotificationAttempt(
                            retryCycle = result.getInt(1),
                            attempt = result.getInt(2),
                            status = result.getString(3),
                            responseStatus = result.getInt(4).let { if (result.wasNull()) null else it },
                            error = result.getString(5),
                            createdAt = result.instant(6)
                        )
                    )
                }
            }
        }
    }

private fun java.sql.ResultSet.instant(index: Int): String =
    getObject(index, OffsetDateTime::class.java).toInstant().toString()

private fun java.sql.ResultSet.nullableInstant(index: Int): String? =
    getObject(index, OffsetDateTime::class.java)?.toInstant()?.toString()
