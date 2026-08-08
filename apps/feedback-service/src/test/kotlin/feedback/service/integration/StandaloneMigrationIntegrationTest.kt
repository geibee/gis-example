package feedback.service.integration

import feedback.service.DatabaseSettings
import feedback.service.FeedbackApiException
import feedback.service.FeedbackDatabase
import feedback.service.resolveWorkspaceScope
import feedback.service.*
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.io.TempDir
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.file.Path
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import java.time.Instant
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.header
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@Tag("integration")
class StandaloneMigrationIntegrationTest {
    private lateinit var database: FeedbackDatabase

    @TempDir
    lateinit var temporaryDirectory: Path

    @BeforeTest
    fun setUp() {
        val settings = DatabaseSettings(
            url = required("FEEDBACK_DATABASE_URL"),
            user = required("FEEDBACK_DATABASE_USER"),
            password = required("FEEDBACK_DATABASE_PASSWORD"),
            poolSize = 3,
            connectionTimeoutMillis = 5000,
            statementTimeoutMillis = 30000
        )
        database = FeedbackDatabase.create(settings)
        database.dataSource.connection.use { connection ->
            connection.createStatement().use { it.execute("DROP SCHEMA IF EXISTS feedback CASCADE") }
        }
        database.migrate()
    }

    @AfterTest
    fun tearDown() {
        database.close()
    }

    @Test
    fun `空の通常 PostgreSQL へ全 migration を適用して再適用できる`() {
        database.migrate()
        database.dataSource.connection.use { connection ->
            val extensions = connection.prepareStatement("SELECT extname FROM pg_extension").use { statement ->
                statement.executeQuery().use { result -> buildSet { while (result.next()) add(result.getString(1)) } }
            }
            assertFalse("postgis" in extensions)
            val schemas = connection.prepareStatement(
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('feedback', 'app', 'gis_data')"
            ).use { statement ->
                statement.executeQuery().use { result -> buildSet { while (result.next()) add(result.getString(1)) } }
            }
            assertEquals(setOf("feedback"), schemas)
        }
    }

    @Test
    fun `workspace membership は tenant と application をまたいで解決されない`() {
        val fixture = seedMembershipFixture()
        val own = database.resolveWorkspaceScope(fixture.userId, "consumer", "workspace-a", "prod")
        assertEquals(fixture.workspaceA, own.workspaceId)
        assertFailsWith<FeedbackApiException> {
            database.resolveWorkspaceScope(fixture.userId, "consumer-b", "workspace-b", "prod")
        }
    }

