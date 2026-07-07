package gis.example.integration

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import gis.example.OidcSettings
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date

// 統合テスト用の OIDC 代替。本物の IdP の代わりにローカル生成した RSA 鍵で
// トークンへ署名し、その公開鍵の verifier を module へ注入する
object OidcTestSupport {
    const val ISSUER = "https://test-idp.example/realms/gis"
    const val AUDIENCE = "gis-api"

    private val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val publicKey = keyPair.public as RSAPublicKey
    private val privateKey = keyPair.private as RSAPrivateKey

    fun settings(adminEmails: Set<String> = emptySet()): OidcSettings =
        OidcSettings(adminEmails = adminEmails) {
            verifier(
                JWT.require(Algorithm.RSA256(publicKey, null))
                    .withIssuer(ISSUER)
                    .withAudience(AUDIENCE)
                    .build()
            )
        }

    fun token(
        subject: String,
        email: String? = null,
        name: String? = null,
        issuer: String = ISSUER,
        audience: String = AUDIENCE,
        expiresInSeconds: Long = 600
    ): String {
        val builder = JWT.create()
            .withIssuer(issuer)
            .withAudience(audience)
            .withSubject(subject)
            .withExpiresAt(Date(System.currentTimeMillis() + expiresInSeconds * 1000))
        if (email != null) builder.withClaim("email", email)
        if (name != null) builder.withClaim("name", name)
        return builder.sign(Algorithm.RSA256(null, privateKey))
    }
}
