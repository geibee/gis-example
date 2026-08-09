package feedback.service

import java.io.BufferedOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class BackupCsvEntry(
    val path: String,
    val header: List<String>,
    val rows: List<List<String?>>
)

data class BackupEvidenceEntry(
    val archivePath: String,
    val objectKey: String,
    val contentType: String,
    val expectedSha256: String
)

data class PreparedBackupArchive(
    val runId: String,
    val kind: String,
    val scheduledFor: String,
    val tenantKey: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val fromChangeSequence: Long,
    val toChangeSequence: Long,
    val fromAuditSequence: Long,
    val toAuditSequence: Long,
    val historyCoverageStartedAt: String,
    val includeEvidence: Boolean,
    val csvEntries: List<BackupCsvEntry>,
    val evidenceEntries: List<BackupEvidenceEntry>,
    val retentionDays: Int?
)

data class BackupArchiveResult(
    val sha256: String,
    val byteSize: Long,
    val entryCounts: Map<String, Long>
)

internal fun writeBackupArchive(
    prepared: PreparedBackupArchive,
    evidenceStorage: EvidenceStorage,
    target: Path,
    now: () -> Instant = Instant::now
): BackupArchiveResult {
    val entries = linkedMapOf<String, ArchiveManifestEntry>()
    ZipOutputStream(BufferedOutputStream(Files.newOutputStream(target))).use { zip ->
        prepared.csvEntries.forEach { csv ->
            val bytes = renderArchiveCsv(csv.header, csv.rows)
            zip.writeBackupEntry(csv.path, bytes)
            entries[csv.path] = ArchiveManifestEntry(sha256(bytes), bytes.size.toLong(), csv.rows.size.toLong())
        }
        if (prepared.includeEvidence) {
            prepared.evidenceEntries.forEach { evidence ->
                val bytes = evidenceStorage.get(evidence.objectKey)
                val actualHash = sha256(bytes)
                check(actualHash == evidence.expectedSha256) {
                    "evidence checksum mismatch: ${evidence.archivePath}"
                }
                zip.writeBackupEntry(evidence.archivePath, bytes)
                entries[evidence.archivePath] = ArchiveManifestEntry(actualHash, bytes.size.toLong(), null)
            }
        }
        val manifest = buildBackupManifest(prepared, entries, now()).toString().toByteArray(StandardCharsets.UTF_8)
        zip.writeBackupEntry("manifest.json", manifest)
    }
    return BackupArchiveResult(
        sha256 = sha256(target),
        byteSize = Files.size(target),
        entryCounts = prepared.csvEntries.associate { it.path to it.rows.size.toLong() } +
            ("evidence" to if (prepared.includeEvidence) prepared.evidenceEntries.size.toLong() else 0L)
    )
}

private data class ArchiveManifestEntry(val sha256: String, val byteSize: Long, val rows: Long?)

private fun buildBackupManifest(
    prepared: PreparedBackupArchive,
    entries: Map<String, ArchiveManifestEntry>,
    generatedAt: Instant
): JsonObject = buildJsonObject {
    put("schemaVersion", "1")
    put("runId", prepared.runId)
    put("kind", prepared.kind)
    put("scheduledFor", prepared.scheduledFor)
    put("generatedAt", generatedAt.toString())
    put("tenantKey", prepared.tenantKey)
    put("applicationKey", prepared.applicationKey)
    put("environmentKey", prepared.environmentKey)
    put("externalWorkspaceKey", prepared.externalWorkspaceKey)
    put("fromChangeSequenceExclusive", prepared.fromChangeSequence)
    put("toChangeSequenceInclusive", prepared.toChangeSequence)
    put("fromAuditSequenceExclusive", prepared.fromAuditSequence)
    put("toAuditSequenceInclusive", prepared.toAuditSequence)
    put("historyCoverageStartedAt", prepared.historyCoverageStartedAt)
    put("includeEvidence", prepared.includeEvidence)
    put("counts", JsonObject(
        prepared.csvEntries.associate { entry -> entry.path to kotlinx.serialization.json.JsonPrimitive(entry.rows.size) } +
            ("evidence" to kotlinx.serialization.json.JsonPrimitive(
                if (prepared.includeEvidence) prepared.evidenceEntries.size else 0
            ))
    ))
    put("entries", JsonObject(entries.mapValues { (_, entry) ->
        buildJsonObject {
            put("sha256", entry.sha256)
            put("bytes", entry.byteSize)
            entry.rows?.let { put("rows", it) }
        }
    }))
}

private fun renderArchiveCsv(header: List<String>, rows: List<List<String?>>): ByteArray {
    val content = buildString {
        append(header.joinToString(",") { csvCell(it) })
        append("\r\n")
        rows.forEach { row ->
            append(row.joinToString(",") { csvCell(it ?: "") })
            append("\r\n")
        }
    }
    return byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + content.toByteArray(StandardCharsets.UTF_8)
}

private fun csvCell(raw: String): String {
    val safe = escapeSpreadsheetValue(raw)
    return "\"${safe.replace("\"", "\"\"")}\""
}

private fun ZipOutputStream.writeBackupEntry(path: String, bytes: ByteArray) {
    putNextEntry(ZipEntry(path).apply { time = 0L })
    write(bytes)
    closeEntry()
}

internal fun sha256(path: Path): String {
    val digest = MessageDigest.getInstance("SHA-256")
    Files.newInputStream(path).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
