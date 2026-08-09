package feedback.service

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.Principal
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.auth.principal
import io.ktor.server.plugins.callid.callId
import io.ktor.server.response.respond

internal const val FEEDBACK_AUTH_NAME = "feedback-oidc"
internal const val FEEDBACK_EXCHANGE_AUTH_NAME = "feedback-token-exchange"

data class FeedbackTokenScope(
    val tenantKey: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val permissions: Set<FeedbackPermission>
)

data class FeedbackPrincipal(
    val userId: String,
    val issuer: String,
    val subject: String,
    val email: String?,
    val displayName: String?,
    val tokenScope: FeedbackTokenScope? = null
) : Principal {
    fun participant(participantName: String? = null): Participant = Participant(
        principalId = subject,
        displayName = displayName,
        participantName = participantName
    )
}

fun Application.installFeedbackAuthentication(
    db: FeedbackDatabase,
    settings: OidcSettings,
    tokenExchangeSettings: TokenExchangeSettings?
) {
    install(Authentication) {
        jwt(FEEDBACK_AUTH_NAME) {
            realm = "feedback-service"
            settings.configureVerification(this)
            validate { credential ->
                val subject = if (settings.subjectClaim == "sub") {
                    credential.payload.subject
                } else {
                    credential.payload.getClaim(settings.subjectClaim).asString()
                }?.takeIf { it.isNotBlank() } ?: return@validate null
                db.resolvePrincipal(
                    issuer = settings.issuer,
                    subject = subject,
                    email = credential.payload.getClaim(settings.emailClaim).asString(),
                    displayName = credential.payload.getClaim(settings.displayNameClaim).asString()
                )
            }
            challenge { _, _ ->
                val requestId = call.callId ?: "unknown"
                db.recordAudit(
                    scope = null,
                    principalId = null,
                    action = "authenticate",
                    resourceType = null,
                    resourceId = null,
                    outcome = "denied",
                    requestId = requestId,
                    changes = null
                )
                call.respondProblem(
                    HttpStatusCode.Unauthorized,
                    FeedbackProblem(
                        type = "/problems/authentication-required",
                        title = "認証が必要です",
                        status = 401,
                        code = "auth.required",
                        requestId = requestId
                    )
                )
            }
        }
        jwt(FEEDBACK_EXCHANGE_AUTH_NAME) {
            realm = "feedback-service-token-exchange"
            (tokenExchangeSettings?.configureVerification ?: settings.configureVerification)(this)
            validate { credential ->
                val exchange = tokenExchangeSettings ?: return@validate null
                val issuedAt = credential.payload.issuedAt?.toInstant() ?: return@validate null
                val expiresAt = credential.payload.expiresAt?.toInstant() ?: return@validate null
                val lifetime = java.time.Duration.between(issuedAt, expiresAt).seconds
                if (lifetime !in 1..exchange.maxLifetimeSeconds || issuedAt.isAfter(java.time.Instant.now().plusSeconds(30))) {
                    return@validate null
                }
                val actorIssuer = credential.payload.getClaim("actor_issuer").asString()
                    ?.trimEnd('/')?.takeIf { it in exchange.actorIssuers } ?: return@validate null
                val actorSubject = credential.payload.getClaim("actor_sub").asString()
                    ?.takeIf { it.isNotBlank() } ?: return@validate null
                val permissions = runCatching {
                    credential.payload.getClaim("feedback_permissions").asList(String::class.java)
                        .map { value -> FeedbackPermission.entries.firstOrNull { it.wireValue == value } ?: return@validate null }
                        .toSet()
                }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return@validate null
                val tokenScope = FeedbackTokenScope(
                    tenantKey = credential.requiredStringClaim("feedback_tenant") ?: return@validate null,
                    applicationKey = credential.requiredStringClaim("feedback_application") ?: return@validate null,
                    environmentKey = credential.requiredStringClaim("feedback_environment") ?: return@validate null,
                    externalWorkspaceKey = credential.requiredStringClaim("feedback_workspace") ?: return@validate null,
                    permissions = permissions
                )
                db.resolvePrincipal(
                    issuer = actorIssuer,
                    subject = actorSubject,
                    email = credential.payload.getClaim("actor_email").asString(),
                    displayName = credential.payload.getClaim("actor_name").asString()
                ).copy(tokenScope = tokenScope)
            }
        }
    }
}

private fun io.ktor.server.auth.jwt.JWTCredential.requiredStringClaim(name: String): String? =
    payload.getClaim(name).asString()?.takeIf { it.isNotBlank() }

internal fun ApplicationCall.feedbackPrincipal(): FeedbackPrincipal =
    principal<FeedbackPrincipal>()
        ?: throw FeedbackApiException(HttpStatusCode.Unauthorized, "auth.required", "認証が必要です")
