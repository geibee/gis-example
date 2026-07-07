package gis.example.integration

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import gis.example.Database
import gis.example.OidcSettings
import gis.example.module
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.sql.Connection
import java.sql.DriverManager
import java.util.Date
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.fail

// OIDC JWT 認証 (署名・issuer・audience・期限の検証、app.users への JIT プロビジョニング、
// is_active による無効化) を HTTP 層まで通して検証する。
// 本物の IdP の代わりにテスト用 RSA 鍵で署名し、その公開鍵の verifier を module へ注入する
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuthIntegrationTest {

    private val issuer = "https://test-idp.example/realms/gis"
    private val audience = "gis-api"
    private val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val publicKey = keyPair.public as RSAPublicKey
    private val privateKey = keyPair.private as RSAPrivateKey

    private fun rawConnection(): Connection {
        val url = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
        val user = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
        val password = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"
        return DriverManager.getConnection(url, user, password)
    }

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    @BeforeAll
    fun setUpSchema() {
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
                stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
            }
            connection.createStatement().use { stmt ->
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
        }
    }

    private fun settings(adminEmails: Set<String> = setOf("admin@gis.example")) =
        OidcSettings(adminEmails = adminEmails) {
            verifier(
                JWT.require(Algorithm.RSA256(publicKey, null))
                    .withIssuer(issuer)
                    .withAudience(audience)
                    .build()
            )
        }

    private fun token(
        subject: String,
        email: String? = null,
        name: String? = null,
        tokenIssuer: String = issuer,
        tokenAudience: String = audience,
        expiresInSeconds: Long = 600
    ): String {
        val builder = JWT.create()
            .withIssuer(tokenIssuer)
            .withAudience(tokenAudience)
            .withSubject(subject)
            .withExpiresAt(Date(System.currentTimeMillis() + expiresInSeconds * 1000))
        if (email != null) builder.withClaim("email", email)
        if (name != null) builder.withClaim("name", name)
        return builder.sign(Algorithm.RSA256(null, privateKey))
    }

    private fun withApp(block: suspend (io.ktor.client.HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = settings()) }
        block(client)
    }

    private fun selectUserRow(subject: String): Pair<String, Boolean>? =
        rawConnection().use { connection ->
            connection.prepareStatement(
                "SELECT system_role, is_active FROM app.users WHERE subject = ?"
            ).use { stmt ->
                stmt.setString(1, subject)
                stmt.executeQuery().use { rs ->
                    if (rs.next()) rs.getString(1) to rs.getBoolean(2) else null
                }
            }
        }

    @Test
    fun `トークンなしは 401 になり health は 200 のまま`() = withApp { client ->
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/projects").status)
        assertEquals(HttpStatusCode.OK, client.get("/health").status)
    }

    @Test
    fun `有効なトークンで 200 になり users へ JIT 登録される`() = withApp { client ->
        val response = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${token("sub-jit", email = "user@gis.example", name = "一般ユーザー")}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("user" to true, selectUserRow("sub-jit"), "JIT 登録は user ロール")
    }

    @Test
    fun `AUTH_ADMIN_EMAILS に載る email は admin で登録される`() = withApp { client ->
        val response = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${token("sub-admin", email = "admin@gis.example")}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("admin" to true, selectUserRow("sub-admin"))
    }

    @Test
    fun `issuer か audience が不一致のトークンは 401`() = withApp { client ->
        val wrongAudience = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${token("sub-1", tokenAudience = "other-api")}")
        }
        assertEquals(HttpStatusCode.Unauthorized, wrongAudience.status)

        val wrongIssuer = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${token("sub-1", tokenIssuer = "https://evil.example")}")
        }
        assertEquals(HttpStatusCode.Unauthorized, wrongIssuer.status)
    }

    @Test
    fun `期限切れトークンは 401`() = withApp { client ->
        val response = client.get("/api/projects") {
            header(HttpHeaders.Authorization, "Bearer ${token("sub-1", expiresInSeconds = -60)}")
        }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `無効化されたユーザーは有効なトークンでも 401`() = withApp { client ->
        val subject = "sub-deactivated"
        val bearer = "Bearer ${token(subject)}"
        assertEquals(
            HttpStatusCode.OK,
            client.get("/api/projects") { header(HttpHeaders.Authorization, bearer) }.status
        )
        rawConnection().use { connection ->
            connection.prepareStatement("UPDATE app.users SET is_active = false WHERE subject = ?").use { stmt ->
                stmt.setString(1, subject)
                stmt.executeUpdate()
            }
        }
        assertEquals(
            HttpStatusCode.Unauthorized,
            client.get("/api/projects") { header(HttpHeaders.Authorization, bearer) }.status
        )
    }
}
