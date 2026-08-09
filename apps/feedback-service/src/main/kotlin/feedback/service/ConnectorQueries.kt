package feedback.service

import java.net.URI
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID

data class ConnectorInstallationInput(
    val connectorKey: String,
    val displayName: String,
    val manifestUrl: String,
    val deliveryUrl: String,
    val healthUrl: String = manifestUrl,
    val allowedHosts: List<String> = emptyList(),
    val signingSecret: String,
    val supportedEvents: List<String>,
    val enabled: Boolean = true,
    val legacyDestinationRefs: Map<String, String> = emptyMap()
)

private val supportedNotificationEvents = setOf(
    "feedback.thread.created.v1",
    "feedback.message.created.v1",
    "feedback.thread.resolved.v1",
    "feedback.thread.reopened.v1"
)

fun FeedbackDatabase.registerConnectorInstallation(input: ConnectorInstallationInput, cipher: NotificationCipher) =
    transaction { connection ->
        validateKey(input.connectorKey, "connectorKey", 100)
        validateKey(input.displayName, "displayName", 200)
        validateConnectorInternalUrl(input.manifestUrl, "manifestUrl")
        validateConnectorInternalUrl(input.deliveryUrl, "deliveryUrl")
        validateConnectorInternalUrl(input.healthUrl, "healthUrl")
        val allowedHosts = (
            input.allowedHosts + listOf(input.manifestUrl, input.deliveryUrl, input.healthUrl).map { requireNotNull(URI(it).host) }
        )
            .map(String::lowercase).distinct().sorted()
        require(allowedHosts.all { it.matches(Regex("^[a-z0-9.-]{1,253}$")) }) { "allowedHosts が不正です" }
        require(input.signingSecret.length >= 32) { "connector signing secret は32文字以上必要です" }
        require(input.supportedEvents.isNotEmpty() && input.supportedEvents.all { it in supportedNotificationEvents }) {
            "supportedEvents に未対応のイベントがあります"
        }
        val encrypted = cipher.encrypt(input.signingSecret)
        connection.prepareStatement(
            """
            INSERT INTO feedback.connector_installations (
                id, connector_key, display_name, manifest_url, delivery_url, health_url, allowed_hosts,
                signing_secret_ciphertext, signing_secret_nonce, supported_events, enabled
            ) VALUES (?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (connector_key) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                manifest_url = EXCLUDED.manifest_url,
                delivery_url = EXCLUDED.delivery_url,
                health_url = EXCLUDED.health_url,
                allowed_hosts = EXCLUDED.allowed_hosts,
                signing_secret_ciphertext = EXCLUDED.signing_secret_ciphertext,
                signing_secret_nonce = EXCLUDED.signing_secret_nonce,
                supported_events = EXCLUDED.supported_events,
                enabled = EXCLUDED.enabled,
                version = feedback.connector_installations.version + 1,
                updated_at = now()
            RETURNING id::text
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, UUID.randomUUID().toString())
            statement.setString(2, input.connectorKey)
            statement.setString(3, input.displayName)
            statement.setString(4, input.manifestUrl)
            statement.setString(5, input.deliveryUrl)
            statement.setString(6, input.healthUrl)
            statement.setArray(7, connection.createArrayOf("text", allowedHosts.toTypedArray()))
            statement.setBytes(8, encrypted.ciphertext)
            statement.setBytes(9, encrypted.nonce)
            statement.setArray(10, connection.createArrayOf("text", input.supportedEvents.distinct().sorted().toTypedArray()))
            statement.setBoolean(11, input.enabled)
            statement.executeQuery().use { result ->
                result.next()
                if (input.connectorKey == "webhook") {
                    backfillLegacyWebhookSettings(connection, result.getString(1), input.legacyDestinationRefs, cipher)
                }
            }
        }
    }

private fun backfillLegacyWebhookSettings(
    connection: Connection,
    installationId: String,
    destinationRefs: Map<String, String>,
    cipher: NotificationCipher
) {
    destinationRefs.values.forEach { validateKey(it, "legacyDestinationRef", 200) }
    val settings = connection.prepareStatement(
        """
        SELECT settings.workspace_id::text, application.application_key, workspace.external_workspace_key,
               settings.webhook_enabled, settings.include_body,
               settings.webhook_endpoint_ciphertext, settings.webhook_endpoint_nonce
        FROM feedback.notification_settings settings
        JOIN feedback.workspaces workspace ON workspace.id = settings.workspace_id
        JOIN feedback.applications application ON application.id = workspace.application_id
        WHERE settings.webhook_endpoint_ciphertext IS NOT NULL
        ORDER BY application.application_key, workspace.external_workspace_key
        FOR UPDATE OF settings
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        LegacyWebhookSetting(
                            workspaceId = result.getString(1),
                            mappingKey = "${result.getString(2)}/${result.getString(3)}",
                            enabled = result.getBoolean(4),
                            includeBody = result.getBoolean(5),
                            endpointSha256 = sha256(
                                cipher.decrypt(result.getBytes(6), result.getBytes(7)).toByteArray(Charsets.UTF_8)
                            )
                        )
                    )
                }
            }
        }
    }
    settings.forEach { setting ->
        val destinationRef = destinationRefs[setting.endpointSha256]
            ?: destinationRefs[setting.mappingKey]
            ?: destinationRefs[setting.workspaceId]
        require(!setting.enabled || destinationRef != null) {
            "enabled legacy webhook ${setting.mappingKey} のdestinationRef mappingがありません"
        }
        val effectiveRef = destinationRef ?: "legacy-disabled-${setting.workspaceId}"
        val connectorId = connection.prepareStatement(
            """
            SELECT id::text FROM feedback.notification_connectors
            WHERE workspace_id = ?::uuid AND legacy_settings AND deleted_at IS NULL
            FOR UPDATE
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, setting.workspaceId)
            statement.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
        }
        val id = connectorId ?: UUID.randomUUID().toString()
        if (connectorId == null) {
            connection.prepareStatement(
                """
                INSERT INTO feedback.notification_connectors (
                    id, workspace_id, installation_id, name, destination_ref,
                    enabled, include_body, legacy_settings
                ) VALUES (?::uuid, ?::uuid, ?::uuid, 'Legacy Webhook (compatibility)', ?, ?, ?, true)
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, id)
                statement.setString(2, setting.workspaceId)
                statement.setString(3, installationId)
                statement.setString(4, effectiveRef)
                statement.setBoolean(5, setting.enabled)
                statement.setBoolean(6, setting.includeBody)
                statement.executeUpdate()
            }
        } else {
            connection.prepareStatement(
                """
                UPDATE feedback.notification_connectors SET
                    installation_id = ?::uuid, destination_ref = ?, enabled = ?, include_body = ?,
                    version = version + 1, updated_at = now()
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, installationId)
                statement.setString(2, effectiveRef)
                statement.setBoolean(3, setting.enabled)
                statement.setBoolean(4, setting.includeBody)
                statement.setString(5, id)
                statement.executeUpdate()
            }
        }
        connection.prepareStatement(
            """
            INSERT INTO feedback.connector_delivery_queue (id, outbox_id, connector_id)
            SELECT gen_random_uuid(), outbox.id, ?::uuid
            FROM feedback.notification_outbox outbox
            JOIN feedback.connector_installations installation ON installation.id = ?::uuid
            WHERE outbox.workspace_id = ?::uuid
              AND outbox.status IN ('pending', 'processing', 'failed')
              AND outbox.event_type = ANY(installation.supported_events)
            ON CONFLICT (outbox_id, connector_id) DO NOTHING
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, installationId)
            statement.setString(3, setting.workspaceId)
            statement.executeUpdate()
        }
    }
}

