// OIDC JWT 認証: JWKS による署名検証と app.users への突合 (JIT プロビジョニング)。
// ここは「誰か」を確立するまでを担い、「何をできるか」の判定は Authorization (PDP) が担う
package gis.example

import com.auth0.jwk.JwkProviderBuilder
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.Principal
import io.ktor.server.auth.jwt.JWTAuthenticationProvider
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.response.respond
import java.net.URI
import java.util.concurrent.TimeUnit

internal const val OIDC_AUTH_NAME = "oidc"

enum class SystemRole { ADMIN, USER }

// 認証済みユーザー。認可判定 (PDP) への principal になる。
// memberships は projectId → ロール (system admin は空でも全プロジェクトへ許可される)
data class AppPrincipal(
    val userId: String,
    val subject: String,
    val email: String?,
    val displayName: String?,
    val systemRole: SystemRole,
    val memberships: Map<String, ProjectRole>
) : Principal

// OIDC の検証設定。verifier の構築を差し替え可能にして、
// テストではローカル生成した RSA 鍵で署名したトークンを検証できるようにする
class OidcSettings(
    val adminEmails: Set<String>,
    val configureVerification: JWTAuthenticationProvider.Config.() -> Unit
) {
    companion object {
        fun fromEnv(): OidcSettings {
            val issuer = System.getenv("OIDC_ISSUER")?.trimEnd('/')
                ?: error("OIDC_ISSUER が未設定です (例: http://localhost:8081/realms/gis)")
            val audience = System.getenv("OIDC_AUDIENCE")
                ?: error("OIDC_AUDIENCE が未設定です (例: gis-api)")
            // 既定は Keycloak の JWKS パス。他の IdP を使う場合は OIDC_JWKS_URL で明示する。
            // 鍵は初回検証時に遅延取得されるため、起動時に IdP が上がっている必要はない
            val jwksUrl = System.getenv("OIDC_JWKS_URL") ?: "$issuer/protocol/openid-connect/certs"
            val jwkProvider = JwkProviderBuilder(URI(jwksUrl).toURL())
                .cached(10, 24, TimeUnit.HOURS)
                .rateLimited(10, 1, TimeUnit.MINUTES)
                .build()
            return OidcSettings(adminEmails = parseAdminEmails(System.getenv("AUTH_ADMIN_EMAILS"))) {
                verifier(jwkProvider, issuer) {
                    withAudience(audience)
                }
            }
        }

        internal fun parseAdminEmails(value: String?): Set<String> =
            (value ?: "").split(',')
                .map { it.trim().lowercase() }
                .filter { it.isNotEmpty() }
                .toSet()
    }
}

fun Application.installOidcAuthentication(db: Database, settings: OidcSettings) {
    install(Authentication) {
        jwt(OIDC_AUTH_NAME) {
            realm = "gis-api"
            settings.configureVerification(this)
            validate { credential ->
                val subject = credential.payload.subject?.takeIf { it.isNotBlank() }
                    ?: return@validate null
                db.resolveUser(
                    subject = subject,
                    email = credential.payload.getClaim("email").asString(),
                    displayName = credential.payload.getClaim("name").asString()
                        ?: credential.payload.getClaim("preferred_username").asString(),
                    adminEmails = settings.adminEmails
                )
            }
            challenge { _, _ ->
                call.respond(HttpStatusCode.Unauthorized, ErrorResponse("Authentication required"))
            }
        }
    }
}
