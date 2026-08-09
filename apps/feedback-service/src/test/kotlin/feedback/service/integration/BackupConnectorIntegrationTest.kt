package feedback.service.integration

import com.sun.net.httpserver.HttpServer
import feedback.service.BackupWorker
import feedback.service.BootstrapInput
import feedback.service.ConnectorHttpDispatcher
import feedback.service.ConnectorInstallationInput
import feedback.service.DatabaseSettings
import feedback.service.EvidenceCreateRequest
import feedback.service.FeedbackBackupPolicy
import feedback.service.FeedbackDatabase
import feedback.service.FeedbackMessageCreateRequest
import feedback.service.FeedbackMessagePatchRequest
import feedback.service.FeedbackNotificationConnectorCreateRequest
import feedback.service.FeedbackPermission
import feedback.service.FeedbackSessionCreateRequest
import feedback.service.FeedbackThreadCreateRequest
import feedback.service.LocalEvidenceStorage
import feedback.service.NotificationCipher
import feedback.service.NotificationWorker
import feedback.service.SessionPerspective
import feedback.service.SessionScope
import feedback.service.requestHash
import feedback.service.serviceJson
import feedback.service.verifyBackupManifest
import feedback.service.*
import java.net.InetSocketAddress
import java.net.URI
import java.nio.file.Path
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.io.TempDir
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertContains
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.BucketAlreadyExistsException
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException

@Tag("integration")
class BackupConnectorIntegrationTest {
    private lateinit var database: FeedbackDatabase

    @TempDir
    lateinit var temporaryDirectory: Path

    @BeforeTest
    fun setUp() {
        database = FeedbackDatabase.create(
            DatabaseSettings(
                url = required("FEEDBACK_DATABASE_URL"),
                user = required("FEEDBACK_DATABASE_USER"),
                password = required("FEEDBACK_DATABASE_PASSWORD"),
                poolSize = 4,
                connectionTimeoutMillis = 5000,
                statementTimeoutMillis = 30000
            )
        )
        database.dataSource.connection.use { connection ->
            connection.createStatement().use { it.execute("DROP SCHEMA IF EXISTS feedback CASCADE") }
        }
        database.migrate()
    }

    @AfterTest
    fun tearDown() = database.close()

    @Test
    fun `日次フルと差分archiveを生成しconnectorへ別プロセス配送する`() {
        val input = bootstrapInput()
        database.bootstrap(input)
        val principal = database.resolvePrincipal(input.issuer, input.subject, input.email, input.displayName)
        val scope = database.resolveWorkspaceScope(principal.userId, input.applicationKey, input.externalWorkspaceKey, input.environmentKey)
        val manifest = manifest(input.applicationKey)
        database.putManifest(scope, principal, manifest, null)
        val sessionRequest = FeedbackSessionCreateRequest(
            applicationKey = input.applicationKey,
            environmentKey = input.environmentKey,
            externalWorkspaceKey = input.externalWorkspaceKey,
            manifestVersion = "1",
            title = "バックアップ検証",
            scopes = listOf(SessionScope("home", "/", true)),
            perspectives = listOf(SessionPerspective("quality", "品質", "active"))
        )
        val session = database.createSession(
            scope,
            principal,
            sessionRequest,
            "backup-session-${UUID.randomUUID()}",
            requestHash(serviceJson.encodeToJsonElement(FeedbackSessionCreateRequest.serializer(), sessionRequest))
        )
        database.dataSource.connection.use { connection ->
            connection.prepareStatement("UPDATE feedback.review_sessions SET status = 'open' WHERE id = ?::uuid").use {
                it.setString(1, session.id)
                it.executeUpdate()
            }
        }
        val bucket = "${required("FEEDBACK_TEST_S3_BUCKET")}-${UUID.randomUUID().toString().take(8)}"
        val evidenceStorage = s3Storage(bucket)
        val backupStorage = s3Storage(bucket)
        val threadRequest = FeedbackThreadCreateRequest(
            location = buildJsonObject {
                put("schemaVersion", "1"); put("pageKey", "home"); put("routeTemplate", "/")
                put("pathParameters", buildJsonObject { })
            },
            target = buildJsonObject {
                put("schemaVersion", "1"); put("kind", "screen-position"); put("relativeX", 0.5); put("relativeY", 0.5)
            },
            perspectiveCode = "quality",
            body = "最初のコメント",
            evidence = EvidenceCreateRequest(
                contentType = "image/png",
                dataBase64 = Base64.getEncoder().encodeToString(
                    byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0)
                ),
                viewportWidth = 800,
                viewportHeight = 600,
                pixelRatio = 1.0,
                capturedAt = "2026-08-09T00:00:00Z"
            )
        )
        val thread = database.createThread(
            scope, session.id, principal, threadRequest, "backup-thread-${UUID.randomUUID()}",
            requestHash(serviceJson.encodeToJsonElement(FeedbackThreadCreateRequest.serializer(), threadRequest)),
            evidenceStorage, "evidence/", 1_000_000, 100, "backup-test"
        )
        val replyRequest = FeedbackMessageCreateRequest("返信")
        val reply = database.createMessage(
            scope, thread.id, principal, replyRequest, "backup-message-${UUID.randomUUID()}",
            requestHash(serviceJson.encodeToJsonElement(FeedbackMessageCreateRequest.serializer(), replyRequest)), "backup-test"
        )
        database.patchMessage(reply.id, principal, reply.version, FeedbackMessagePatchRequest("編集済み返信"), scope)
        database.patchThreadStatus(scope, thread.id, principal, thread.version + 2, "resolved", "backup-test")
        database.patchBackupPolicy(
            scope,
            database.getBackupPolicy(scope).second,
            FeedbackBackupPolicy(enabled = true, timezone = "Asia/Tokyo", fullBackupAt = "02:00", incrementalIntervalMinutes = 60)
        )

