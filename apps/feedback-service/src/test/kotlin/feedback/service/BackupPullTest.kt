package feedback.service

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.name
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.io.TempDir

class BackupPullTest {
    @TempDir
    lateinit var temporaryDirectory: Path

    @Test
    fun `OAuth取得からchecksum検証とatomic配置までを冪等に実行する`() {
        val source = createArchive()
        val archiveHash = sha256(source)
        val run = backupRun(archiveHash)
        val downloads = AtomicInteger()
        val listRequests = AtomicInteger()
        val tokenBodies = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/token") { exchange ->
                tokenBodies += exchange.requestBody.readAllBytes().decodeToString()
                exchange.respondJson(200, """{"access_token":"short-token","token_type":"Bearer"}""")
            }
            createContext("/api/backups") { exchange ->
                assertEquals("Bearer short-token", exchange.requestHeaders.getFirst("Authorization"))
                val cursor = exchange.requestURI.rawQuery?.contains("cursor=next") == true
                listRequests.incrementAndGet()
                val page = FeedbackBackupRunPage(if (cursor) emptyList() else listOf(run), if (cursor) null else "next")
                exchange.respondJson(200, serviceJson.encodeToString(FeedbackBackupRunPage.serializer(), page))
            }
            createContext("/api/backups/${run.id}/download") { exchange ->
                downloads.incrementAndGet()
                val bytes = Files.readAllBytes(source)
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
                exchange.close()
            }
            start()
        }
        try {
            val destination = temporaryDirectory.resolve("mounted-share")
            val settings = settings(server, destination)
            val client = BackupPullClient()
            client.run(settings)

            val target = destination.resolve(backupFileName(run))
            assertTrue(Files.isRegularFile(target))
            assertTrue(verifyBackupManifest(target))
            assertEquals(1, downloads.get())
            assertEquals(2, listRequests.get())
            assertTrue(tokenBodies.single().contains("grant_type=client_credentials"))
            assertTrue(tokenBodies.single().contains("scope=feedback.manage"))
            assertFalse(Files.list(destination).use { paths -> paths.anyMatch { it.name.endsWith(".part") } })

            client.run(settings)
            assertEquals(1, downloads.get(), "検証済み同名archiveは再取得しない")

            Files.writeString(target, "corrupt")
            client.run(settings)
            assertEquals(2, downloads.get(), "破損archiveだけを再取得する")
            assertTrue(verifyBackupManifest(target))
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `checksum不一致と対象外pathを拒否する`() {
        assertFailsWith<IllegalArgumentException> { validateBackupPullDestination(Path.of("/")) }
        val destination = temporaryDirectory.resolve("share").toAbsolutePath().normalize()
        assertFailsWith<IllegalArgumentException> { resolveBackupTarget(destination, "../outside.zip") }
        assertFailsWith<IllegalArgumentException> { resolveBackupTarget(destination, "sub/outside.zip") }

        Files.createDirectories(destination)
        val source = createArchive()
        val run = backupRun("0".repeat(64))
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/api/backups/${run.id}/download") { exchange ->
                val bytes = Files.readAllBytes(source)
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
                exchange.close()
            }
            start()
        }
        try {
            assertFailsWith<IllegalStateException> {
                BackupPullClient().pull(settings(server, destination), "token", run)
            }
            assertFalse(Files.exists(destination.resolve(backupFileName(run))))
            assertFalse(Files.list(destination).use { paths -> paths.anyMatch { it.name.endsWith(".part") } })
        } finally {
            server.stop(0)
        }
    }

    private fun createArchive(): Path {
        val target = temporaryDirectory.resolve("source-${System.nanoTime()}.zip")
        val storage = LocalEvidenceStorage(temporaryDirectory.resolve("empty-evidence"))
        writeBackupArchive(
            PreparedBackupArchive(
                runId = "00000000-0000-4000-8000-000000000010",
                kind = "full",
                scheduledFor = "2026-08-09T00:00:00Z",
                tenantKey = "tenant",
                applicationKey = "app",
                environmentKey = "production",
                externalWorkspaceKey = "workspace",
                fromChangeSequence = 0,
                toChangeSequence = 1,
                fromAuditSequence = 0,
                toAuditSequence = 1,
                historyCoverageStartedAt = "2026-08-09T00:00:00Z",
                includeEvidence = false,
                csvEntries = listOf(BackupCsvEntry("threads.csv", listOf("thread_id"), listOf(listOf("thread-1")))),
                evidenceEntries = emptyList(),
                retentionDays = null
            ),
            storage,
            target,
            now = { Instant.parse("2026-08-09T00:00:01Z") }
        )
        return target
    }

    private fun backupRun(hash: String) = FeedbackBackupRun(
        id = "00000000-0000-4000-8000-000000000011",
        kind = "full",
        status = "completed",
        scheduledFor = "2026-08-09T00:00:00Z",
        downloadUrl = "/backups/00000000-0000-4000-8000-000000000011/download",
        fromChangeSequence = 0,
        toChangeSequence = 1,
        fromAuditSequence = 0,
        toAuditSequence = 1,
        archiveSha256 = hash,
        historyCoverageStartedAt = "2026-08-09T00:00:00Z",
        createdAt = "2026-08-09T00:00:00Z"
    )

    private fun settings(server: HttpServer, destination: Path) = BackupPullSettings(
        apiBaseUrl = "http://127.0.0.1:${server.address.port}/api",
        tokenUrl = "http://127.0.0.1:${server.address.port}/token",
        clientId = "backup-puller",
        clientSecret = "client-secret",
        scope = "feedback.manage",
        applicationKey = "app",
        externalWorkspaceKey = "workspace",
        destinationDirectory = destination.toAbsolutePath().normalize()
    )

    private fun com.sun.net.httpserver.HttpExchange.respondJson(status: Int, body: String) {
        responseHeaders.add("Content-Type", "application/json")
        val bytes = body.toByteArray()
        sendResponseHeaders(status, bytes.size.toLong())
        responseBody.use { it.write(bytes) }
        close()
    }
}
