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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Path
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import java.time.Instant
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import com.sun.net.httpserver.HttpServer
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.request.put
import io.ktor.client.statement.HttpResponse
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
import kotlin.test.assertContains
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
    fun `Phase3のexport membership notificationをローカルfixtureで完結できる`() {
        val fixture = seedPhase3Fixture()
        val exportRequest = FeedbackExportRequest(
            applicationKey = fixture.input.applicationKey,
            environmentKey = fixture.input.environmentKey,
            externalWorkspaceKey = fixture.input.externalWorkspaceKey,
            sessionId = fixture.sessionId,
            format = "csv"
        )
        val exportElement = serviceJson.encodeToJsonElement(FeedbackExportRequest.serializer(), exportRequest)
        val queued = database.createExport(
            fixture.scope,
            fixture.principal,
            exportRequest,
            "phase3-export-key-0001",
            requestHash(exportElement)
        )
        val evidenceStorage = LocalEvidenceStorage(temporaryDirectory.resolve("evidence"))
        LocalEvidenceStorage(temporaryDirectory.resolve("exports")).use { exportStorage ->
            val worker = ExportWorker(database, exportStorage, "exports/", pollMillis = 100)
            assertTrue(worker.runOnce())
            val completed = database.getExportJob(queued.id)
            assertEquals("completed", completed.status)
            assertEquals("/feedback/v1/exports/${queued.id}/download", completed.downloadUrl)
            val csv = database.getStoredExport(queued.id, exportStorage).bytes.toString(Charsets.UTF_8)
            assertContains(csv, "'=SUM(1,1)")
            assertContains(csv, "https://phase3.example/orders/ORDER-1?feedbackThread=${fixture.threadId}")

            database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "UPDATE feedback.export_jobs SET expires_at = now() - interval '1 second' WHERE id = ?::uuid"
                ).use { statement -> statement.setString(1, queued.id); statement.executeUpdate() }
            }
            val retention = RetentionWorker(
                database = database,
                storage = evidenceStorage,
                exportStorage = exportStorage,
                evidencePrefix = "evidence/",
                pollMillis = 1000,
                orphanGraceSeconds = 300
            )
            assertEquals(1, retention.purgeExpiredExports())
            assertFailsWith<FeedbackApiException> { database.getStoredExport(queued.id, exportStorage) }
        }

        val memberPrincipal = database.resolvePrincipal(
            fixture.input.issuer,
            "phase3-member",
            "member@example.invalid",
            "Phase3 Member"
        )
        val createMember = FeedbackMembershipCreateRequest(
            issuer = fixture.input.issuer,
            subject = memberPrincipal.subject,
            permissions = listOf("feedback.read")
        )
        val createMemberElement = serviceJson.encodeToJsonElement(FeedbackMembershipCreateRequest.serializer(), createMember)
        val member = database.createWorkspaceMember(
            fixture.scope,
            fixture.principal,
            createMember,
            "phase3-membership-key-01",
            requestHash(createMemberElement)
        )
        val updated = database.patchWorkspaceMember(
            fixture.scope,
            member.userId,
            member.version,
            FeedbackMembershipPatchRequest(listOf("feedback.read", "feedback.comment"))
        )
        assertEquals(2, updated.version)
        database.deleteWorkspaceMember(fixture.scope, updated.userId, updated.version)
        val admin = database.listWorkspaceMembers(fixture.scope).single()
        assertFailsWith<FeedbackApiException> {
            database.deleteWorkspaceMember(fixture.scope, admin.userId, admin.version)
        }

        val responses = AtomicInteger()
        val receivedBodies = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/webhook") { exchange ->
            receivedBodies += exchange.requestBody.readAllBytes().toString(Charsets.UTF_8)
            val status = if (responses.incrementAndGet() <= 2) 500 else 204
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        server.start()
        try {
            val cipher = NotificationCipher(ByteArray(32) { 7 })
            val (_, settingsVersion) = database.getNotificationSettings(fixture.scope, cipher)
            database.patchNotificationSettings(
                fixture.scope,
                settingsVersion,
                FeedbackNotificationSettings(
                    webhookEnabled = true,
                    webhookEndpoint = "https://fixture.invalid/webhook",
                    includeBody = false,
                    includeEvidence = true
                ),
                cipher
            )
            val localEndpoint = cipher.encrypt("http://127.0.0.1:${server.address.port}/webhook")
            database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    """
                    UPDATE feedback.notification_settings
                    SET webhook_endpoint_ciphertext = ?, webhook_endpoint_nonce = ?
                    WHERE workspace_id = ?::uuid
                    """.trimIndent()
                ).use { statement ->
                    statement.setBytes(1, localEndpoint.ciphertext)
                    statement.setBytes(2, localEndpoint.nonce)
                    statement.setString(3, fixture.scope.workspaceId)
                    statement.executeUpdate()
                }
            }
            val notificationWorker = NotificationWorker(
                database = database,
                pollMillis = 100,
                maxAttempts = 2,
                notificationCipher = cipher,
                dispatcher = WebhookDispatcher(
                    signingSecret = "phase3-fixture-signing-secret-32chars",
                    allowLocalDestinations = true
                )
            )
            assertTrue(notificationWorker.runOnce())
            makeNotificationsAvailable(fixture.scope)
            assertTrue(notificationWorker.runOnce())
            val failed = database.listNotificationDeliveries(fixture.scope, "failed", 10).single()
            assertEquals(2, failed.attempts.size)
            val retried = database.retryNotificationDelivery(fixture.scope, failed.id)
            assertEquals(1, retried.retryCycle)
            assertTrue(notificationWorker.runOnce())
            val delivered = database.listNotificationDeliveries(fixture.scope, "delivered", 10).single()
            assertEquals(listOf(0, 0, 1), delivered.attempts.map { it.retryCycle })
            assertEquals(listOf(1, 2, 1), delivered.attempts.map { it.attempt })
            receivedBodies.forEach { body ->
                assertFalse(body.contains("=SUM(1,1)"))
                assertContains(body, "\"evidenceUrl\":\"/feedback/v1/threads/${fixture.threadId}/evidence\"")
                assertContains(body, "\"deepLink\":\"https://phase3.example/orders/ORDER-1?feedbackThread=${fixture.threadId}\"")
            }
        } finally {
            server.stop(0)
            evidenceStorage.close()
        }
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
                    ),
                    exportStorage = ExportStorageSettings(
                        localDirectory = temporaryDirectory.resolve("exports"),
                        keyPrefix = "exports/"
                    )
                )
            )
        }

        val unauthorized = client.get("/feedback/v1/me")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
        assertTrue(unauthorized.headers[HttpHeaders.ContentType]?.startsWith("application/problem+json") == true)
        assertConformsTo(unauthorized, "get", "/me", 401)

        val capabilities = client.get("/feedback/v1/capabilities")
        assertEquals(HttpStatusCode.OK, capabilities.status)
        assertTrue(capabilities.bodyAsText().contains("\"apiVersion\":\"1.0\""))
        assertConformsTo(capabilities, "get", "/capabilities", 200)

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
        assertConformsTo(response, "put", "/applications/{applicationKey}/manifest", 200)

        val sessionCreated = client.post("/feedback/v1/sessions") {
            header(HttpHeaders.Authorization, "Bearer $token")
            header("Idempotency-Key", "contract-session-0001")
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "applicationKey":"http-app",
                  "environmentKey":"prod",
                  "externalWorkspaceKey":"workspace-http",
                  "manifestVersion":"v1",
                  "title":"契約テストセッション",
                  "outOfScopePosting":"warn",
                  "scopes":[{"pageKey":"home","routeTemplate":"/","reviewable":true}],
                  "perspectives":[{"code":"usability","label":"使いやすさ","status":"active"}]
                }
                """.trimIndent()
            )
        }
        assertConformsTo(sessionCreated, "post", "/sessions", 201)
        val sessionId = serviceJson.parseToJsonElement(sessionCreated.bodyAsText()).jsonObject
            .getValue("id").jsonPrimitive.content

        val sessionOpened = client.patch("/feedback/v1/sessions/$sessionId") {
            header(HttpHeaders.Authorization, "Bearer $token")
            header(HttpHeaders.IfMatch, requireNotNull(sessionCreated.headers[HttpHeaders.ETag]))
            contentType(ContentType.Application.Json)
            setBody("""{"status":"open"}""")
        }
        assertConformsTo(sessionOpened, "patch", "/sessions/{sessionId}", 200)

        val threadCreated = client.post("/feedback/v1/sessions/$sessionId/threads") {
            header(HttpHeaders.Authorization, "Bearer $token")
            header("Idempotency-Key", "contract-thread-00001")
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "location":{
                    "schemaVersion":"1","pageKey":"home","routeTemplate":"/",
                    "pathParameters":{},"queryParameters":{}
                  },
                  "target":{"schemaVersion":"1","kind":"screen-position","relativeX":0.25,"relativeY":0.75},
                  "perspectiveCode":"usability",
                  "body":"契約テストコメント"
                }
                """.trimIndent()
            )
        }
        assertConformsTo(threadCreated, "post", "/sessions/{sessionId}/threads", 201)
        val threadId = serviceJson.parseToJsonElement(threadCreated.bodyAsText()).jsonObject
            .getValue("id").jsonPrimitive.content

        val threadList = client.get("/feedback/v1/sessions/$sessionId/threads") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertConformsTo(threadList, "get", "/sessions/{sessionId}/threads", 200)

        val deepLink = client.get("/feedback/v1/threads/$threadId/deep-link") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertConformsTo(deepLink, "get", "/threads/{threadId}/deep-link", 200)
        assertContains(deepLink.bodyAsText(), "https://http.example/?feedbackThread=$threadId")

        val exportCreated = client.post("/feedback/v1/exports") {
            header(HttpHeaders.Authorization, "Bearer $token")
            header("Idempotency-Key", "contract-export-00001")
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "applicationKey":"http-app",
                  "environmentKey":"prod",
                  "externalWorkspaceKey":"workspace-http",
                  "sessionId":"$sessionId",
                  "format":"csv",
                  "locale":"ja-JP",
                  "timezone":"Asia/Tokyo"
                }
                """.trimIndent()
            )
        }
        assertConformsTo(exportCreated, "post", "/exports", 202)
        val exportId = serviceJson.parseToJsonElement(exportCreated.bodyAsText()).jsonObject
            .getValue("id").jsonPrimitive.content
        LocalEvidenceStorage(temporaryDirectory.resolve("exports")).use { storage ->
            assertTrue(ExportWorker(database, storage, "exports/", pollMillis = 100).runOnce())
        }
        val exportStatus = client.get("/feedback/v1/exports/$exportId") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertConformsTo(exportStatus, "get", "/exports/{exportId}", 200)
        val exportDownload = client.get("/feedback/v1/exports/$exportId/download") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertEquals(HttpStatusCode.OK, exportDownload.status)
        assertTrue(exportDownload.headers[HttpHeaders.ContentType]?.startsWith("text/csv") == true)

        val memberships = client.get(
            "/feedback/v1/memberships?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertConformsTo(memberships, "get", "/memberships", 200)

        val deliveries = client.get(
            "/feedback/v1/notification-deliveries?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        assertConformsTo(deliveries, "get", "/notification-deliveries", 200)

        val exchangeAuthorized = client.get(
            "/feedback/v1/retention-policy?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer ${exchangeToken("workspace-http")}")
        }
        assertEquals(HttpStatusCode.OK, exchangeAuthorized.status, exchangeAuthorized.bodyAsText())
        assertConformsTo(exchangeAuthorized, "get", "/retention-policy", 200)

        val exchangeScopeDenied = client.get(
            "/feedback/v1/retention-policy?applicationKey=http-app&externalWorkspaceKey=workspace-http"
        ) {
            header(HttpHeaders.Authorization, "Bearer ${exchangeToken("other-workspace")}")
        }
        assertEquals(HttpStatusCode.Forbidden, exchangeScopeDenied.status)
        assertConformsTo(exchangeScopeDenied, "get", "/retention-policy", 403)
    }

    private suspend fun assertConformsTo(response: HttpResponse, method: String, path: String, status: Int) {
        assertEquals(status, response.status.value, "$method $path の status")
        val mediaType = requireNotNull(response.headers[HttpHeaders.ContentType])
            .substringBefore(';')
            .trim()
        val schema = FeedbackOpenApiSpecSupport.responseSchema(method, path, status, mediaType)
        val violations = FeedbackOpenApiSpecSupport.validate(
            serviceJson.parseToJsonElement(response.bodyAsText()),
            schema
        )
        assertTrue(
            violations.isEmpty(),
            "$method $path の $status 応答が専用 OpenAPI schema に適合しません:\n${violations.joinToString("\n")}"
        )
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

    private fun seedPhase3Fixture(): Phase3Fixture {
        val input = BootstrapInput(
            tenantKey = "tenant-phase3",
            tenantDisplayName = "Tenant Phase3",
            applicationKey = "phase3-app",
            applicationDisplayName = "Phase3 App",
            environmentKey = "prod",
            environmentBaseUrl = "https://phase3.example",
            allowedOrigins = listOf("https://phase3.example"),
            externalWorkspaceKey = "workspace-phase3",
            workspaceDisplayName = "Workspace Phase3",
            issuer = "https://phase3-issuer.example",
            subject = "phase3-admin",
            email = "admin@example.invalid",
            displayName = "Phase3 Admin",
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
        database.putManifest(
            database.resolveApplicationScope(principal.userId, input.applicationKey),
            principal,
            validateManifest(input.applicationKey, manifest),
            null
        )
        val sessionRequest = FeedbackSessionCreateRequest(
            applicationKey = input.applicationKey,
            environmentKey = input.environmentKey,
            externalWorkspaceKey = input.externalWorkspaceKey,
            manifestVersion = "v1",
            title = "Phase3 Session",
            scopes = listOf(SessionScope("orders.detail", "/orders/{orderId}", true)),
            perspectives = listOf(SessionPerspective("quality", "品質", "active"))
        )
        val session = database.createSession(
            scope,
            principal,
            sessionRequest,
            "phase3-session-key-01",
            requestHash(serviceJson.encodeToJsonElement(FeedbackSessionCreateRequest.serializer(), sessionRequest))
        )
        val opened = database.patchSession(session.id, session.version, buildJsonObject { put("status", "open") })
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
                put("relativeX", 0.5)
                put("relativeY", 0.5)
            },
            perspectiveCode = "quality",
            body = "=SUM(1,1)",
            evidence = EvidenceCreateRequest(
                contentType = "image/png",
                dataBase64 = java.util.Base64.getEncoder().encodeToString(png),
                viewportWidth = 100,
                viewportHeight = 100,
                pixelRatio = 1.0,
                capturedAt = "2026-08-09T00:00:00Z"
            )
        )
        val storage = LocalEvidenceStorage(temporaryDirectory.resolve("evidence"))
        val thread = storage.use {
            database.createThread(
                scope,
                opened.id,
                principal,
                threadRequest,
                "phase3-thread-key-001",
                requestHash(serviceJson.encodeToJsonElement(FeedbackThreadCreateRequest.serializer(), threadRequest)),
                it,
                "evidence/",
                1024
            )
        }
        return Phase3Fixture(input, principal, scope, opened.id, thread.id)
    }

    private fun makeNotificationsAvailable(scope: ResourceScope) {
        database.dataSource.connection.use { connection ->
            connection.prepareStatement(
                "UPDATE feedback.notification_outbox SET available_at = now() WHERE workspace_id = ?::uuid"
            ).use { statement -> statement.setString(1, scope.workspaceId); statement.executeUpdate() }
        }
    }

    private fun required(name: String): String = System.getenv(name) ?: error("$name が必要です")

    private data class Fixture(val userId: String, val workspaceA: String)
    private data class Phase3Fixture(
        val input: BootstrapInput,
        val principal: FeedbackPrincipal,
        val scope: ResourceScope,
        val sessionId: String,
        val threadId: String
    )
}
