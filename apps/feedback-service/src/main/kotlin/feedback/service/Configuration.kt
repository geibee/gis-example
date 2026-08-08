package feedback.service

import com.auth0.jwk.JwkProviderBuilder
import io.ktor.server.auth.jwt.JWTAuthenticationProvider
import java.net.URI
import java.nio.file.Path
import java.util.concurrent.TimeUnit

data class DatabaseSettings(
    val url: String,
    val user: String,
    val password: String,
    val poolSize: Int,
    val connectionTimeoutMillis: Long,
    val statementTimeoutMillis: Long
) {
    companion object {
        fun fromEnv(): DatabaseSettings {
            val password = System.getenv("FEEDBACK_DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD")
                ?: error("FEEDBACK_DATABASE_PASSWORD (または PGPASSWORD) が未設定です")
            return DatabaseSettings(
                url = System.getenv("FEEDBACK_DATABASE_URL")
                    ?: "jdbc:postgresql://localhost:5432/feedback",
                user = System.getenv("FEEDBACK_DATABASE_USER") ?: System.getenv("PGUSER") ?: "feedback",
                password = password,
                poolSize = (System.getenv("FEEDBACK_DATABASE_POOL_SIZE") ?: "10").toInt(),
                connectionTimeoutMillis =
                    (System.getenv("FEEDBACK_DATABASE_CONNECTION_TIMEOUT_MS") ?: "10000").toLong(),
                statementTimeoutMillis =
                    (System.getenv("FEEDBACK_DATABASE_STATEMENT_TIMEOUT_MS") ?: "30000").toLong()
            )
        }
    }
}

data class OidcSettings(
    val issuer: String,
    val subjectClaim: String,
    val displayNameClaim: String,
    val emailClaim: String,
    val configureVerification: JWTAuthenticationProvider.Config.() -> Unit
) {
    companion object {
        fun fromEnv(): OidcSettings {
            val allowInsecureHttp = System.getenv("FEEDBACK_ALLOW_INSECURE_HTTP") == "1"
            val issuer = validateSecureEndpoint(
                requiredEnv("FEEDBACK_OIDC_ISSUER").trimEnd('/'),
                "FEEDBACK_OIDC_ISSUER",
                allowInsecureHttp
            )
            val audience = requiredEnv("FEEDBACK_OIDC_AUDIENCE")
            val jwksUrl = System.getenv("FEEDBACK_OIDC_JWKS_URL")
                ?: "$issuer/.well-known/jwks.json"
            validateSecureEndpoint(jwksUrl, "FEEDBACK_OIDC_JWKS_URL", allowInsecureHttp)
            val provider = JwkProviderBuilder(URI(jwksUrl).toURL())
                .cached(10, 24, TimeUnit.HOURS)
                .rateLimited(10, 1, TimeUnit.MINUTES)
                .build()
            return OidcSettings(
                issuer = issuer,
                subjectClaim = System.getenv("FEEDBACK_OIDC_SUBJECT_CLAIM") ?: "sub",
                displayNameClaim = System.getenv("FEEDBACK_OIDC_DISPLAY_NAME_CLAIM") ?: "name",
                emailClaim = System.getenv("FEEDBACK_OIDC_EMAIL_CLAIM") ?: "email"
            ) {
                verifier(provider, issuer) { withAudience(audience) }
            }
        }
    }
}

