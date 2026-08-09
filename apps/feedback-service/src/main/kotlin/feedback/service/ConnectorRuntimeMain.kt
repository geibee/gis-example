package feedback.service

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.call
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import jakarta.mail.Authenticator
import jakarta.mail.Message
import jakarta.mail.PasswordAuthentication
import jakarta.mail.Session
import jakarta.mail.Transport
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import java.util.UUID
import kotlin.concurrent.withLock
import java.util.Properties
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class ConnectorManifestV1(
    val kind: String = "manifest",
    val protocolVersion: String = "1",
    val compatibleProtocolVersions: List<String> = listOf("1"),
    val connectorKey: String,
    val displayName: String,
    val supportedEvents: List<String>,
    val healthPath: String = "/health/ready"
)

@Serializable
data class ConnectorDeliveryRequestV1(
    val kind: String,
    val protocolVersion: String,
    val deliveryId: String,
    val eventId: String,
    val destinationRef: String,
    val occurredAt: String,
    val event: JsonObject
)

@Serializable
data class ConnectorDeliveryResultV1(
    val kind: String = "delivery-result",
    val protocolVersion: String = "1",
    val deliveryId: String,
    val status: String,
    val receivedAt: String
)

fun main() {
    val settings = ConnectorRuntimeSettings.fromEnv()
    val dispatcher = referenceConnectorDispatcher(settings)
    val received = FileDeliveryIdStore(settings.idempotencyFile, 100_000)
    embeddedServer(Netty, port = settings.port) {
        connectorRuntimeModule(settings, dispatcher, received)
    }.start(wait = true)
}

internal fun Application.connectorRuntimeModule(
    settings: ConnectorRuntimeSettings,
    dispatcher: ReferenceConnectorDispatcher,
    received: DeliveryIdStore,
    now: () -> Instant = Instant::now
) {
    val deliveryGate = DeliveryExecutionGate()
    install(ContentNegotiation) { json(serviceJson) }
    routing {
            get("/connector/v1/manifest") {
                call.respond(
                    ConnectorManifestV1(
                        connectorKey = settings.provider,
                        displayName = settings.displayName,
                        supportedEvents = supportedNotificationEventsForConnector
                    )
                )
            }
            get("/health/live") { call.respond(mapOf("status" to "live")) }
            get("/health/ready") { call.respond(mapOf("status" to "ready")) }
            post("/connector/v1/deliveries") {
                val raw = call.receiveText()
                if (raw.toByteArray(StandardCharsets.UTF_8).size > 256 * 1024) {
                    call.respondText("request too large", ContentType.Text.Plain, HttpStatusCode.PayloadTooLarge)
                    return@post
                }
                val timestamp = call.request.headers["X-Feedback-Timestamp"]?.toLongOrNull()
                val signature = call.request.headers["X-Feedback-Signature"]?.removePrefix("v1=")
                val currentEpoch = now().epochSecond
                if (timestamp == null || signature == null || timestamp !in (currentEpoch - 300)..(currentEpoch + 300) ||
                    !constantTimeEquals(signature, connectorHmacSha256(settings.sharedSecret, "$timestamp.$raw"))) {
                    call.respondText("invalid signature", ContentType.Text.Plain, HttpStatusCode.Unauthorized)
                    return@post
                }
                val delivery = runCatching {
                    serviceJson.decodeFromString(ConnectorDeliveryRequestV1.serializer(), raw)
                }.getOrElse {
                    call.respondText("invalid request", ContentType.Text.Plain, HttpStatusCode.BadRequest)
                    return@post
                }
                if (delivery.kind != "delivery-request" || delivery.protocolVersion != "1") {
                    call.respondText("unsupported protocol", ContentType.Text.Plain, HttpStatusCode.BadRequest)
                    return@post
                }
                if (call.request.headers["X-Feedback-Delivery-Id"] != delivery.deliveryId) {
                    call.respondText("delivery id mismatch", ContentType.Text.Plain, HttpStatusCode.BadRequest)
                    return@post
                }
                if (!validConnectorDelivery(delivery)) {
                    call.respondText("event envelope mismatch", ContentType.Text.Plain, HttpStatusCode.BadRequest)
                    return@post
                }
                val processing = deliveryGate.process(delivery.deliveryId) {
                    if (received.contains(delivery.deliveryId)) {
                        ConnectorProcessingResult.Duplicate
                    } else {
                        runCatching { dispatcher.dispatch(delivery) }.fold(
                            onSuccess = {
                                received.add(delivery.deliveryId)
                                ConnectorProcessingResult.Accepted
                            },
                            onFailure = ConnectorProcessingResult::Failed
                        )
                    }
                }
                if (processing == ConnectorProcessingResult.Duplicate) {
                    call.respond(
                        HttpStatusCode.OK,
                        ConnectorDeliveryResultV1(
                            deliveryId = delivery.deliveryId,
                            status = "duplicate",
                            receivedAt = now().toString()
                        )
                    )
                    return@post
                }
                if (processing == ConnectorProcessingResult.Accepted) {
                    call.respond(
                        HttpStatusCode.Accepted,
                        ConnectorDeliveryResultV1(
                            deliveryId = delivery.deliveryId,
                            status = "accepted",
                            receivedAt = now().toString()
                        )
                    )
                } else {
                    val failure = processing as ConnectorProcessingResult.Failed
                    call.application.environment.log.error("connector delivery failed: deliveryId={}", delivery.deliveryId, failure.cause)
                    call.respondText("delivery failed", ContentType.Text.Plain, HttpStatusCode.BadGateway)
                }
            }
        }
}

