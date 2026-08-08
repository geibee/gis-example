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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

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
    private val dispatcher: NotificationDispatcher = WebhookDispatcher(
        signingSecret = requiredEnv("FEEDBACK_WEBHOOK_SIGNING_SECRET"),
        allowLocalDestinations = System.getenv("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP") == "1"
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
        val delivery = claim() ?: return false
        deliver(delivery)
        return true
    }

    private fun claim(): ClaimedDelivery? = database.transaction { connection ->
        connection.prepareStatement(
            """
            SELECT o.id::text, o.payload::text, o.attempt_count,
                   s.webhook_endpoint_ciphertext, s.webhook_endpoint_nonce,
                   s.include_body, s.include_evidence, o.retry_cycle,
                   t.location::text, e.base_url, e.deep_link_thread_parameter, m.manifest::text,
                   EXISTS (SELECT 1 FROM feedback.review_evidence evidence WHERE evidence.thread_id = t.id)
            FROM feedback.notification_outbox o
            JOIN feedback.notification_settings s ON s.workspace_id = o.workspace_id
            LEFT JOIN feedback.feedback_threads t ON t.id = NULLIF(o.payload->>'threadId', '')::uuid
            LEFT JOIN feedback.review_sessions r ON r.id = t.session_id
            LEFT JOIN feedback.application_environments e ON e.id = t.environment_id
            LEFT JOIN feedback.application_manifests m
              ON m.application_id = t.application_id AND m.manifest_version = r.manifest_version
            WHERE o.status IN ('pending', 'processing')
              AND o.available_at <= now()
              AND s.webhook_enabled
              AND s.webhook_endpoint_ciphertext IS NOT NULL
            ORDER BY o.created_at
            FOR UPDATE OF o SKIP LOCKED
            LIMIT 1
            """.trimIndent()
        ).use { statement ->
            statement.executeQuery().use { result ->
                if (!result.next()) return@transaction null
                val payload = runCatching {
                    val original = serviceJson.parseToJsonElement(result.getString(2)).jsonObject
                    val locationRaw = result.getString(9) ?: return@runCatching original
                    val manifestRaw = result.getString(12) ?: return@runCatching original
                    val link = buildFeedbackDeepLink(
                        result.getString(10),
                        result.getString(11),
                        serviceJson.parseToJsonElement(manifestRaw).jsonObject,
                        serviceJson.parseToJsonElement(locationRaw).jsonObject,
                        original.getValue("threadId").let { (it as JsonPrimitive).content }
                    )
                    JsonObject(buildMap {
                        putAll(original)
                        put("deepLink", JsonPrimitive(link))
                        if (result.getBoolean(13)) {
                            val threadId = original.getValue("threadId").let { (it as JsonPrimitive).content }
                            put("evidenceUrl", JsonPrimitive("/feedback/v1/threads/$threadId/evidence"))
                        }
                    })
                }.getOrElse { serviceJson.parseToJsonElement(result.getString(2)).jsonObject }
                val delivery = ClaimedDelivery(
                    id = result.getString(1),
                    payload = payload.toString(),
                    attempt = result.getInt(3) + 1,
                    endpoint = notificationCipher.decrypt(result.getBytes(4), result.getBytes(5)),
                    includeBody = result.getBoolean(6),
                    includeEvidence = result.getBoolean(7),
                    retryCycle = result.getInt(8)
                )
                connection.prepareStatement(
                    """
                    UPDATE feedback.notification_outbox
                    SET status = 'processing', claimed_at = now(), attempt_count = ?,
                        available_at = now() + interval '2 minutes'
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

    private fun deliver(delivery: ClaimedDelivery) {
        val result = dispatcher.dispatch(delivery)
        if (result.error == null && (result.responseStatus ?: 0) in 200..299) {
            complete(delivery, result.responseStatus, null)
        } else {
            retry(delivery, result.error ?: "HTTP ${result.responseStatus}", result.responseStatus)
        }
    }

    private fun complete(delivery: ClaimedDelivery, responseStatus: Int?, error: String?) {
        database.transaction { connection ->
            val state = if (error == null) "delivered" else "failed"
            connection.prepareStatement(
                """
                INSERT INTO feedback.notification_deliveries (
                    id, outbox_id, retry_cycle, attempt, status, response_status, error
                ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?)
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, UUID.randomUUID().toString())
                statement.setString(2, delivery.id)
                statement.setInt(3, delivery.retryCycle)
                statement.setInt(4, delivery.attempt)
                statement.setString(5, state)
                if (responseStatus == null) statement.setNull(6, java.sql.Types.INTEGER) else statement.setInt(6, responseStatus)
                statement.setString(7, error)
                statement.executeUpdate()
            }
            if (error == null) {
                connection.prepareStatement(
                    "UPDATE feedback.notification_outbox SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = ?::uuid"
                ).use { statement ->
                    statement.setString(1, delivery.id)
                    statement.executeUpdate()
                }
            }
        }
    }

    private fun retry(delivery: ClaimedDelivery, error: String, responseStatus: Int?) {
        complete(delivery, responseStatus, error.take(2000))
        database.transaction { connection ->
            val terminal = delivery.attempt >= maxAttempts
            val delaySeconds = min(3600, 1 shl min(delivery.attempt, 10))
            connection.prepareStatement(
                """
                UPDATE feedback.notification_outbox SET
                    status = ?, available_at = now() + (? * interval '1 second'), last_error = ?
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, if (terminal) "failed" else "pending")
                statement.setInt(2, delaySeconds)
                statement.setString(3, error.take(2000))
                statement.setString(4, delivery.id)
                statement.executeUpdate()
            }
        }
    }
}

fun interface NotificationDispatcher {
    fun dispatch(delivery: ClaimedDelivery): WebhookDeliveryResult
}

class WebhookDispatcher(
    private val signingSecret: String,
    private val allowLocalDestinations: Boolean = false,
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
    private val now: () -> Instant = Instant::now
) : NotificationDispatcher {
    init {
        require(signingSecret.length >= 32) { "FEEDBACK_WEBHOOK_SIGNING_SECRET は 32 文字以上で指定してください" }
    }

    override fun dispatch(delivery: ClaimedDelivery): WebhookDeliveryResult = try {
        val payload = redact(delivery.payload, delivery.includeBody, delivery.includeEvidence)
        val timestamp = now().epochSecond.toString()
        val signature = hmacSha256(signingSecret, "$timestamp.$payload")
        validateWebhookDestination(delivery.endpoint)
        val request = HttpRequest.newBuilder(URI(delivery.endpoint))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .header("X-Feedback-Delivery-Id", delivery.id)
            .header("X-Feedback-Timestamp", timestamp)
            .header("X-Feedback-Signature", "v1=$signature")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .build()
        val response = client.send(request, HttpResponse.BodyHandlers.discarding())
        WebhookDeliveryResult(response.statusCode(), if (response.statusCode() in 200..299) null else "HTTP ${response.statusCode()}")
    } catch (exception: WebhookDestinationException) {
        WebhookDeliveryResult(null, requireNotNull(exception.message))
    } catch (exception: Exception) {
        WebhookDeliveryResult(null, "webhook transport error (${exception::class.simpleName ?: "unknown"})")
    }

    private fun redact(payload: String, includeBody: Boolean, includeEvidence: Boolean): String {
        val json = serviceJson.parseToJsonElement(payload).jsonObject
        return JsonObject(buildMap {
            json.forEach { (key, value) ->
                if ((key != "body" || includeBody) && (key != "evidenceUrl" || includeEvidence)) {
                    if (value !is JsonNull) put(key, value)
                }
            }
        }).toString()
    }

    private fun validateWebhookDestination(endpoint: String) {
        val uri = try {
            URI(endpoint)
        } catch (_: Exception) {
            throw WebhookDestinationException("webhook endpoint が不正です")
        }
        if (uri.scheme != "https" && !(allowLocalDestinations && uri.scheme == "http")) {
            throw WebhookDestinationException("webhook endpoint は https で指定してください")
        }
        val host = uri.host ?: throw WebhookDestinationException("webhook endpoint に host がありません")
        val unsafe = InetAddress.getAllByName(host).any { address ->
            address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
                address.isSiteLocalAddress || address.isMulticastAddress
        }
        if (!allowLocalDestinations && unsafe) {
            throw WebhookDestinationException("private/local address への webhook 配送は許可されていません")
        }
    }

    private fun hmacSha256(secret: String, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        return mac.doFinal(payload.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

private class WebhookDestinationException(message: String) : IllegalArgumentException(message)

data class WebhookDeliveryResult(val responseStatus: Int?, val error: String?)

data class ClaimedDelivery(
    val id: String,
    val payload: String,
    val attempt: Int,
    val endpoint: String,
    val includeBody: Boolean,
    val includeEvidence: Boolean,
    val retryCycle: Int
)
