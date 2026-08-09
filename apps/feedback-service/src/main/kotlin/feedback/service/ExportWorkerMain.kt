package feedback.service

fun main() {
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    database.migrate()
    val settings = ExportStorageSettings.fromEnv()
    val storage = LocalEvidenceStorage(settings.localDirectory)
    val worker = ExportWorker(database, storage, settings.keyPrefix)
    Runtime.getRuntime().addShutdownHook(Thread {
        storage.close()
        database.close()
    })
    worker.runForever()
}

class ExportWorker(
    private val database: FeedbackDatabase,
    private val storage: EvidenceStorage,
    private val keyPrefix: String,
    private val pollMillis: Long = (System.getenv("FEEDBACK_EXPORT_POLL_MS") ?: "2000").toLong()
) {
    private val logger = org.slf4j.LoggerFactory.getLogger(ExportWorker::class.java)

    init {
        require(pollMillis in 100..3_600_000) { "FEEDBACK_EXPORT_POLL_MS は 100..3600000 です" }
    }

    fun runForever() {
        while (!Thread.currentThread().isInterrupted) {
            if (!runOnce()) Thread.sleep(pollMillis)
        }
    }

    fun runOnce(): Boolean {
        val claimed = database.claimExport() ?: return false
        val objectKey = "$keyPrefix${claimed.tenantId}/${claimed.workspaceId}/${claimed.id}-${claimed.claimToken}.${claimed.format}"
        try {
            val prepared = database.prepareExport(claimed)
            val bytes = renderFeedbackExport(claimed.format, claimed.locale, claimed.timezone, prepared.rows)
            val contentType = if (claimed.format == "csv") "text/csv; charset=utf-8" else
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            runCatching { storage.delete(objectKey) }
            storage.put(objectKey, contentType, bytes)
            try {
                database.completeExport(claimed, objectKey, prepared.retentionDays)
            } catch (exception: Exception) {
                runCatching { storage.delete(objectKey) }
                throw exception
            }
        } catch (exception: Exception) {
            logger.error("feedback export failed: exportId={}", claimed.id, exception)
            database.failExport(claimed, "export generation failed (${exception::class.simpleName ?: "unknown"})")
        }
        return true
    }
}