data class TokenExchangeSettings(
    val issuer: String,
    val actorIssuers: Set<String>,
    val maxLifetimeSeconds: Long,
    val configureVerification: JWTAuthenticationProvider.Config.() -> Unit
) {
    companion object {
        fun fromEnvOrNull(): TokenExchangeSettings? {
            val allowInsecureHttp = System.getenv("FEEDBACK_ALLOW_INSECURE_HTTP") == "1"
            val issuer = System.getenv("FEEDBACK_TOKEN_EXCHANGE_ISSUER")?.takeIf { it.isNotBlank() }
                ?.trimEnd('/')
                ?.let { validateSecureEndpoint(it, "FEEDBACK_TOKEN_EXCHANGE_ISSUER", allowInsecureHttp) }
                ?: return null
            val audience = requiredEnv("FEEDBACK_TOKEN_EXCHANGE_AUDIENCE")
            val jwksUrl = System.getenv("FEEDBACK_TOKEN_EXCHANGE_JWKS_URL")
                ?: "${issuer.trimEnd('/')}/.well-known/jwks.json"
            validateSecureEndpoint(jwksUrl, "FEEDBACK_TOKEN_EXCHANGE_JWKS_URL", allowInsecureHttp)
            val actorIssuers = requiredEnv("FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS")
                .split(',')
                .map { it.trim().trimEnd('/') }
                .filter { it.isNotEmpty() }
                .map { validateSecureEndpoint(it, "FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS", allowInsecureHttp) }
                .toSet()
            require(actorIssuers.isNotEmpty()) { "FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS は 1 件以上必要です" }
            val provider = JwkProviderBuilder(URI(jwksUrl).toURL())
                .cached(10, 24, TimeUnit.HOURS)
                .rateLimited(10, 1, TimeUnit.MINUTES)
                .build()
            return TokenExchangeSettings(
                issuer = issuer.trimEnd('/'),
                actorIssuers = actorIssuers,
                maxLifetimeSeconds = (System.getenv("FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS") ?: "300").toLong()
                    .also { require(it in 30..900) { "token exchange の最大 lifetime は 30..900 秒です" } }
            ) {
                verifier(provider, issuer.trimEnd('/')) { withAudience(audience) }
            }
        }
    }
}

data class EvidenceStorageSettings(
    val mode: String,
    val localDirectory: Path,
    val bucket: String?,
    val region: String?,
    val endpointUrl: String?,
    val keyPrefix: String
) {
    companion object {
        fun fromEnv(): EvidenceStorageSettings {
            val mode = System.getenv("FEEDBACK_EVIDENCE_STORAGE") ?: "local"
            require(mode in setOf("local", "s3")) {
                "FEEDBACK_EVIDENCE_STORAGE は local または s3 を指定してください"
            }
            val bucket = System.getenv("FEEDBACK_S3_BUCKET")
            if (mode == "s3" && bucket.isNullOrBlank()) {
                error("FEEDBACK_EVIDENCE_STORAGE=s3 では FEEDBACK_S3_BUCKET が必須です")
            }
            return EvidenceStorageSettings(
                mode = mode,
                localDirectory = Path.of(System.getenv("FEEDBACK_EVIDENCE_DIR") ?: "/data/evidence"),
                bucket = bucket,
                region = System.getenv("FEEDBACK_S3_REGION"),
                endpointUrl = System.getenv("FEEDBACK_S3_ENDPOINT_URL"),
                keyPrefix = (System.getenv("FEEDBACK_S3_KEY_PREFIX") ?: "evidence/").let {
                    if (it.endsWith('/')) it else "$it/"
                }
            )
        }
    }
}

data class ServiceSettings(
    val port: Int,
    val evidenceMaxBytes: Long,
    val writeRateLimitPerMinute: Int,
    val database: DatabaseSettings,
    val oidc: OidcSettings,
    val tokenExchange: TokenExchangeSettings?,
    val notificationCipher: NotificationCipher,
    val evidenceStorage: EvidenceStorageSettings
) {
    companion object {
        fun fromEnv(): ServiceSettings = ServiceSettings(
            port = (System.getenv("FEEDBACK_PORT") ?: "8090").toInt(),
            evidenceMaxBytes = (System.getenv("FEEDBACK_EVIDENCE_MAX_BYTES") ?: "10485760").toLong(),
            writeRateLimitPerMinute = (System.getenv("FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE") ?: "120").toInt()
                .also { require(it in 1..10000) { "FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE は 1..10000 です" } },
            database = DatabaseSettings.fromEnv(),
            oidc = OidcSettings.fromEnv(),
            tokenExchange = TokenExchangeSettings.fromEnvOrNull(),
            notificationCipher = NotificationCipher.fromEnv(),
            evidenceStorage = EvidenceStorageSettings.fromEnv()
        )
    }
}

internal fun requiredEnv(name: String): String =
    System.getenv(name)?.takeIf { it.isNotBlank() } ?: error("$name が未設定です")

private fun validateSecureEndpoint(raw: String, name: String, allowInsecureHttp: Boolean): String {
    val uri = URI(raw)
    val localHttp = uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1")
    require((uri.scheme == "https" || localHttp || (allowInsecureHttp && uri.scheme == "http")) &&
        uri.host != null && uri.userInfo == null && uri.fragment == null) {
        "$name は https URL で指定してください (ローカル開発の HTTP は FEEDBACK_ALLOW_INSECURE_HTTP=1)"
    }
    return raw
}
