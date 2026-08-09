package feedback.service

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.callid.CallId
import io.ktor.server.plugins.callid.callId
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import kotlinx.serialization.SerializationException
import org.slf4j.event.Level
import java.util.UUID

fun main() {
    val settings = ServiceSettings.fromEnv()
    embeddedServer(Netty, port = settings.port) {
        module(settings)
    }.start(wait = true)
}

fun Application.module(settings: ServiceSettings = ServiceSettings.fromEnv()) {
    val applicationLog = environment.log
    val database = FeedbackDatabase.create(settings.database)
    database.migrate()
    val evidenceStorage = createEvidenceStorage(settings.evidenceStorage)
    val exportStorage = LocalEvidenceStorage(settings.exportStorage.localDirectory)
    val metrics = FeedbackServiceMetrics(database)
    environment.monitor.subscribe(io.ktor.server.application.ApplicationStopped) {
        evidenceStorage.close()
        exportStorage.close()
        database.close()
    }

    install(CallId) {
        retrieveFromHeader(HttpHeaders.XRequestId)
        verify { it.length in 1..200 && it.all { character -> character.isLetterOrDigit() || character in "-_.:" } }
        generate { UUID.randomUUID().toString() }
        replyToHeader(HttpHeaders.XRequestId)
    }
    install(CallLogging) {
        level = Level.INFO
        filter { !it.request.path().startsWith("/health/") }
        mdc("requestId") { it.callId }
        mdc("tenant") { it.attributes.getOrNull(auditTenantKey) }
        mdc("application") { it.attributes.getOrNull(auditApplicationKey) }
        mdc("environment") { it.attributes.getOrNull(auditEnvironmentKey) }
        mdc("workspace") { it.attributes.getOrNull(auditWorkspaceKey) }
    }
    intercept(ApplicationCallPipeline.Monitoring) {
        val startedAt = System.nanoTime()
        try {
            proceed()
        } finally {
            if (!call.request.path().startsWith("/metrics")) {
                metrics.recordRequest(System.nanoTime() - startedAt, call.response.status()?.value ?: 500)
            }
        }
    }
    install(ContentNegotiation) { json(serviceJson) }
    install(StatusPages) {
        exception<FeedbackApiException> { call, exception ->
            if (exception.status == HttpStatusCode.TooManyRequests) {
                call.response.headers.append(HttpHeaders.RetryAfter, "60")
            }
            call.respondProblem(
                exception.status,
                FeedbackProblem(
                    type = "/problems/${exception.code}",
                    title = exception.status.description,
                    status = exception.status.value,
                    detail = exception.message,
                    code = exception.code,
                    requestId = call.callId ?: "unknown"
                )
            )
        }
        exception<SerializationException> { call, exception ->
            call.respondProblem(
                HttpStatusCode.BadRequest,
                FeedbackProblem(
                    type = "/problems/request.invalid-json",
                    title = "Bad Request",
                    status = 400,
                    detail = exception.message,
                    code = "request.invalid_json",
                    requestId = call.callId ?: "unknown"
                )
            )
        }
        exception<BadRequestException> { call, exception ->
            call.respondProblem(
                HttpStatusCode.BadRequest,
                FeedbackProblem(
                    type = "/problems/request.invalid-json",
                    title = "Bad Request",
                    status = 400,
                    detail = exception.message,
                    code = "request.invalid_json",
                    requestId = call.callId ?: "unknown"
                )
            )
        }
        exception<IllegalArgumentException> { call, exception ->
            call.respondProblem(
                HttpStatusCode.BadRequest,
                FeedbackProblem(
                    type = "/problems/request.invalid",
                    title = "Bad Request",
                    status = 400,
                    detail = exception.message,
                    code = "request.invalid",
                    requestId = call.callId ?: "unknown"
                )
            )
        }
        exception<Throwable> { call, exception ->
            applicationLog.error("Feedback Service request failed", exception)
            call.respondProblem(
                HttpStatusCode.InternalServerError,
                FeedbackProblem(
                    type = "/problems/internal-error",
                    title = "Internal Server Error",
                    status = 500,
                    code = "internal.error",
                    requestId = call.callId ?: "unknown"
                )
            )
        }
    }
    installEnvironmentCors(database)
    installFeedbackAuthentication(database, settings.oidc, settings.tokenExchange)
    routing {
        healthRoutes(database, evidenceStorage, settings.evidenceStorage.keyPrefix, metrics)
        feedbackRoutes(
            FeedbackDependencies(
                database = database,
                evidenceStorage = evidenceStorage,
                evidenceMaxBytes = settings.evidenceMaxBytes,
                evidenceMaxCountPerWorkspace = settings.evidenceMaxCountPerWorkspace,
                evidenceKeyPrefix = settings.evidenceStorage.keyPrefix,
                writeRateLimitPerMinute = settings.writeRateLimitPerMinute,
                writeRateLimitPerTenantPerMinute = settings.writeRateLimitPerTenantPerMinute,
                writeRateLimitPerIpPerMinute = settings.writeRateLimitPerIpPerMinute,
                notificationCipher = settings.notificationCipher,
                exportStorage = exportStorage
            )
        )
    }
}