        try {
            val worker = BackupWorker(database, evidenceStorage, backupStorage, "backups/")
            assertTrue(worker.runOnce(Instant.parse("2026-08-09T03:00:00Z")))
            val full = database.listBackups(scope, 10).items.single()
            assertEquals("completed", full.status)
            assertEquals("full", full.kind)
            val fullObject = backupStorage.list("backups/").single()
            val localCopy = temporaryDirectory.resolve("full.zip")
            java.nio.file.Files.write(localCopy, backupStorage.get(fullObject.objectKey))
            assertTrue(verifyBackupManifest(localCopy))
            ZipFile(localCopy.toFile()).use { zip ->
                val messages = zip.text("messages.csv")
                val versions = zip.text("message_versions.csv")
                val statuses = zip.text("status_events.csv")
                val manifestJson = zip.text("manifest.json")
                assertContains(messages, "最初のコメント")
                assertContains(messages, "編集済み返信")
                assertContains(versions, "返信")
                assertContains(versions, "編集済み返信")
                assertContains(statuses, "feedback.thread.created.v1")
                assertContains(statuses, "feedback.thread.resolved.v1")
                assertFalse(statuses.contains("baseline"), "復元不能な過去状態を推測しない")
                assertContains(manifestJson, "\"counts\"")
                assertContains(manifestJson, "\"historyCoverageStartedAt\"")
                val evidenceName = zip.entries().asSequence().map { it.name }.single { it.startsWith("evidence/") }
                assertEquals(
                    listOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0),
                    zip.getInputStream(zip.getEntry(evidenceName)).readAllBytes().toList()
                )
            }

