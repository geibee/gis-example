package feedback.service

import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.time.Instant
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.io.TempDir

class BackupSupportTest {
    @TempDir
    lateinit var temporaryDirectory: Path

    @Test
    fun `CSVと証跡をmanifest checksum付きの自己完結ZIPへ出力する`() {
        val evidenceStorage = LocalEvidenceStorage(temporaryDirectory.resolve("evidence"))
        val evidence = "evidence-binary".toByteArray()
        evidenceStorage.put("source/evidence", "image/png", evidence)
        val target = temporaryDirectory.resolve("backup.zip")
        val prepared = fixture(
            evidenceEntries = listOf(
                BackupEvidenceEntry("evidence/thread-1.png", "source/evidence", "image/png", sha256(evidence))
            )
        )

        val result = writeBackupArchive(prepared, evidenceStorage, target) { Instant.parse("2026-08-09T01:00:00Z") }

        assertEquals(sha256(target), result.sha256)
        assertEquals(1, result.entryCounts["threads.csv"])
        assertEquals(1, result.entryCounts["evidence"])
        assertTrue(verifyBackupManifest(target))
        ZipFile(target.toFile()).use { zip ->
            val csv = zip.getInputStream(zip.getEntry("threads.csv")).readAllBytes().toString(StandardCharsets.UTF_8)
            assertContains(csv, "'=HYPERLINK")
            val manifest = zip.getInputStream(zip.getEntry("manifest.json")).readAllBytes().toString(StandardCharsets.UTF_8)
            assertContains(manifest, "\"historyCoverageStartedAt\":\"2026-08-09T00:00:00Z\"")
            assertEquals(evidence.toList(), zip.getInputStream(zip.getEntry("evidence/thread-1.png")).readAllBytes().toList())
        }
    }

    @Test
    fun `証跡checksum不一致ではarchiveを成功扱いにしない`() {
        val evidenceStorage = LocalEvidenceStorage(temporaryDirectory.resolve("invalid-evidence"))
        evidenceStorage.put("source/evidence", "image/png", "changed".toByteArray())
        assertFailsWith<IllegalStateException> {
            writeBackupArchive(
                fixture(listOf(BackupEvidenceEntry("evidence/thread-1.png", "source/evidence", "image/png", "0".repeat(64)))),
                evidenceStorage,
                temporaryDirectory.resolve("invalid.zip")
            )
        }
    }

    @Test
    fun `manifestにないentryを含むZIPは検証で拒否する`() {
        val storage = LocalEvidenceStorage(temporaryDirectory.resolve("extra-entry-evidence"))
        val original = temporaryDirectory.resolve("original.zip")
        writeBackupArchive(fixture(emptyList()), storage, original)
        val modified = temporaryDirectory.resolve("modified.zip")
        ZipOutputStream(java.nio.file.Files.newOutputStream(modified)).use { output ->
            ZipInputStream(java.nio.file.Files.newInputStream(original)).use { input ->
                while (true) {
                    val entry = input.nextEntry ?: break
                    output.putNextEntry(java.util.zip.ZipEntry(entry.name))
                    input.copyTo(output)
                    output.closeEntry()
                }
            }
            output.putNextEntry(java.util.zip.ZipEntry("unexpected.txt"))
            output.write("unexpected".toByteArray())
            output.closeEntry()
        }

        assertTrue(!verifyBackupManifest(modified))
    }

    private fun fixture(evidenceEntries: List<BackupEvidenceEntry>) = PreparedBackupArchive(
        runId = "00000000-0000-4000-8000-000000000001",
        kind = "full",
        scheduledFor = "2026-08-09T00:00:00Z",
        tenantKey = "tenant",
        applicationKey = "application",
        environmentKey = "production",
        externalWorkspaceKey = "workspace",
        fromChangeSequence = 0,
        toChangeSequence = 10,
        fromAuditSequence = 0,
        toAuditSequence = 20,
        historyCoverageStartedAt = "2026-08-09T00:00:00Z",
        includeEvidence = true,
        csvEntries = listOf(
            BackupCsvEntry("threads.csv", listOf("thread_id", "body"), listOf(listOf("thread-1", "=HYPERLINK(\"bad\")")))
        ),
        evidenceEntries = evidenceEntries,
        retentionDays = null
    )
}
