package feedback.service

import java.sql.Connection
import java.time.OffsetDateTime

fun FeedbackDatabase.listNotificationDeliveries(
    scope: ResourceScope,
    status: String?,
    limit: Int,
    connectorId: String? = null
): List<FeedbackNotificationDelivery> = dataSource.connection.use { connection ->
    if (status != null && status !in setOf("pending", "processing", "delivered", "failed")) {
        badRequest("notification status が不正です")
    }
    val connectorDeliveries = listConnectorDeliveries(connection, requireNotNull(scope.workspaceId), status, connectorId, limit)
    if (connectorId != null) return@use connectorDeliveries
    val filter = if (status == null) "" else "AND outbox.status = ?"
    val legacy = connection.prepareStatement(
        """
        SELECT outbox.id::text, outbox.event_type, outbox.status, outbox.retry_cycle, outbox.attempt_count,
               outbox.available_at, outbox.delivered_at, outbox.last_error, outbox.created_at
        FROM feedback.notification_outbox outbox
        WHERE outbox.workspace_id = ?::uuid
          AND NOT EXISTS (
              SELECT 1 FROM feedback.connector_delivery_queue queue
              WHERE queue.outbox_id = outbox.id
          )
          $filter
        ORDER BY outbox.created_at DESC
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
    (legacy + connectorDeliveries).sortedByDescending { it.createdAt }.take(limit)
}

fun FeedbackDatabase.retryNotificationDelivery(scope: ResourceScope, id: String): FeedbackNotificationDelivery =
    transaction { connection ->
        val connectorUpdated = connection.prepareStatement(
            """
            UPDATE feedback.connector_delivery_queue SET
                status = 'pending', retry_cycle = retry_cycle + 1, attempt_count = 0,
                available_at = now(), claimed_at = NULL, delivered_at = NULL, last_error = NULL
            WHERE id = ?::uuid AND status = 'failed'
              AND connector_id IN (
                  SELECT connector.id FROM feedback.notification_connectors connector
                  JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
                  WHERE connector.workspace_id = ?::uuid AND connector.deleted_at IS NULL
                    AND connector.enabled AND installation.enabled
              )
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.workspaceId)
            statement.executeUpdate() == 1
        }
        if (connectorUpdated) return@transaction readConnectorDelivery(connection, requireNotNull(scope.workspaceId), id)
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
        val queueId = connection.prepareStatement(
            """
            INSERT INTO feedback.connector_delivery_queue (id, outbox_id, connector_id)
            SELECT gen_random_uuid(), outbox.id, connector.id
            FROM feedback.notification_outbox outbox
            JOIN feedback.notification_connectors connector
              ON connector.workspace_id = outbox.workspace_id
             AND connector.enabled AND connector.deleted_at IS NULL
            JOIN feedback.connector_installations installation
              ON installation.id = connector.installation_id AND installation.enabled
            WHERE outbox.id = ?::uuid AND outbox.workspace_id = ?::uuid
              AND outbox.event_type = ANY(installation.supported_events)
            ON CONFLICT (outbox_id, connector_id) DO UPDATE SET
                status = 'pending', retry_cycle = feedback.connector_delivery_queue.retry_cycle + 1,
                attempt_count = 0, available_at = now(), claimed_at = NULL,
                delivered_at = NULL, last_error = NULL
            RETURNING id::text
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.workspaceId)
            statement.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
        } ?: conflict("有効な通知コネクタがありません", "notification.connector_unavailable")
        readConnectorDelivery(connection, requireNotNull(scope.workspaceId), queueId)
    }

private fun listConnectorDeliveries(
    connection: Connection,
    workspaceId: String,
    status: String?,
    connectorId: String?,
    limit: Int
): List<FeedbackNotificationDelivery> {
    val statusFilter = if (status == null) "" else "AND queue.status = ?"
    val connectorFilter = if (connectorId == null) "" else "AND connector.id = ?::uuid"
    return connection.prepareStatement(
        """
        SELECT queue.id::text, connector.id::text, connector.name, outbox.event_type,
               queue.status, queue.retry_cycle, queue.attempt_count, queue.available_at,
               queue.delivered_at, queue.last_error, queue.created_at
        FROM feedback.connector_delivery_queue queue
        JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
        JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
        WHERE connector.workspace_id = ?::uuid $statusFilter $connectorFilter
        ORDER BY queue.created_at DESC LIMIT ?
        """.trimIndent()
    ).use { statement ->
        var index = 1
        statement.setString(index++, workspaceId)
        if (status != null) statement.setString(index++, status)
        if (connectorId != null) statement.setString(index++, connectorId)
        statement.setInt(index, limit)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(readConnectorDeliveryRow(connection, result))
                }
            }
        }
    }
}

private fun readConnectorDelivery(
    connection: Connection,
    workspaceId: String,
    id: String
): FeedbackNotificationDelivery = connection.prepareStatement(
    """
    SELECT queue.id::text, connector.id::text, connector.name, outbox.event_type,
           queue.status, queue.retry_cycle, queue.attempt_count, queue.available_at,
           queue.delivered_at, queue.last_error, queue.created_at
    FROM feedback.connector_delivery_queue queue
    JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
    JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
    WHERE queue.id = ?::uuid AND connector.workspace_id = ?::uuid
    """.trimIndent()
).use { statement ->
    statement.setString(1, id)
    statement.setString(2, workspaceId)
    statement.executeQuery().use { result ->
        if (!result.next()) notFound()
        readConnectorDeliveryRow(connection, result)
    }
}

private fun readConnectorDeliveryRow(
    connection: Connection,
    result: java.sql.ResultSet
): FeedbackNotificationDelivery {
    val id = result.getString(1)
    return FeedbackNotificationDelivery(
        id = id,
        connectorId = result.getString(2),
        connectorName = result.getString(3),
        eventType = result.getString(4),
        status = result.getString(5),
        retryCycle = result.getInt(6),
        attemptCount = result.getInt(7),
        availableAt = result.instant(8),
        deliveredAt = result.nullableInstant(9),
        lastError = result.getString(10),
        createdAt = result.instant(11),
        attempts = readConnectorDeliveryAttempts(connection, id)
    )
}

private fun readConnectorDeliveryAttempts(connection: Connection, queueId: String): List<FeedbackNotificationAttempt> =
    connection.prepareStatement(
        """
        SELECT retry_cycle, attempt, status, response_status, error, created_at
        FROM feedback.connector_delivery_attempts
        WHERE queue_id = ?::uuid ORDER BY retry_cycle, attempt
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, queueId)
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
