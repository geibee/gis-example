package feedback.service

import java.nio.file.Files
import java.time.Instant

class BackupWorker(
    private val database: FeedbackDatabase,
    private val evidenceStorage: EvidenceStorage,
    private val backupStorage: EvidenceStorage,
    private val keyPrefix: String = "backups/",
    private val maxAttempts: Int = 5
) {
    private val logger = org.slf4j.LoggerFactory.getLogger(BackupWorker::class.java)

    fun runOnce(now: Instant = Instant.now()): Boolean {
        database.scheduleDueBackups(now)
        val claimed = database.claimBackup() ?: return false
        val temporary = Files.createTempFile("feedback-backup-${claimed.id}-", ".zip")
        val objectKey = "$keyPrefix${claimed.tenantId}/${claimed.workspaceId}/${now.toString().take(7).replace('-', '/')}/" +
            "${claimed.scheduledFor.replace(':', '-')}--${claimed.kind}-${claimed.id}-attempt-${claimed.attempt}-${claimed.claimToken}.zip"
        try {
            val prepared = database.prepareBackup(claimed)
            val archive = writeBackupArchive(prepared, evidenceStorage, temporary)
            backupStorage.putFile(objectKey, "application/zip", temporary)
            database.completeBackup(claimed, prepared, objectKey, archive)
        } catch (exception: Exception) {
            logger.error("feedback backup failed: backupId={}", claimed.id, exception)
            database.failBackup(claimed, "backup generation failed (${exception::class.simpleName ?: "unknown"})", maxAttempts)
        } finally {
            Files.deleteIfExists(temporary)
        }
        return true
    }
}