private fun validConnectorDelivery(delivery: ConnectorDeliveryRequestV1): Boolean = runCatching {
    UUID.fromString(delivery.deliveryId)
    UUID.fromString(delivery.eventId)
    require(delivery.destinationRef.isNotBlank() && delivery.destinationRef.length <= 200)
    Instant.parse(delivery.occurredAt)
    val event = serviceJson.decodeFromJsonElement<NotificationWebhookEvent>(delivery.event)
    require(event.schemaVersion == "1")
    require(event.eventId == delivery.eventId && event.occurredAt == delivery.occurredAt)
    require(event.eventType in supportedNotificationEventsForConnector)
    require(event.deepLink != null && URI(event.deepLink).isAbsolute && event.deepLink.length <= 2000)
    require(event.evidenceUrl == null)
    UUID.fromString(event.sessionId)
    UUID.fromString(event.threadId)
    require(event.requestId.isNotBlank() && event.requestId.length <= 200)
    require(event.tenantKey.isNotBlank() && event.tenantKey.length <= 100)
    require(event.applicationKey.isNotBlank() && event.applicationKey.length <= 100)
    require(event.environmentKey.isNotBlank() && event.environmentKey.length <= 100)
    require(event.externalWorkspaceKey.isNotBlank() && event.externalWorkspaceKey.length <= 200)
    require(event.actor.principalId.isNotBlank() && event.actor.principalId.length <= 200)
    require(event.body == null || event.body.length <= 20_000)
}.isSuccess

internal data class ConnectorRuntimeSettings(
    val port: Int,
    val provider: String,
    val displayName: String,
    val sharedSecret: String,
    val destinations: Map<String, String>,
    val allowLocalHttp: Boolean,
    val idempotencyFile: Path,
    val webhookSigningSecret: String? = null
) {
    companion object {
        fun fromEnv(): ConnectorRuntimeSettings {
            val provider = requiredEnv("FEEDBACK_CONNECTOR_PROVIDER").lowercase()
            require(provider in setOf("webhook", "teams", "slack", "smtp-mail")) {
                "FEEDBACK_CONNECTOR_PROVIDER は webhook, teams, slack, smtp-mail のいずれかです"
            }
            val secret = requiredEnv("FEEDBACK_CONNECTOR_SHARED_SECRET")
            require(secret.length >= 32) { "FEEDBACK_CONNECTOR_SHARED_SECRET は32文字以上必要です" }
            val destinations = serviceJson.parseToJsonElement(requiredEnv("FEEDBACK_CONNECTOR_DESTINATIONS"))
                .jsonObject.mapValues { (_, value) -> value.jsonPrimitive.content }
            require(destinations.isNotEmpty()) { "FEEDBACK_CONNECTOR_DESTINATIONS は1件以上必要です" }
            val webhookSigningSecret = if (provider == "webhook") {
                requiredEnv("FEEDBACK_WEBHOOK_SIGNING_SECRET").also {
                    require(it.length >= 32) { "FEEDBACK_WEBHOOK_SIGNING_SECRET は32文字以上必要です" }
                }
            } else null
            return ConnectorRuntimeSettings(
                port = (System.getenv("FEEDBACK_CONNECTOR_PORT") ?: "8091").toInt(),
                provider = provider,
                displayName = System.getenv("FEEDBACK_CONNECTOR_DISPLAY_NAME") ?: provider,
                sharedSecret = secret,
                destinations = destinations,
                allowLocalHttp = System.getenv("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP") == "1",
                idempotencyFile = Path.of(requiredEnv("FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE")).toAbsolutePath().normalize(),
                webhookSigningSecret = webhookSigningSecret
            )
        }
    }
}