internal fun Connection.syncLegacyWebhookConnector(
    workspaceId: String,
    enabled: Boolean,
    includeBody: Boolean
): Boolean = prepareStatement(
    """
    UPDATE feedback.notification_connectors SET
        enabled = ?, include_body = ?, version = version + 1, updated_at = now()
    WHERE workspace_id = ?::uuid AND legacy_settings AND deleted_at IS NULL
      AND (NOT ? OR destination_ref NOT LIKE 'legacy-disabled-%')
    """.trimIndent()
).use { statement ->
    statement.setBoolean(1, enabled)
    statement.setBoolean(2, includeBody)
    statement.setString(3, workspaceId)
    statement.setBoolean(4, enabled)
    statement.executeUpdate() == 1
}

private data class LegacyWebhookSetting(
    val workspaceId: String,
    val mappingKey: String,
    val enabled: Boolean,
    val includeBody: Boolean,
    val endpointSha256: String
)

fun FeedbackDatabase.listConnectorTypes(): List<FeedbackConnectorType> = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT connector_key, display_name, protocol_version, supported_events, enabled,
               health_status, health_checked_at, health_error
        FROM feedback.connector_installations ORDER BY connector_key
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        FeedbackConnectorType(
                            key = result.getString(1),
                            displayName = result.getString(2),
                            protocolVersion = result.getString(3),
                            supportedEvents = (result.getArray(4).array as Array<*>).map(Any?::toString),
                            enabled = result.getBoolean(5),
                            healthStatus = result.getString(6),
                            healthCheckedAt = result.getObject(7, OffsetDateTime::class.java)?.toInstant()?.toString(),
                            healthError = result.getString(8)
                        )
                    )
                }
            }
        }
    }
}

