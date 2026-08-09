// プロトタイプレビュー Phase 7: Email (Amazon SES) / Teams / Issue Webhook への一方向配信。
package gis.example

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.slf4j.LoggerFactory
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.sesv2.SesV2Client
import software.amazon.awssdk.services.sesv2.model.Body
import software.amazon.awssdk.services.sesv2.model.Content
import software.amazon.awssdk.services.sesv2.model.Destination
import software.amazon.awssdk.services.sesv2.model.EmailContent
import software.amazon.awssdk.services.sesv2.model.Message
import software.amazon.awssdk.services.sesv2.model.SendEmailRequest
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.min

internal data class ReviewNotificationContent(
    val title: String,
    val text: String,
    val link: String
)

internal interface ReviewNotificationSender : AutoCloseable {
    val capabilities: ReviewNotificationCapabilities

    /** 外部側の ID / Location が得られた場合だけ返す。 */
    fun send(notification: ClaimedReviewNotification): String?

    override fun close() = Unit
}

private class ConfiguredReviewNotificationSender(
    private val appUrl: String,
    private val emailFrom: String?,
    private val ses: SesV2Client?,
    private val teamsWebhookUrl: String?,
    private val issueWebhookUrl: String?,
    private val issueWebhookToken: String?,
    requestTimeoutSeconds: Long
) : ReviewNotificationSender {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(requestTimeoutSeconds))
        .build()
    private val requestTimeout = Duration.ofSeconds(requestTimeoutSeconds)

    override val capabilities = ReviewNotificationCapabilities(
        email = emailFrom != null && ses != null,
        teams = teamsWebhookUrl != null,
        issue = issueWebhookUrl != null
    )

    override fun send(notification: ClaimedReviewNotification): String? {
        val content = renderReviewNotification(notification, appUrl)
        return when (notification.channel) {
            ReviewNotificationChannel.EMAIL -> sendEmail(notification, content)
            ReviewNotificationChannel.TEAMS -> sendTeams(notification, content)
            ReviewNotificationChannel.ISSUE -> sendIssue(notification, content)
        }
    }

    private fun sendEmail(notification: ClaimedReviewNotification, content: ReviewNotificationContent): String? {
        val destination = requireNotNull(notification.destination) { "Email destination is missing" }
        val client = requireNotNull(ses) { "Email integration is not configured" }
        val response = client.sendEmail(
            SendEmailRequest.builder()
                .fromEmailAddress(requireNotNull(emailFrom))
                .destination(Destination.builder().toAddresses(destination).build())
                .content(
                    EmailContent.builder().simple(
                        Message.builder()
                            .subject(Content.builder().data(content.title).charset(StandardCharsets.UTF_8.name()).build())
                            .body(
                                Body.builder().text(
                                    Content.builder().data("${content.text}\n\n${content.link}")
                                        .charset(StandardCharsets.UTF_8.name()).build()
                                ).build()
                            ).build()
                    ).build()
                )
                .build()
        )
        return response.messageId()
    }

    private fun sendTeams(notification: ClaimedReviewNotification, content: ReviewNotificationContent): String? {
        val body = buildJsonObject {
            put("type", "message")
            putJsonArray("attachments") {
                add(
                    buildJsonObject {
                        put("contentType", "application/vnd.microsoft.card.adaptive")
                        putJsonObject("content") {
                            put("type", "AdaptiveCard")
                            put("version", "1.4")
                            put("${'$'}schema", "http://adaptivecards.io/schemas/adaptive-card.json")
                            put("body", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "TextBlock")
                                    put("weight", "Bolder")
                                    put("wrap", true)
                                    put("text", content.title)
                                })
                                add(buildJsonObject {
                                    put("type", "TextBlock")
                                    put("wrap", true)
                                    put("text", content.text)
                                })
                            })
                            put("actions", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "Action.OpenUrl")
                                    put("title", "レビューを開く")
                                    put("url", content.link)
                                })
                            })
                        }
                    }
                )
            }
        }
        return postJson(requireNotNull(teamsWebhookUrl), body.toString(), notification.outboxId, null)
    }

    private fun sendIssue(notification: ClaimedReviewNotification, content: ReviewNotificationContent): String? {
        val body = buildJsonObject {
            put("event", "review.issue.create")
            put("idempotencyKey", notification.outboxId)
            put("projectId", notification.projectId)
            put("threadId", notification.threadId)
            put("title", content.title)
            put("body", "${content.text}\n\n${content.link}")
            putJsonArray("labels") {
                add(kotlinx.serialization.json.JsonPrimitive("prototype-review"))
            }
        }
        return postJson(requireNotNull(issueWebhookUrl), body.toString(), notification.outboxId, issueWebhookToken)
    }

    private fun postJson(url: String, body: String, idempotencyKey: String, bearerToken: String?): String? {
        val builder = HttpRequest.newBuilder(URI.create(url))
            .timeout(requestTimeout)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("Idempotency-Key", idempotencyKey)
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
        bearerToken?.let { builder.header("Authorization", "Bearer $it") }
        val response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        if (response.statusCode() !in 200..299) {
            // 応答本文には接続先実装の機微情報が含まれ得るため、DB の last_error へ保存しない。
            throw IllegalStateException("Webhook returned HTTP ${response.statusCode()}")
        }
        return response.headers().firstValue("Location").orElse(null)
    }

    override fun close() {
        ses?.close()
    }
}