    @Test
    fun `session thread message evidence の保証を専用 DB で維持する`() {
        val input = BootstrapInput(
            tenantKey = "tenant-flow",
            tenantDisplayName = "Tenant Flow",
            applicationKey = "flow-app",
            applicationDisplayName = "Flow App",
            environmentKey = "prod",
            environmentBaseUrl = "https://flow.example",
            allowedOrigins = listOf("https://flow.example"),
            externalWorkspaceKey = "workspace-flow",
            workspaceDisplayName = "Workspace Flow",
            issuer = "https://issuer.example",
            subject = "flow-user",
            email = "flow@example.invalid",
            displayName = "Flow User",
            permissions = FeedbackPermission.entries.toSet()
        )
        database.bootstrap(input)
        val principal = database.resolvePrincipal(input.issuer, input.subject, input.email, input.displayName)
        val scope = database.resolveWorkspaceScope(
            principal.userId,
            input.applicationKey,
            input.externalWorkspaceKey,
            input.environmentKey
        )
        val applicationScope = database.resolveApplicationScope(principal.userId, input.applicationKey)
        val manifest = buildJsonObject {
            put("schemaVersion", "1")
            put("applicationKey", input.applicationKey)
            put("displayName", input.applicationDisplayName)
            put("manifestVersion", "v1")
            put("routes", buildJsonArray {
                add(buildJsonObject {
                    put("pageKey", "orders.detail")
                    put("template", "/orders/{orderId}")
                    put("label", "注文詳細")
                    put("parameters", buildJsonObject {
                        put("orderId", buildJsonObject { put("persistence", "store") })
                    })
                })
            })
        }
        database.putManifest(applicationScope, principal, validateManifest(input.applicationKey, manifest), null)
        val sessionRequest = FeedbackSessionCreateRequest(
            applicationKey = input.applicationKey,
            environmentKey = input.environmentKey,
            externalWorkspaceKey = input.externalWorkspaceKey,
            manifestVersion = "v1",
            title = "Flow Session",
            scopes = listOf(SessionScope("orders.detail", "/orders/{orderId}", true)),
            perspectives = listOf(SessionPerspective("usability", "使いやすさ", "active"))
        )
        val sessionElement = serviceJson.encodeToJsonElement(FeedbackSessionCreateRequest.serializer(), sessionRequest)
        val draft = database.createSession(
            scope,
            principal,
            sessionRequest,
            "session-key-00001",
            requestHash(sessionElement)
        )
        val open = database.patchSession(draft.id, draft.version, buildJsonObject { put("status", "open") })
        val secondDraft = database.createSession(
            scope,
            principal,
            sessionRequest.copy(title = "Conflicting Session"),
            "session-key-00002",
            requestHash(
                serviceJson.encodeToJsonElement(
                    FeedbackSessionCreateRequest.serializer(),
                    sessionRequest.copy(title = "Conflicting Session")
                )
            )
        )
        assertFailsWith<FeedbackApiException> {
            database.patchSession(secondDraft.id, secondDraft.version, buildJsonObject { put("status", "open") })
        }

        val png = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0)
        val threadRequest = FeedbackThreadCreateRequest(
            location = buildJsonObject {
                put("schemaVersion", "1")
                put("pageKey", "orders.detail")
                put("routeTemplate", "/orders/{orderId}")
                put("pathParameters", buildJsonObject { put("orderId", "ORDER-1") })
            },
            target = buildJsonObject {
                put("schemaVersion", "1")
                put("kind", "screen-position")
                put("relativeX", 0.25)
                put("relativeY", 0.75)
            },
            perspectiveCode = "usability",
            body = "最初のコメント",
            evidence = EvidenceCreateRequest(
                contentType = "image/png",
                dataBase64 = java.util.Base64.getEncoder().encodeToString(png),
                viewportWidth = 100,
                viewportHeight = 100,
                pixelRatio = 1.0,
                capturedAt = "2026-08-09T00:00:00Z"
            )
        )
        val threadElement = serviceJson.encodeToJsonElement(FeedbackThreadCreateRequest.serializer(), threadRequest)
        LocalEvidenceStorage(temporaryDirectory).use { storage ->
            val created = database.createThread(
                scope,
                open.id,
                principal,
                threadRequest,
                "thread-key-000001",
                requestHash(threadElement),
                storage,
                "evidence/",
                1024
            )
            val replayed = database.createThread(
                scope,
                open.id,
                principal,
                threadRequest,
                "thread-key-000001",
                requestHash(threadElement),
                storage,
                "evidence/",
                1024
            )
            assertEquals(created.id, replayed.id)
            assertTrue(database.getEvidence(created.id, storage).bytes.contentEquals(png))

            val message = created.messages.single()
            val edited = database.patchMessage(
                message.id,
                principal,
                message.version,
                FeedbackMessagePatchRequest("編集後のコメント")
            )
            assertEquals(2, edited.version)
            assertEquals(listOf(1, 2), database.listMessageVersions(message.id).map { it.version })
            val currentThread = database.getThread(created.id)
            val resolved = database.patchThreadStatus(
                scope,
                created.id,
                principal,
                currentThread.version,
                "resolved"
            )
            assertEquals("resolved", resolved.status)

            val (_, retentionVersion) = database.getRetentionPolicy(scope)
            database.patchRetentionPolicy(scope, retentionVersion, FeedbackRetentionPolicy(evidenceRetentionDays = 1))
            database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "UPDATE feedback.review_evidence SET created_at = now() - interval '2 days' WHERE thread_id = ?::uuid"
                ).use { statement -> statement.setString(1, created.id); statement.executeUpdate() }
            }
            val retentionWorker = RetentionWorker(
                database = database,
                storage = storage,
                evidencePrefix = "evidence/",
                pollMillis = 1000,
                orphanGraceSeconds = 300
            )
            assertEquals(1, retentionWorker.purgeOnce())
            assertFailsWith<FeedbackApiException> { database.getEvidence(created.id, storage) }

            storage.put("evidence/orphan", "image/png", png)
            Files.setLastModifiedTime(
                temporaryDirectory.resolve("evidence/orphan"),
                FileTime.from(Instant.now().minusSeconds(600))
            )
            assertEquals(1, retentionWorker.cleanupOrphans())
            assertFalse(Files.exists(temporaryDirectory.resolve("evidence/orphan")))
        }
        database.dataSource.connection.use { connection ->
            val eventCount = connection.prepareStatement(
                "SELECT count(*) FROM feedback.notification_outbox WHERE workspace_id = ?::uuid"
            ).use { statement ->
                statement.setString(1, scope.workspaceId)
                statement.executeQuery().use { result -> result.next(); result.getInt(1) }
            }
            assertEquals(2, eventCount)
        }
        database.enforceWriteRateLimit(scope, principal, 1)
        val rateLimited = assertFailsWith<FeedbackApiException> {
            database.enforceWriteRateLimit(scope, principal, 1)
        }
        assertEquals(HttpStatusCode.TooManyRequests, rateLimited.status)
    }

    @Test
    fun `実 HTTP は専用 OIDC と Problem Details と manifest 契約を使う`() = testApplication {
        val issuer = "https://issuer-http.example"
        val exchangeIssuer = "https://broker.example"
        val subject = "http-user"
        database.bootstrap(
            BootstrapInput(
                tenantKey = "tenant-http",
                tenantDisplayName = "Tenant HTTP",
                applicationKey = "http-app",
                applicationDisplayName = "HTTP App",
                environmentKey = "prod",
                environmentBaseUrl = "https://http.example",
                allowedOrigins = listOf("https://http.example"),
                externalWorkspaceKey = "workspace-http",
                workspaceDisplayName = "Workspace HTTP",
                issuer = issuer,
                subject = subject,
                email = null,
                displayName = "HTTP User",
                permissions = FeedbackPermission.entries.toSet()
            )
        )
        val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val algorithm = Algorithm.RSA256(keyPair.public as RSAPublicKey, keyPair.private as RSAPrivateKey)
        val token = JWT.create()
            .withIssuer(issuer)
            .withAudience("feedback-service")
            .withSubject(subject)
            .withClaim("name", "HTTP User")
            .withIssuedAt(Date.from(Instant.now()))
            .withExpiresAt(Date.from(Instant.now().plusSeconds(300)))
            .sign(algorithm)
        fun exchangeToken(workspace: String): String = JWT.create()
            .withIssuer(exchangeIssuer)
            .withAudience("feedback-service-exchange")
            .withSubject("exchange-token-id")
            .withIssuedAt(Date.from(Instant.now()))
            .withExpiresAt(Date.from(Instant.now().plusSeconds(120)))
            .withClaim("actor_issuer", issuer)
            .withClaim("actor_sub", subject)
            .withClaim("actor_name", "HTTP User")
            .withClaim("feedback_tenant", "tenant-http")
            .withClaim("feedback_application", "http-app")
            .withClaim("feedback_environment", "prod")
            .withClaim("feedback_workspace", workspace)
            .withArrayClaim("feedback_permissions", arrayOf("feedback.read", "feedback.manage"))
            .sign(algorithm)
        application {
            module(
                ServiceSettings(
                    port = 0,
                    evidenceMaxBytes = 1024,
                    writeRateLimitPerMinute = 120,
                    database = DatabaseSettings(
                        url = required("FEEDBACK_DATABASE_URL"),
                        user = required("FEEDBACK_DATABASE_USER"),
                        password = required("FEEDBACK_DATABASE_PASSWORD"),
                        poolSize = 3,
                        connectionTimeoutMillis = 5000,
                        statementTimeoutMillis = 30000
                    ),
                    oidc = OidcSettings(
                        issuer = issuer,
                        subjectClaim = "sub",
                        displayNameClaim = "name",
                        emailClaim = "email"
                    ) { verifier(JWT.require(algorithm).withIssuer(issuer).withAudience("feedback-service").build()) },
                    tokenExchange = TokenExchangeSettings(
                        issuer = exchangeIssuer,
                        actorIssuers = setOf(issuer),
                        maxLifetimeSeconds = 300
                    ) {
                        verifier(
                            JWT.require(algorithm)
                                .withIssuer(exchangeIssuer)
                                .withAudience("feedback-service-exchange")
                                .build()
                        )
                    },
                    notificationCipher = NotificationCipher(ByteArray(32) { 1 }),
                    evidenceStorage = EvidenceStorageSettings(
                        mode = "local",
                        localDirectory = temporaryDirectory,
                        bucket = null,
                        region = null,
                        endpointUrl = null,
                        keyPrefix = "evidence/"
                    )
                )
            )
        }

        val unauthorized = client.get("/feedback/v1/me")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
        assertTrue(unauthorized.headers[HttpHeaders.ContentType]?.startsWith("application/problem+json") == true)

        val capabilities = client.get("/feedback/v1/capabilities")
        assertEquals(HttpStatusCode.OK, capabilities.status)
        assertTrue(capabilities.bodyAsText().contains("\"apiVersion\":\"1.0\""))

        val manifestBody = """
            {
              "schemaVersion":"1",
              "applicationKey":"http-app",
              "displayName":"HTTP App",
              "manifestVersion":"v1",
              "routes":[{"pageKey":"home","template":"/","label":"ホーム"}]
            }
        """.trimIndent()
        val response = client.put("/feedback/v1/applications/http-app/manifest") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(manifestBody)
        }
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        assertEquals("\"v1\"", response.headers[HttpHeaders.ETag])
        assertTrue(response.bodyAsText().contains("\"applicationKey\":\"http-app\""))

        val exchangeAuthorized = client.get(
            "/feedback/v1/retention-policy?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer ${exchangeToken("workspace-http")}")
        }
        assertEquals(HttpStatusCode.OK, exchangeAuthorized.status, exchangeAuthorized.bodyAsText())

        val exchangeScopeDenied = client.get(
            "/feedback/v1/retention-policy?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer ${exchangeToken("other-workspace")}")
        }
        assertEquals(HttpStatusCode.Forbidden, exchangeScopeDenied.status)
    }

    private fun seedMembershipFixture(): Fixture {
        val tenantA = UUID.randomUUID().toString()
        val tenantB = UUID.randomUUID().toString()
        val appA = UUID.randomUUID().toString()
        val appB = UUID.randomUUID().toString()
        val envA = UUID.randomUUID().toString()
        val envB = UUID.randomUUID().toString()
        val workspaceA = UUID.randomUUID().toString()
        val workspaceB = UUID.randomUUID().toString()
        val userId = UUID.randomUUID().toString()
        database.transaction { connection ->
            connection.prepareStatement(
                "INSERT INTO feedback.tenants (id, tenant_key, display_name) VALUES (?::uuid, ?, ?)"
            ).use { statement ->
                listOf(Triple(tenantA, "tenant-a", "Tenant A"), Triple(tenantB, "tenant-b", "Tenant B")).forEach {
                    statement.setString(1, it.first); statement.setString(2, it.second); statement.setString(3, it.third); statement.addBatch()
                }
                statement.executeBatch()
            }
            connection.prepareStatement(
                "INSERT INTO feedback.applications (id, tenant_id, application_key, display_name) VALUES (?::uuid, ?::uuid, ?, ?)"
            ).use { statement ->
                listOf(
                    arrayOf(appA, tenantA, "consumer", "Consumer A"),
                    arrayOf(appB, tenantB, "consumer-b", "Consumer B")
                ).forEach { values ->
                    values.forEachIndexed { index, value -> statement.setString(index + 1, value) }
                    statement.addBatch()
                }
                statement.executeBatch()
            }
            connection.prepareStatement(
                "INSERT INTO feedback.application_environments (id, application_id, environment_key, base_url) VALUES (?::uuid, ?::uuid, 'prod', ?)"
            ).use { statement ->
                listOf(Triple(envA, appA, "https://a.example"), Triple(envB, appB, "https://b.example")).forEach {
                    statement.setString(1, it.first); statement.setString(2, it.second); statement.setString(3, it.third); statement.addBatch()
                }
                statement.executeBatch()
            }
            connection.prepareStatement(
                "INSERT INTO feedback.workspaces (id, tenant_id, application_id, external_workspace_key, display_name) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?)"
            ).use { statement ->
                listOf(
                    arrayOf(workspaceA, tenantA, appA, "workspace-a", "Workspace A"),
                    arrayOf(workspaceB, tenantB, appB, "workspace-b", "Workspace B")
                ).forEach { values ->
                    values.forEachIndexed { index, value -> statement.setString(index + 1, value) }
                    statement.addBatch()
                }
                statement.executeBatch()
            }
            connection.prepareStatement(
                "INSERT INTO feedback.users (id, issuer, subject) VALUES (?::uuid, 'https://issuer.example', 'subject-a')"
            ).use { statement -> statement.setString(1, userId); statement.executeUpdate() }
            connection.prepareStatement(
                "INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions) VALUES (?::uuid, ?::uuid, ARRAY['feedback.read'])"
            ).use { statement -> statement.setString(1, workspaceA); statement.setString(2, userId); statement.executeUpdate() }
        }
        return Fixture(userId, workspaceA)
    }

    private fun required(name: String): String = System.getenv(name) ?: error("$name が必要です")

    private data class Fixture(val userId: String, val workspaceA: String)
}
