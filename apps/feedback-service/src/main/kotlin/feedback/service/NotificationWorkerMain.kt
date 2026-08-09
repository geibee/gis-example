package feedback.service

import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.min
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.slf4j.MDC

fun main() {
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    database.migrate()
    val worker = NotificationWorker(database)
    Runtime.getRuntime().addShutdownHook(Thread { database.close() })
    worker.runForever()
}

class NotificationWorker(
    private val database: FeedbackDatabase,
    private val pollMillis: Long = (System.getenv("FEEDBACK_NOTIFICATION_POLL_MS") ?: "2000").toLong(),
    private val maxAttempts: Int = (System.getenv("FEEDBACK_NOTIFICATION_MAX_ATTEMPTS") ?: "5").toInt(),
    private val notificationCipher: NotificationCipher = NotificationCipher.fromEnv(),
    private val connectorDispatcher: ConnectorDispatcher = ConnectorHttpDispatcher(
        allowLocalDestinations = System.getenv("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP") == "1",
        allowPrivateDestinations = System.getenv("FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK") == "1"
    ),
    private val connectorHealthChecker: ConnectorHealthChecker = ConnectorHttpHealthChecker(
        allowLocalDestinations = System.getenv("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP") == "1",
        allowPrivateDestinations = System.getenv("FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK") == "1"
    )
) {
    init {
        require(pollMillis in 100..3_600_000) { "FEEDBACK_NOTIFICATION_POLL_MS は 100..3600000 です" }
        require(maxAttempts in 1..100) { "FEEDBACK_NOTIFICATION_MAX_ATTEMPTS は 1..100 です" }
    }

    fun runForever() {
        while (!Thread.currentThread().isInterrupted) {
            if (!runOnce()) Thread.sleep(pollMillis)
        }
    }

    fun runOnce(): Boolean {
        val healthChecked = checkConnectorHealthIfDue()
        val connectorDelivery = claimConnectorDelivery()
        if (connectorDelivery != null) {
            MDC.putCloseable("eventId", connectorDelivery.eventId).use { deliverConnector(connectorDelivery) }
            return true
        }
        return healthChecked
    }

    private fun checkConnectorHealthIfDue(): Boolean {
        val target = database.transaction { connection ->
            connection.prepareStatement(
                """
                WITH candidate AS (
                    SELECT id FROM feedback.connector_installations
                    WHERE enabled AND (health_checked_at IS NULL OR health_checked_at < now() - interval '1 minute')
                    ORDER BY health_checked_at NULLS FIRST, connector_key
                    FOR UPDATE SKIP LOCKED LIMIT 1
                )
                UPDATE feedback.connector_installations installation SET
                    health_status = 'unknown', health_checked_at = now(), health_error = NULL
                FROM candidate WHERE installation.id = candidate.id
                RETURNING installation.id::text, installation.health_url, installation.allowed_hosts
                """.trimIndent()
            ).use { statement ->
                statement.executeQuery().use { result ->
                    if (!result.next()) null else ConnectorHealthTarget(
                        id = result.getString(1),
                        healthUrl = result.getString(2),
                        allowedHosts = (result.getArray(3).array as Array<*>).map { it.toString().lowercase() }.toSet()
                    )
                }
            }
        } ?: return false
        val result = connectorHealthChecker.check(target)
        database.transaction { connection ->
            connection.prepareStatement(
                """
                UPDATE feedback.connector_installations SET
                    health_status = ?, health_checked_at = now(), health_error = ?
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, if (result.healthy) "healthy" else "unhealthy")
                statement.setString(2, result.error?.take(2000))
                statement.setString(3, target.id)
                statement.executeUpdate()
            }
        }
        return true
    }

    private fun claimConnectorDelivery(): ClaimedConnectorDelivery? = database.transaction { connection ->
        connection.prepareStatement(
            """
            SELECT queue.id::text, queue.outbox_id::text, outbox.payload::text,
                   queue.attempt_count, queue.retry_cycle,
                   connector.destination_ref, connector.include_body,
                   installation.delivery_url, installation.signing_secret_ciphertext,
                   installation.signing_secret_nonce, outbox.tenant_id::text,
                   thread.location::text, environment.base_url, environment.deep_link_thread_parameter,
                   manifest.manifest::text, installation.allowed_hosts
            FROM feedback.connector_delivery_queue queue
            JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
            JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
            JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
            LEFT JOIN feedback.feedback_threads thread ON thread.id = NULLIF(outbox.payload->>'threadId', '')::uuid
            LEFT JOIN feedback.review_sessions session ON session.id = thread.session_id
            LEFT JOIN feedback.application_environments environment ON environment.id = thread.environment_id
            LEFT JOIN feedback.application_manifests manifest
              ON manifest.application_id = thread.application_id AND manifest.manifest_version = session.manifest_version
            WHERE ((queue.status = 'pending' AND queue.available_at <= now())
                OR (queue.status = 'processing' AND queue.claimed_at < now() - interval '2 minutes'))
              AND connector.enabled AND installation.enabled
            ORDER BY queue.created_at
            FOR UPDATE OF queue SKIP LOCKED LIMIT 1
            """.trimIndent()
        ).use { statement ->
            statement.executeQuery().use { result ->
                if (!result.next()) return@transaction null
                val event = serviceJson.parseToJsonElement(result.getString(3)).jsonObject
                val location = checkNotNull(result.getString(12)) { "connector event のthread locationがありません" }
                val baseUrl = checkNotNull(result.getString(13)) { "connector event のenvironment base URLがありません" }
                val parameter = checkNotNull(result.getString(14)) { "connector event のdeep link parameterがありません" }
                val manifest = checkNotNull(result.getString(15)) { "connector event のmanifestがありません" }
                val threadId = event.getValue("threadId").let { (it as JsonPrimitive).content }
                val enriched = JsonObject(buildMap {
                    putAll(event)
                    put(
                        "deepLink",
                        JsonPrimitive(
                            buildFeedbackDeepLink(
                                baseUrl,
                                parameter,
                                serviceJson.parseToJsonElement(manifest).jsonObject,
                                serviceJson.parseToJsonElement(location).jsonObject,
                                threadId
                            )
                        )
                    )
                })
                val delivery = ClaimedConnectorDelivery(
                    id = result.getString(1),
                    eventId = result.getString(2),
                    event = enriched,
                    attempt = result.getInt(4) + 1,
                    retryCycle = result.getInt(5),
                    destinationRef = result.getString(6),
                    includeBody = result.getBoolean(7),
                    deliveryUrl = result.getString(8),
                    signingSecret = notificationCipher.decrypt(result.getBytes(9), result.getBytes(10)),
                    tenantId = result.getString(11),
                    allowedHosts = (result.getArray(16).array as Array<*>).map { it.toString().lowercase() }.toSet()
                )
                connection.prepareStatement(
                    """
                    UPDATE feedback.connector_delivery_queue SET status = 'processing', claimed_at = now(),
                        attempt_count = ?, available_at = now() + interval '2 minutes'
                    WHERE id = ?::uuid
                    """.trimIndent()
                ).use { update ->
                    update.setInt(1, delivery.attempt)
                    update.setString(2, delivery.id)
                    update.executeUpdate()
                }
                delivery
            }
        }
    }

    private fun deliverConnector(delivery: ClaimedConnectorDelivery) {
        val result = connectorDispatcher.dispatch(delivery)
        val success = result.error == null && (result.responseStatus ?: 0) in 200..299
        database.transaction { connection ->
            connection.prepareStatement(
                """
                INSERT INTO feedback.connector_delivery_attempts (
                    id, queue_id, retry_cycle, attempt, status, response_status, error
                ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?)
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, UUID.randomUUID().toString())
                statement.setString(2, delivery.id)
                statement.setInt(3, delivery.retryCycle)
                statement.setInt(4, delivery.attempt)
                statement.setString(5, if (success) "delivered" else "failed")
                if (result.responseStatus == null) statement.setNull(6, java.sql.Types.INTEGER)
                else statement.setInt(6, result.responseStatus)
                statement.setString(7, result.error?.take(2000))
                statement.executeUpdate()
            }
            val retryable = isRetryableConnectorResponse(result.responseStatus)
            val terminal = !retryable || delivery.attempt >= maxAttempts
            val delaySeconds = min(3600, 1 shl min(delivery.attempt, 10))
            connection.prepareStatement(
                """
                UPDATE feedback.connector_delivery_queue SET
                    status = ?, available_at = now() + (? * interval '1 second'),
                    delivered_at = CASE WHEN ? THEN now() ELSE delivered_at END,
                    last_error = ?, claimed_at = NULL
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, if (success) "delivered" else if (terminal) "failed" else "pending")
                statement.setInt(2, delaySeconds)
                statement.setBoolean(3, success)
                statement.setString(4, result.error?.take(2000))
                statement.setString(5, delivery.id)
                statement.executeUpdate()
            }
            if (!success) connection.incrementOperationalMetric("delivery_failures_total", delivery.tenantId)
            connection.refreshNotificationOutboxAggregate(delivery.eventId)
        }
    }
}

private fun java.sql.Connection.refreshNotificationOutboxAggregate(outboxId: String) {
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
        WHERE outbox.id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, outboxId)
        statement.executeUpdate()
    }
}

fun interface ConnectorDispatcher {
    fun dispatch(delivery: ClaimedConnectorDelivery): ConnectorDispatchResult
}

fun interface ConnectorHealthChecker {
    fun check(target: ConnectorHealthTarget): ConnectorHealthResult
}

class ConnectorHttpDispatcher(
    private val allowLocalDestinations: Boolean = false,
    private val allowPrivateDestinations: Boolean = false,
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
    private val requestTimeout: Duration = Duration.ofSeconds(15),
    private val now: () -> Instant = Instant::now
) : ConnectorDispatcher {
    override fun dispatch(delivery: ClaimedConnectorDelivery): ConnectorDispatchResult = try {
        validateConnectorDestination(
            delivery.deliveryUrl,
            delivery.allowedHosts,
            allowLocalDestinations,
            allowPrivateDestinations
        )
        val event = JsonObject(
            delivery.event.filterKeys { key ->
                key !in setOf("evidenceUrl", "evidence", "objectKey") && (key != "body" || delivery.includeBody)
            }
        )
        val occurredAt = event["occurredAt"]?.let { (it as JsonPrimitive).content }
            ?: throw IllegalArgumentException("connector event にoccurredAtがありません")
        val body = JsonObject(
            mapOf(
                "kind" to JsonPrimitive("delivery-request"),
                "protocolVersion" to JsonPrimitive("1"),
                "deliveryId" to JsonPrimitive(delivery.id),
                "eventId" to JsonPrimitive(delivery.eventId),
                "destinationRef" to JsonPrimitive(delivery.destinationRef),
                "occurredAt" to JsonPrimitive(occurredAt),
                "event" to event
            )
        ).toString()
        val timestamp = now().epochSecond.toString()
        val signature = connectorHmacSha256(delivery.signingSecret, "$timestamp.$body")
        val request = HttpRequest.newBuilder(URI(delivery.deliveryUrl))
            .timeout(requestTimeout)
            .header("Content-Type", "application/json")
            .header("X-Feedback-Delivery-Id", delivery.id)
            .header("X-Feedback-Timestamp", timestamp)
            .header("X-Feedback-Signature", "v1=$signature")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            ConnectorDispatchResult(response.statusCode(), "HTTP ${response.statusCode()}")
        } else {
            val result = runCatching {
                serviceJson.decodeFromString(ConnectorDeliveryResultV1.serializer(), response.body())
            }.getOrNull()
            val valid = result != null && result.kind == "delivery-result" && result.protocolVersion == "1" &&
                result.deliveryId == delivery.id && result.status in setOf("accepted", "duplicate")
            ConnectorDispatchResult(
                response.statusCode(),
                if (valid) null else "connector protocol result is invalid"
            )
        }
    } catch (exception: Exception) {
        ConnectorDispatchResult(null, "connector transport error (${exception::class.simpleName ?: "unknown"})")
    }
}

class ConnectorHttpHealthChecker(
    private val allowLocalDestinations: Boolean = false,
    private val allowPrivateDestinations: Boolean = false,
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
) : ConnectorHealthChecker {
    override fun check(target: ConnectorHealthTarget): ConnectorHealthResult = try {
        validateConnectorDestination(
            target.healthUrl,
            target.allowedHosts,
            allowLocalDestinations,
            allowPrivateDestinations
        )
        val response = client.send(
            HttpRequest.newBuilder(URI(target.healthUrl)).timeout(Duration.ofSeconds(10)).GET().build(),
            HttpResponse.BodyHandlers.discarding()
        )
        if (response.statusCode() in 200..299) ConnectorHealthResult(true, null)
        else ConnectorHealthResult(false, "HTTP ${response.statusCode()}")
    } catch (exception: Exception) {
        val reason = exception.message?.replace(Regex("[\\r\\n]+"), " ")?.take(500)
        ConnectorHealthResult(
            false,
            "connector health transport error (${exception::class.simpleName ?: "unknown"})" +
                if (reason.isNullOrBlank()) "" else ": $reason"
        )
    }
}

internal fun validateConnectorDestination(
    endpoint: String,
    allowedHosts: Set<String>,
    allowLocalDestinations: Boolean,
    allowPrivateDestinations: Boolean
) {
    val uri = URI(endpoint)
    if (uri.scheme != "https" && !(allowLocalDestinations && uri.scheme == "http")) {
        throw IllegalArgumentException("connector endpoint はhttpsで指定してください")
    }
    val host = uri.host ?: throw IllegalArgumentException("connector endpoint にhostがありません")
    require(host.lowercase() in allowedHosts) { "connector endpoint hostはallowlistにありません" }
    val unsafe = InetAddress.getAllByName(host).any { address ->
        address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress
    }
    if (!allowLocalDestinations && !allowPrivateDestinations && unsafe) {
        throw IllegalArgumentException("private/local connector endpointは許可されていません")
    }
}

internal fun isRetryableConnectorResponse(status: Int?): Boolean =
    status == null || status in setOf(408, 429) || (status ?: 0) in 500..599

internal fun connectorHmacSha256(secret: String, payload: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
    return mac.doFinal(payload.toByteArray()).joinToString("") { "%02x".format(it) }
}

data class ConnectorDispatchResult(val responseStatus: Int?, val error: String?)

data class ConnectorHealthTarget(val id: String, val healthUrl: String, val allowedHosts: Set<String>)

data class ConnectorHealthResult(val healthy: Boolean, val error: String?)

data class ClaimedConnectorDelivery(
    val id: String,
    val eventId: String,
    val event: JsonObject,
    val attempt: Int,
    val retryCycle: Int,
    val destinationRef: String,
    val includeBody: Boolean,
    val deliveryUrl: String,
    val signingSecret: String,
    val tenantId: String,
    val allowedHosts: Set<String>
)