            val body = AtomicReference<String>()
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/connector/v1/deliveries") { exchange ->
                body.set(exchange.requestBody.use { it.readAllBytes().decodeToString() })
                val deliveryId = exchange.requestHeaders.getFirst("X-Feedback-Delivery-Id")
                val response = """{"kind":"delivery-result","protocolVersion":"1","deliveryId":"$deliveryId","status":"accepted","receivedAt":"2026-08-09T00:00:01Z"}"""
                exchange.sendResponseHeaders(202, response.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(response.toByteArray()) }
                exchange.close()
            }
            createContext("/health/ready") { exchange ->
                exchange.sendResponseHeaders(204, -1)
                exchange.close()
            }
            start()
        }
            try {
            val cipher = NotificationCipher(ByteArray(32) { 7 })
            val signingSecret = "integration-connector-secret-32chars"
            database.registerConnectorInstallation(
                ConnectorInstallationInput(
                    connectorKey = "teams",
                    displayName = "Teams",
                    manifestUrl = "http://127.0.0.1:${server.address.port}/connector/v1/manifest",
                    deliveryUrl = "http://127.0.0.1:${server.address.port}/connector/v1/deliveries",
                    healthUrl = "http://127.0.0.1:${server.address.port}/health/ready",
                    signingSecret = signingSecret,
                    supportedEvents = listOf("feedback.message.created.v1")
                ),
                cipher
            )
            val connector = database.createNotificationConnector(
                scope,
                FeedbackNotificationConnectorCreateRequest("teams", "品質通知", "review-channel", includeBody = false)
            )
            val deltaRequest = FeedbackMessageCreateRequest("外部へ出さない本文")
            database.createMessage(
                scope, thread.id, principal, deltaRequest, "backup-delta-${UUID.randomUUID()}",
                requestHash(serviceJson.encodeToJsonElement(FeedbackMessageCreateRequest.serializer(), deltaRequest)), "backup-test"
            )
            val notificationWorker = NotificationWorker(
                database = database,
                pollMillis = 100,
                maxAttempts = 3,
                notificationCipher = cipher,
                connectorDispatcher = ConnectorHttpDispatcher(allowLocalDestinations = true),
                connectorHealthChecker = ConnectorHttpHealthChecker(allowLocalDestinations = true)
            )
            assertTrue(notificationWorker.runOnce())
            assertEquals("healthy", database.listConnectorTypes().single { it.key == "teams" }.healthStatus)
            assertEquals("healthy", database.listNotificationConnectors(scope).single().healthStatus)
            val deliveredBody = assertNotNull(body.get())
            assertTrue("review-channel" in deliveredBody)
            assertTrue("外部へ出さない本文" !in deliveredBody)
            val delivered = database.listNotificationDeliveries(scope, "delivered", 10, connector.id).single()
            database.deleteNotificationConnector(scope, connector.id, connector.version)
            assertTrue(database.listNotificationConnectors(scope).isEmpty())
            assertEquals(connector.id, database.listNotificationDeliveries(scope, "delivered", 10).first { it.id == delivered.id }.connectorId)
            } finally {
                server.stop(0)
            }

            assertTrue(worker.runOnce(Instant.now().plusSeconds(61 * 60)))
            val incremental = database.listBackups(scope, 10).items.first { it.kind == "incremental" }
            assertEquals("completed", incremental.status)
            assertTrue(incremental.fromChangeSequence > 0)
            assertTrue(requireNotNull(incremental.toChangeSequence) > incremental.fromChangeSequence)
            val incrementalObject = backupStorage.list("backups/").single { ref ->
                sha256(backupStorage.get(ref.objectKey)) == incremental.archiveSha256
            }
            val incrementalCopy = temporaryDirectory.resolve("incremental.zip")
            java.nio.file.Files.write(incrementalCopy, backupStorage.get(incrementalObject.objectKey))
            assertTrue(verifyBackupManifest(incrementalCopy))
            ZipFile(incrementalCopy.toFile()).use { zip ->
                val messages = zip.text("messages.csv")
                val versions = zip.text("message_versions.csv")
                val evidence = zip.text("evidence.csv")
                assertContains(messages, "外部へ出さない本文")
                assertFalse(messages.contains("最初のコメント"))
                assertFalse(messages.contains("編集済み返信"))
                assertContains(versions, "外部へ出さない本文")
                assertFalse(versions.contains("編集済み返信"))
                assertEquals(1, evidence.lineSequence().filter(String::isNotBlank).count(), "差分に既存証跡を再収録しない")
                assertTrue(zip.entries().asSequence().none { it.name.startsWith("evidence/") })
            }
            val firstPage = database.listBackups(scope, 1)
            val secondPage = database.listBackups(scope, 1, decodeCursor(firstPage.nextCursor))
            assertTrue(firstPage.items.single().id != secondPage.items.single().id)

            val failureRequest = FeedbackMessageCreateRequest("失敗時カーソル検証")
            database.createMessage(
                scope, thread.id, principal, failureRequest, "backup-failure-${UUID.randomUUID()}",
                requestHash(serviceJson.encodeToJsonElement(FeedbackMessageCreateRequest.serializer(), failureRequest)),
                "backup-test"
            )
            val failureNow = Instant.now().plusSeconds(2 * 60 * 60)
            val failedWorker = BackupWorker(
                database,
                evidenceStorage,
                object : EvidenceStorage by backupStorage {
                    override fun putFile(objectKey: String, contentType: String, path: Path) {
                        throw IllegalStateException("fixture storage failure")
                    }
                },
                "backups/",
                maxAttempts = 1
            )
            assertTrue(failedWorker.runOnce(failureNow))
            val failed = database.listBackups(scope, 20).items.single { it.status == "failed" }
            assertEquals(incremental.toChangeSequence, failed.fromChangeSequence)
            assertNull(failed.toChangeSequence)
            assertEquals(incremental.toChangeSequence, database.getBackupPolicyView(scope).first.changeCursor)
            database.retryBackup(scope, failed.id)
            assertTrue(worker.runOnce(failureNow.plusSeconds(1)))
            val recovered = database.getBackup(failed.id)
            assertEquals("completed", recovered.status)
            assertTrue(requireNotNull(recovered.toChangeSequence) > recovered.fromChangeSequence)

            val leaseRequest = FeedbackMessageCreateRequest("lease検証")
            database.createMessage(
                scope, thread.id, principal, leaseRequest, "backup-lease-${UUID.randomUUID()}",
                requestHash(serviceJson.encodeToJsonElement(FeedbackMessageCreateRequest.serializer(), leaseRequest)),
                "backup-test"
            )
            database.scheduleDueBackups(failureNow.plusSeconds(60 * 60))
            assertTrue(database.listBackups(scope, 20).items.any { it.kind == "incremental" && it.status == "queued" })
            database.scheduleDueBackups(Instant.now().plusSeconds(24 * 60 * 60))
            val start = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            val claims = try {
                (1..2).map {
                    pool.submit<ClaimedBackup?> {
                        start.await()
                        database.claimBackup()
                    }
                }.also { start.countDown() }.map { it.get(10, TimeUnit.SECONDS) }
            } finally {
                pool.shutdownNow()
            }
            val firstClaim = claims.single { it != null }!!
            assertEquals(1, claims.count { it != null }, "多重workerでも1件だけclaimする")
            assertEquals("full", firstClaim.kind, "日次fullを既存のqueued差分より優先する")
            val orphanArchive = temporaryDirectory.resolve("orphan.zip")
            writeBackupArchive(database.prepareBackup(firstClaim), evidenceStorage, orphanArchive)
            val orphanKey = "backups/orphan-${firstClaim.claimToken}.zip"
            backupStorage.putFile(orphanKey, "application/zip", orphanArchive)
            database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "UPDATE feedback.backup_runs SET claimed_at = now() - interval '11 minutes' WHERE id = ?::uuid"
                ).use { statement ->
                    statement.setString(1, firstClaim.id)
                    statement.executeUpdate()
                }
            }
            val reclaimed = assertNotNull(database.claimBackup())
            assertEquals(firstClaim.id, reclaimed.id)
            assertTrue(firstClaim.claimToken != reclaimed.claimToken)
            val retention = RetentionWorker(
                database = database,
                storage = evidenceStorage,
                exportStorage = backupStorage,
                backupPrefix = "backups/",
                orphanGraceSeconds = 300
            )
            assertEquals(1, retention.cleanupBackupOrphans(Instant.now().plusSeconds(3600)))
            assertTrue(backupStorage.list("backups/").none { it.objectKey == orphanKey })
            val auditActions = database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "SELECT action FROM feedback.audit_logs WHERE workspace_id = ?::uuid AND action LIKE 'backup.run.%'"
                ).use { statement ->
                    statement.setString(1, scope.workspaceId)
                    statement.executeQuery().use { result -> buildList { while (result.next()) add(result.getString(1)) } }
                }
            }
            assertTrue("backup.run.started" in auditActions)
            assertTrue("backup.run.completed" in auditActions)
            assertTrue("backup.run.failed" in auditActions)
        } finally {
            evidenceStorage.close()
            backupStorage.close()
        }
    }

    private fun bootstrapInput() = BootstrapInput(
        tenantKey = "backup-tenant",
        tenantDisplayName = "Backup Tenant",
        applicationKey = "backup-app",
        applicationDisplayName = "Backup App",
        environmentKey = "production",
        environmentBaseUrl = "https://backup.example",
        allowedOrigins = listOf("https://backup.example"),
        externalWorkspaceKey = "workspace-1",
        workspaceDisplayName = "Workspace 1",
        issuer = "https://issuer.example",
        subject = "backup-user",
        email = "backup@example.invalid",
        displayName = "Backup User",
        permissions = FeedbackPermission.entries.toSet()
    )

    private fun manifest(applicationKey: String) = buildJsonObject {
        put("schemaVersion", "1")
        put("applicationKey", applicationKey)
        put("displayName", "Backup App")
        put("manifestVersion", "1")
        put("routes", kotlinx.serialization.json.buildJsonArray {
            add(buildJsonObject { put("pageKey", "home"); put("template", "/"); put("label", "ホーム") })
        })
    }

    private fun required(name: String): String = System.getenv(name) ?: error("$name is required")

    private fun ZipFile.text(name: String): String =
        getInputStream(requireNotNull(getEntry(name))).use { it.readAllBytes().decodeToString() }

    private fun s3Storage(bucket: String): S3EvidenceStorage {
        val client = S3Client.builder()
            .endpointOverride(URI(required("FEEDBACK_TEST_S3_ENDPOINT")))
            .region(Region.of(System.getenv("FEEDBACK_TEST_S3_REGION") ?: "us-east-1"))
            .credentialsProvider(
                StaticCredentialsProvider.create(
                    AwsBasicCredentials.create(
                        required("FEEDBACK_TEST_S3_ACCESS_KEY"),
                        required("FEEDBACK_TEST_S3_SECRET_KEY")
                    )
                )
            )
            .forcePathStyle(true)
            .build()
        try {
            client.createBucket { it.bucket(bucket) }
        } catch (_: BucketAlreadyExistsException) {
            // 統合ティア内の別storage clientとbucketを共有する。
        } catch (_: BucketAlreadyOwnedByYouException) {
            // AWS互換実装によって返す例外型が異なるため両方を許容する。
        }
        return S3EvidenceStorage(client, bucket)
    }
}