internal fun reviewNotificationSenderFromEnv(
    getenv: (String) -> String? = System::getenv
): ReviewNotificationSender {
    val emailFrom = getenv("REVIEW_EMAIL_FROM")?.trim()?.takeIf { it.isNotEmpty() }
    val ses = emailFrom?.let {
        val builder = SesV2Client.builder()
        getenv("REVIEW_SES_REGION")?.trim()?.takeIf(String::isNotEmpty)?.let { builder.region(Region.of(it)) }
        getenv("REVIEW_SES_ENDPOINT_URL")?.trim()?.takeIf(String::isNotEmpty)?.let { builder.endpointOverride(URI.create(it)) }
        builder.build()
    }
    return ConfiguredReviewNotificationSender(
        appUrl = (getenv("REVIEW_APP_URL") ?: getenv("WEB_ORIGIN") ?: "http://localhost:5173").trimEnd('/'),
        emailFrom = emailFrom,
        ses = ses,
        teamsWebhookUrl = getenv("REVIEW_TEAMS_WEBHOOK_URL")?.trim()?.takeIf { it.isNotEmpty() },
        issueWebhookUrl = getenv("REVIEW_ISSUE_WEBHOOK_URL")?.trim()?.takeIf { it.isNotEmpty() },
        issueWebhookToken = getenv("REVIEW_ISSUE_WEBHOOK_TOKEN")?.trim()?.takeIf { it.isNotEmpty() },
        requestTimeoutSeconds = positiveLongEnv(getenv, "REVIEW_NOTIFICATION_REQUEST_TIMEOUT_SECONDS", 10)
    )
}

internal fun renderReviewNotification(
    notification: ClaimedReviewNotification,
    appUrl: String
): ReviewNotificationContent {
    val project = notification.payload.getValue("projectName").jsonPrimitive.content
    val session = notification.payload.getValue("sessionTitle").jsonPrimitive.content
    val perspective = notification.payload.getValue("perspectiveLabel").jsonPrimitive.content
    val actor = notification.payload.getValue("actorName").jsonPrimitive.content
    val body = notification.payload.getValue("body").jsonPrimitive.content
    val eventLabel = when (notification.eventType) {
        "THREAD_CREATED" -> "新しい指摘"
        "MESSAGE_CREATED" -> "返信"
        "THREAD_RESOLVED" -> "解決"
        "THREAD_REOPENED" -> "再開"
        else -> error("Unsupported review notification event: ${notification.eventType}")
    }
    return ReviewNotificationContent(
        title = "[$project] $eventLabel: $perspective",
        text = "$actor · $session\n${body.take(2000)}",
        link = "${appUrl.trimEnd('/')}/review?projectId=${notification.projectId}&threadId=${notification.threadId}"
    )
}

internal data class ReviewNotificationWorkerSettings(
    val pollIntervalMillis: Long,
    val maxAttempts: Int,
    val leaseSeconds: Long
) {
    companion object {
        fun fromEnv(getenv: (String) -> String? = System::getenv) = ReviewNotificationWorkerSettings(
            pollIntervalMillis = positiveLongEnv(getenv, "REVIEW_NOTIFICATION_POLL_INTERVAL_SECONDS", 2) * 1000,
            maxAttempts = positiveLongEnv(getenv, "REVIEW_NOTIFICATION_MAX_ATTEMPTS", 5).toInt(),
            leaseSeconds = positiveLongEnv(getenv, "REVIEW_NOTIFICATION_LEASE_SECONDS", 120)
        )
    }
}

internal class ReviewNotificationWorker(
    private val db: Database,
    private val sender: ReviewNotificationSender,
    private val settings: ReviewNotificationWorkerSettings
) {
    private val logger = LoggerFactory.getLogger("gis.example.ReviewNotificationWorker")
    private val running = AtomicBoolean(false)
    private var workerThread: Thread? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        workerThread = thread(name = "review-notification-worker", isDaemon = true) {
            while (running.get()) {
                val delivered = runCatching { pollOnce() }.onFailure {
                    logger.error("レビュー通知ワーカーのポーリングに失敗しました", it)
                }.getOrDefault(false)
                if (!delivered) {
                    try {
                        Thread.sleep(settings.pollIntervalMillis)
                    } catch (_: InterruptedException) {
                        if (!running.get()) break
                    }
                }
            }
        }
    }

    internal fun pollOnce(): Boolean {
        val notification = db.claimReviewNotification(
            settings.maxAttempts,
            settings.leaseSeconds,
            sender.capabilities
        ) ?: return false
        runCatching { sender.send(notification) }
            .onSuccess { externalReference ->
                db.completeReviewNotification(notification.deliveryId, externalReference)
            }
            .onFailure { error ->
                val retryDelay = min(3600L, 5L * (1L shl min(notification.attemptCount - 1, 10)))
                db.failReviewNotification(
                    notification.deliveryId,
                    error.message ?: error::class.simpleName ?: "delivery failed",
                    retryDelay
                )
                // URL・token・宛先をログへ出さない。識別には deliveryId だけを使う。
                logger.warn("レビュー通知の配信に失敗しました: deliveryId={}", notification.deliveryId)
            }
        return true
    }

    fun stop() {
        running.set(false)
        workerThread?.interrupt()
        workerThread?.join(5000)
        sender.close()
    }
}

private fun positiveLongEnv(getenv: (String) -> String?, name: String, defaultValue: Long): Long {
    val value = (getenv(name) ?: defaultValue.toString()).toLongOrNull()
        ?: error("$name は正の整数で指定してください")
    require(value > 0) { "$name は正の整数で指定してください" }
    return value
}