private val supportedNotificationEventsForConnector = listOf(
    "feedback.thread.created.v1",
    "feedback.message.created.v1",
    "feedback.thread.resolved.v1",
    "feedback.thread.reopened.v1"
)

internal fun interface ReferenceConnectorDispatcher {
    fun dispatch(delivery: ConnectorDeliveryRequestV1)
}

internal fun referenceConnectorDispatcher(settings: ConnectorRuntimeSettings): ReferenceConnectorDispatcher =
    when (settings.provider) {
        "webhook" -> HttpReferenceConnector(
            settings,
            ::webhookPayload,
            outboundSigningSecret = requireNotNull(settings.webhookSigningSecret)
        )
        "teams" -> HttpReferenceConnector(settings, ::teamsPayload)
        "slack" -> HttpReferenceConnector(settings, ::slackPayload)
        "smtp-mail" -> SmtpReferenceConnector(settings, SmtpSettings.fromEnv())
        else -> error("unsupported connector provider")
    }

internal class HttpReferenceConnector(
    private val settings: ConnectorRuntimeSettings,
    private val payload: (ConnectorDeliveryRequestV1) -> String,
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(),
    private val outboundSigningSecret: String? = null,
    private val now: () -> Instant = Instant::now
) : ReferenceConnectorDispatcher {
    override fun dispatch(delivery: ConnectorDeliveryRequestV1) {
        val endpoint = settings.destinations[delivery.destinationRef]
            ?: throw IllegalArgumentException("unknown destinationRef")
        validateExternalConnectorDestination(endpoint, settings.allowLocalHttp)
        val body = payload(delivery)
        val request = HttpRequest.newBuilder(URI(endpoint))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .header("X-Feedback-Delivery-Id", delivery.deliveryId)
            .apply {
                outboundSigningSecret?.let { secret ->
                    val timestamp = now().epochSecond.toString()
                    header("X-Feedback-Timestamp", timestamp)
                    header("X-Feedback-Signature", "v1=${connectorHmacSha256(secret, "$timestamp.$body")}")
                }
            }
            .POST(HttpRequest.BodyPublishers.ofString(body)).build()
        val response = client.send(request, HttpResponse.BodyHandlers.discarding())
        check(response.statusCode() in 200..299) { "destination returned HTTP ${response.statusCode()}" }
    }
}

internal data class SmtpSettings(
    val host: String,
    val port: Int,
    val username: String?,
    val password: String?,
    val senderAddress: String
) {
    companion object {
        fun fromEnv() = SmtpSettings(
            host = requiredEnv("FEEDBACK_SMTP_HOST"),
            port = (System.getenv("FEEDBACK_SMTP_PORT") ?: "587").toInt(),
            username = System.getenv("FEEDBACK_SMTP_USERNAME"),
            password = System.getenv("FEEDBACK_SMTP_PASSWORD"),
            senderAddress = requiredEnv("FEEDBACK_SMTP_FROM")
        )
    }
}

internal data class MailDelivery(
    val from: String,
    val to: List<String>,
    val subject: String,
    val body: String,
    val deliveryId: String
)

internal fun interface MailSender {
    fun send(delivery: MailDelivery)
}

internal class SmtpReferenceConnector(
    private val settings: ConnectorRuntimeSettings,
    private val smtp: SmtpSettings,
    private val mailSender: MailSender = JakartaMailSender(smtp)
) : ReferenceConnectorDispatcher {
    override fun dispatch(delivery: ConnectorDeliveryRequestV1) {
        val destinationAddresses = settings.destinations[delivery.destinationRef]
            ?.split(',')?.map(String::trim)?.filter(String::isNotEmpty)
            ?: throw IllegalArgumentException("unknown destinationRef")
        require(destinationAddresses.isNotEmpty()) { "mail destination is empty" }
        mailSender.send(smtpMailDelivery(delivery, smtp.senderAddress, destinationAddresses))
    }
}

internal class JakartaMailSender(private val smtp: SmtpSettings) : MailSender {
    override fun send(delivery: MailDelivery) {
        val properties = Properties().apply {
            put("mail.smtp.host", smtp.host)
            put("mail.smtp.port", smtp.port.toString())
            put("mail.smtp.starttls.enable", "true")
            put("mail.smtp.starttls.required", "true")
            put("mail.smtp.auth", (smtp.username != null).toString())
            put("mail.smtp.connectiontimeout", "10000")
            put("mail.smtp.timeout", "15000")
            put("mail.smtp.writetimeout", "15000")
        }
        val session = Session.getInstance(properties, if (smtp.username == null) null else object : Authenticator() {
            override fun getPasswordAuthentication(): PasswordAuthentication =
                PasswordAuthentication(smtp.username, smtp.password ?: error("FEEDBACK_SMTP_PASSWORD が未設定です"))
        })
        val message = MimeMessage(session).apply {
            setFrom(InternetAddress(delivery.from))
            delivery.to.forEach { addRecipient(Message.RecipientType.TO, InternetAddress(it)) }
            subject = delivery.subject
            setText(delivery.body, StandardCharsets.UTF_8.name())
            setHeader("X-Feedback-Delivery-Id", delivery.deliveryId)
        }
        Transport.send(message)
    }
}