fun FeedbackDatabase.listNotificationConnectors(scope: ResourceScope): List<FeedbackNotificationConnector> =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT connector.*, installation.connector_key, installation.display_name,
                   installation.health_status AS installation_health_status,
                   installation.health_checked_at AS installation_health_checked_at,
                   installation.health_error AS installation_health_error
            FROM feedback.notification_connectors connector
            JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
            WHERE connector.workspace_id = ?::uuid AND connector.deleted_at IS NULL
            ORDER BY connector.created_at, connector.id
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.executeQuery().use { result -> buildList { while (result.next()) add(readConnector(result)) } }
        }
    }

fun FeedbackDatabase.createNotificationConnector(
    scope: ResourceScope,
    request: FeedbackNotificationConnectorCreateRequest
): FeedbackNotificationConnector = transaction { connection ->
    validateConnectorRequest(request.name, request.destinationRef)
    val installationId = connection.prepareStatement(
        "SELECT id::text FROM feedback.connector_installations WHERE connector_key = ? AND enabled"
    ).use { statement ->
        statement.setString(1, validateKey(request.connectorType, "connectorType", 100))
        statement.executeQuery().use { result -> if (!result.next()) badRequest("有効なconnectorTypeではありません"); result.getString(1) }
    }
    val id = UUID.randomUUID().toString()
    try {
        connection.prepareStatement(
            """
            INSERT INTO feedback.notification_connectors (
                id, workspace_id, installation_id, name, destination_ref, enabled, include_body
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?)
            RETURNING *
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.workspaceId)
            statement.setString(3, installationId)
            statement.setString(4, request.name.trim())
            statement.setString(5, request.destinationRef.trim())
            statement.setBoolean(6, request.enabled)
            statement.setBoolean(7, request.includeBody)
            statement.executeQuery().use { result ->
                result.next()
                readConnectorWithInstallation(connection, result.getString("id"))
            }
        }
    } catch (exception: java.sql.SQLException) {
        if (exception.sqlState == "23505") conflict("同じnameの通知コネクタがあります", "connector.name_conflict")
        throw exception
    }
}

fun FeedbackDatabase.patchNotificationConnector(
    scope: ResourceScope,
    id: String,
    expectedVersion: Int,
    request: FeedbackNotificationConnectorPatchRequest
): FeedbackNotificationConnector = transaction { connection ->
    validateConnectorRequest(request.name, request.destinationRef)
    connection.prepareStatement(
        """
        UPDATE feedback.notification_connectors SET
            name = ?, destination_ref = ?, enabled = ?, include_body = ?,
            version = version + 1, updated_at = now()
        WHERE id = ?::uuid AND workspace_id = ?::uuid AND version = ? AND deleted_at IS NULL
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, request.name.trim())
        statement.setString(2, request.destinationRef.trim())
        statement.setBoolean(3, request.enabled)
        statement.setBoolean(4, request.includeBody)
        statement.setString(5, id)
        statement.setString(6, scope.workspaceId)
        statement.setInt(7, expectedVersion)
        if (statement.executeUpdate() != 1) {
            if (!connection.notificationConnectorExists(scope.workspaceId, id)) notFound()
            preconditionFailed()
        }
    }
    if (!request.enabled) {
        connection.failPendingConnectorDeliveries(id, "connector configuration was disabled")
    }
    readConnectorWithInstallation(connection, id)
}

