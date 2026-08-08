package feedback.service

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import java.net.InetAddress
import kotlin.math.min

fun main() {
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    database.migrate()
    val worker = NotificationWorker(database)
    Runtime.getRuntime().addShutdownHook(Thread { database.close() })
    worker.runForever()
}

class NotificationWorker(
    private val database: FeedbackDatabase,
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
    private val pollMillis: Long = (System.getenv("FEEDBACK_NOTIFICATION_POLL_MS") ?: "2000").toLong(),
    private val maxAttempts: Int = (System.getenv("FEEDBACK_NOTIFICATION_MAX_ATTEMPTS") ?: "5").toInt(),
    private val signingSecret: String = requiredEnv("FEEDBACK_WEBHOOK_SIGNING_SECRET"),
    private val notificationCipher: NotificationCipher = NotificationCipher.fromEnv()
) {
    init {
        require(signingSecret.length >= 32) { "FEEDBACK_WEBHOOK_SIGNING_SECRET は 32 文字以上で指定してください" }
    }

    fun runForever() {
        while (!Thread.currentThread().isInterrupted) {
            val delivery = claim()
            if (delivery == null) {
                Thread.sleep(pollMillis)
                continue
            }
            deliver(delivery)
        }
    }

    private fun claim(): ClaimedDelivery? = database.transaction { connection ->
        connection.prepareStatement(
            """
            SELECT o.id::text, o.payload::text, o.attempt_count,
                   s.webhook_endpoint_ciphertext, s.webhook_endpoint_nonce, s.include_body
            FROM feedback.notification_outbox o
            JOIN feedback.notification_settings s ON s.workspace_id = o.workspace_id
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
                val delivery = ClaimedDelivery(
                    id = result.getString(1),
                    payload = result.getString(2),
                    attempt = result.getInt(3) + 1,
                    endpoint = notificationCipher.decrypt(result.getBytes(4), result.getBytes(5)),
                    includeBody = result.getBoolean(6)
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
        try {
            val payload = if (delivery.includeBody) delivery.payload else redactBody(delivery.payload)
            val timestamp = java.time.Instant.now().epochSecond.toString()
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
            if (response.statusCode() in 200..299) complete(delivery, response.statusCode(), null)
            else retry(delivery, "HTTP ${response.statusCode()}", response.statusCode())
        } catch (exception: Exception) {
            retry(delivery, exception.message ?: exception::class.simpleName.orEmpty(), null)
        }
    }

    private fun complete(delivery: ClaimedDelivery, responseStatus: Int?, error: String?) {
        database.transaction { connection ->
            val state = if (error == null) "delivered" else "failed"
            connection.prepareStatement(
                """
                INSERT INTO feedback.notification_deliveries (
                    id, outbox_id, attempt, status, response_status, error
                ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?)
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, UUID.randomUUID().toString())
                statement.setString(2, delivery.id)
                statement.setInt(3, delivery.attempt)
                statement.setString(4, state)
                if (responseStatus == null) statement.setNull(5, java.sql.Types.INTEGER) else statement.setInt(5, responseStatus)
                statement.setString(6, error)
                statement.executeUpdate()
            }
            if (error == null) {
                connection.prepareStatement(
                    "UPDATE feedback.notification_outbox SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = ?::uuid"
                ).use { statement -> statement.setString(1, delivery.id); statement.executeUpdate() }
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

    private fun redactBody(payload: String): String {
        val json = serviceJson.parseToJsonElement(payload).jsonObject
        return JsonObject(json - "body" - "evidenceUrl").toString()
    }

    private fun hmacSha256(secret: String, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        return mac.doFinal(payload.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun validateWebhookDestination(endpoint: String) {
        val host = URI(endpoint).host ?: error("webhook endpoint に host がありません")
        val unsafe = InetAddress.getAllByName(host).any { address ->
            address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
                address.isSiteLocalAddress || address.isMulticastAddress
        }
        require(!unsafe) { "private/local address への webhook 配送は許可されていません" }
    }
}

data class ClaimedDelivery(
    val id: String,
    val payload: String,
    val attempt: Int,
    val endpoint: String,
    val includeBody: Boolean
)