internal fun smtpMailDelivery(
    delivery: ConnectorDeliveryRequestV1,
    senderAddress: String,
    destinations: List<String>
) = MailDelivery(
    from = senderAddress,
    to = destinations,
    subject = "[Feedback] ${delivery.event.string("eventType")}",
    body = notificationText(delivery.event),
    deliveryId = delivery.deliveryId
)

internal fun webhookPayload(delivery: ConnectorDeliveryRequestV1): String = delivery.event.toString()

internal fun teamsPayload(delivery: ConnectorDeliveryRequestV1): String = buildJsonObject {
    put("type", "message")
    put("summary", "Feedback notification")
    put("text", notificationText(delivery.event))
}.toString()

internal fun slackPayload(delivery: ConnectorDeliveryRequestV1): String = buildJsonObject {
    put("text", notificationText(delivery.event))
}.toString()

internal fun notificationText(event: JsonObject): String = buildString {
    append(event.string("eventType"))
    event["actor"]?.jsonObject?.get("displayName")?.let { append("\nActor: ${it.jsonPrimitive.content}") }
    event["body"]?.let { append("\n${it.jsonPrimitive.content}") }
    event["deepLink"]?.let { append("\n${it.jsonPrimitive.content}") }
}

private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content

private fun validateExternalConnectorDestination(endpoint: String, allowLocalHttp: Boolean) {
    val uri = URI(endpoint)
    require(uri.scheme == "https" || (allowLocalHttp && uri.scheme == "http")) { "destination はHTTPSで指定してください" }
    val host = uri.host ?: throw IllegalArgumentException("destination hostがありません")
    val unsafe = InetAddress.getAllByName(host).any { address ->
        address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress
    }
    require(allowLocalHttp || !unsafe) { "private/local destinationは許可されていません" }
}

private fun constantTimeEquals(left: String, right: String): Boolean =
    MessageDigest.isEqual(left.toByteArray(), right.toByteArray())

internal interface DeliveryIdStore {
    fun contains(id: String): Boolean
    fun add(id: String)
}

private sealed interface ConnectorProcessingResult {
    data object Accepted : ConnectorProcessingResult
    data object Duplicate : ConnectorProcessingResult
    data class Failed(val cause: Throwable) : ConnectorProcessingResult
}

private class DeliveryExecutionGate {
    private data class LockEntry(val lock: ReentrantLock = ReentrantLock(), val users: AtomicInteger = AtomicInteger())

    private val locks = ConcurrentHashMap<String, LockEntry>()

    fun process(deliveryId: String, block: () -> ConnectorProcessingResult): ConnectorProcessingResult {
        val entry = requireNotNull(locks.compute(deliveryId) { _, current ->
            (current ?: LockEntry()).also { it.users.incrementAndGet() }
        })
        return try {
            entry.lock.withLock(block)
        } finally {
            locks.computeIfPresent(deliveryId) { _, current ->
                if (current.users.decrementAndGet() == 0) null else current
            }
        }
    }
}

internal class RecentDeliveryIds(private val maximumSize: Int) : DeliveryIdStore {
    private val values = Collections.synchronizedMap(object : LinkedHashMap<String, Boolean>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean = size > maximumSize
    })

    override fun contains(id: String): Boolean = values.containsKey(id)
    override fun add(id: String) { values[id] = true }
}

internal class FileDeliveryIdStore(
    private val path: Path,
    private val maximumSize: Int
) : DeliveryIdStore {
    private val memory = RecentDeliveryIds(maximumSize)
    private val lock = Any()

    init {
        require(maximumSize > 0)
        path.parent?.let(Files::createDirectories)
        if (Files.exists(path)) {
            Files.readAllLines(path, StandardCharsets.UTF_8).takeLast(maximumSize).forEach(memory::add)
        }
    }

    override fun contains(id: String): Boolean = synchronized(lock) { memory.contains(id) }

    override fun add(id: String) = synchronized(lock) {
        if (!memory.contains(id)) {
            Files.writeString(
                path,
                "$id\n",
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.APPEND
            )
            memory.add(id)
        }
    }
}