fun FeedbackDatabase.deleteNotificationConnector(scope: ResourceScope, id: String, expectedVersion: Int) =
    transaction { connection ->
        connection.prepareStatement(
            """
            UPDATE feedback.notification_connectors
            SET enabled = false, deleted_at = now(), updated_at = now(), version = version + 1
            WHERE id = ?::uuid AND workspace_id = ?::uuid AND version = ? AND deleted_at IS NULL
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.setString(2, scope.workspaceId)
            statement.setInt(3, expectedVersion)
            if (statement.executeUpdate() != 1) {
                if (!connection.notificationConnectorExists(scope.workspaceId, id)) notFound()
                preconditionFailed()
            }
        }
        connection.failPendingConnectorDeliveries(id, "connector configuration was deleted")
    }

private fun Connection.failPendingConnectorDeliveries(connectorId: String, reason: String) {
    prepareStatement(
        """
        UPDATE feedback.connector_delivery_queue
        SET status = 'failed', claimed_at = NULL, last_error = ?
        WHERE connector_id = ?::uuid AND status IN ('pending', 'processing')
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, reason)
        statement.setString(2, connectorId)
        statement.executeUpdate()
    }
    prepareStatement(
        """
        UPDATE feedback.notification_outbox outbox SET
            status = CASE
                WHEN EXISTS (
                    SELECT 1 FROM feedback.connector_delivery_queue queue
                    WHERE queue.outbox_id = outbox.id AND queue.status IN ('pending', 'processing')
                ) THEN 'pending'
                WHEN EXISTS (
                    SELECT 1 FROM feedback.connector_delivery_queue queue
                    WHERE queue.outbox_id = outbox.id AND queue.status = 'failed'
                ) THEN 'failed'
                ELSE 'delivered'
            END,
            delivered_at = CASE WHEN NOT EXISTS (
                SELECT 1 FROM feedback.connector_delivery_queue queue
                WHERE queue.outbox_id = outbox.id AND queue.status <> 'delivered'
            ) THEN now() ELSE NULL END,
            last_error = (
                SELECT max(queue.last_error) FROM feedback.connector_delivery_queue queue
                WHERE queue.outbox_id = outbox.id AND queue.status = 'failed'
            )
        WHERE EXISTS (
            SELECT 1 FROM feedback.connector_delivery_queue affected
            WHERE affected.outbox_id = outbox.id AND affected.connector_id = ?::uuid
        )
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, connectorId)
        statement.executeUpdate()
    }
}

private fun validateConnectorRequest(name: String, destinationRef: String) {
    validateKey(name.trim(), "name", 200)
    validateKey(destinationRef.trim(), "destinationRef", 200)
}

private fun Connection.notificationConnectorExists(workspaceId: String?, id: String): Boolean =
    prepareStatement(
        "SELECT 1 FROM feedback.notification_connectors WHERE id = ?::uuid AND workspace_id = ?::uuid AND deleted_at IS NULL"
    ).use { statement ->
        statement.setString(1, id)
        statement.setString(2, workspaceId)
        statement.executeQuery().use { it.next() }
    }

internal fun validateConnectorInternalUrl(raw: String, name: String) {
    val uri = URI(raw)
    val local = uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1")
    val configuredLocalHttp = System.getenv("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP") == "1" && uri.scheme == "http"
    require((uri.scheme == "https" || local || configuredLocalHttp) &&
        uri.host != null && uri.userInfo == null && uri.fragment == null) { "$name はHTTPS URLで指定してください" }
}

private fun readConnectorWithInstallation(connection: Connection, id: String): FeedbackNotificationConnector =
    connection.prepareStatement(
        """
        SELECT connector.*, installation.connector_key, installation.display_name,
               installation.health_status AS installation_health_status,
               installation.health_checked_at AS installation_health_checked_at,
               installation.health_error AS installation_health_error
        FROM feedback.notification_connectors connector
        JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
        WHERE connector.id = ?::uuid AND connector.deleted_at IS NULL
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result -> if (!result.next()) notFound(); readConnector(result) }
    }

private fun readConnector(result: ResultSet): FeedbackNotificationConnector = FeedbackNotificationConnector(
    id = result.getString("id"),
    connectorType = result.getString("connector_key"),
    displayName = result.getString("display_name"),
    name = result.getString("name"),
    destinationRef = result.getString("destination_ref"),
    enabled = result.getBoolean("enabled"),
    includeBody = result.getBoolean("include_body"),
    healthStatus = result.getString("installation_health_status"),
    healthCheckedAt = result.getObject("installation_health_checked_at", OffsetDateTime::class.java)?.toInstant()?.toString(),
    healthError = result.getString("installation_health_error"),
    version = result.getInt("version"),
    createdAt = result.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
    updatedAt = result.getObject("updated_at", OffsetDateTime::class.java).toInstant().toString()
)
