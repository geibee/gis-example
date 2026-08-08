package feedback.service

import java.time.Instant
import java.util.UUID

fun main() {
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    val storage = createEvidenceStorage(EvidenceStorageSettings.fromEnv())
    val exportSettings = ExportStorageSettings.fromEnv()
    val exportStorage = LocalEvidenceStorage(exportSettings.localDirectory)
    database.migrate()
    Runtime.getRuntime().addShutdownHook(Thread {
        storage.close()
        exportStorage.close()
        database.close()
    })
    RetentionWorker(database, storage, exportStorage = exportStorage).runForever()
}

class RetentionWorker(
    private val database: FeedbackDatabase,
    private val storage: EvidenceStorage,
    private val exportStorage: EvidenceStorage? = null,
    private val evidencePrefix: String = EvidenceStorageSettings.fromEnv().keyPrefix,
    private val pollMillis: Long = (System.getenv("FEEDBACK_RETENTION_POLL_MS") ?: "3600000").toLong(),
    private val orphanGraceSeconds: Long = (System.getenv("FEEDBACK_ORPHAN_GRACE_SECONDS") ?: "3600").toLong()
) {
    init {
        require(pollMillis >= 1000) { "FEEDBACK_RETENTION_POLL_MS は 1000 以上で指定してください" }
        require(orphanGraceSeconds >= 300) { "FEEDBACK_ORPHAN_GRACE_SECONDS は 300 以上で指定してください" }
    }

    fun runForever() {
        while (!Thread.currentThread().isInterrupted) {
            runCatching {
                deleteExpiredInternalRecords()
                while (purgeOnce() > 0) {
                    // 1 transaction の上限を保ったまま backlog を排出する
                }
                while (purgeExpiredExports() > 0) {
                    // exportも小さなbatchで期限切れを排出する
                }
                cleanupOrphans()
            }.onFailure { exception ->
                org.slf4j.LoggerFactory.getLogger(RetentionWorker::class.java)
                    .error("feedback retention cycle failed", exception)
            }
            Thread.sleep(pollMillis)
        }
    }

    fun deleteExpiredInternalRecords() {
        database.transaction { connection ->
            connection.prepareStatement("DELETE FROM feedback.idempotency_records WHERE expires_at <= now()").use {
                it.executeUpdate()
            }
            connection.prepareStatement(
                "DELETE FROM feedback.rate_limit_counters WHERE window_epoch < floor(extract(epoch FROM now()) / 60)::bigint - 2"
            ).use { it.executeUpdate() }
        }
    }

    fun purgeOnce(limit: Int = 100): Int {
        require(limit in 1..1000)
        return database.transaction { connection ->
            val expired = connection.prepareStatement(
                """
                SELECT e.id::text, e.object_key, t.tenant_id::text, t.application_id::text,
                       t.workspace_id::text
                FROM feedback.review_evidence e
                JOIN feedback.feedback_threads t ON t.id = e.thread_id
                JOIN feedback.review_sessions s ON s.id = t.session_id
                LEFT JOIN LATERAL (
                    SELECT evidence_retention_days
                    FROM feedback.retention_policies policy
                    WHERE policy.workspace_id = t.workspace_id
                    FOR UPDATE
                ) p ON true
                WHERE COALESCE(
                    e.expires_at,
                    e.created_at + (COALESCE(s.evidence_retention_days, p.evidence_retention_days) * interval '1 day')
                ) <= now()
                ORDER BY e.created_at
                FOR UPDATE OF e, s SKIP LOCKED
                LIMIT ?
                """.trimIndent()
            ).use { statement ->
                statement.setInt(1, limit)
                statement.executeQuery().use { result ->
                    buildList {
                        while (result.next()) {
                            add(
                                ExpiredEvidence(
                                    id = result.getString(1),
                                    objectKey = result.getString(2),
                                    tenantId = result.getString(3),
                                    applicationId = result.getString(4),
                                    workspaceId = result.getString(5)
                                )
                            )
                        }
                    }
                }
            }
            expired.forEach { evidence ->
                storage.delete(evidence.objectKey)
                connection.prepareStatement("DELETE FROM feedback.review_evidence WHERE id = ?::uuid").use { statement ->
                    statement.setString(1, evidence.id)
                    statement.executeUpdate()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO feedback.audit_logs (
                        id, tenant_id, application_id, workspace_id, action, resource_type,
                        resource_id, outcome, request_id, changes
                    ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'evidence.purge', 'evidence', ?,
                              'succeeded', ?, '{"reason":"retention-policy"}'::jsonb)
                    """.trimIndent()
                ).use { statement ->
                    statement.setString(1, UUID.randomUUID().toString())
                    statement.setString(2, evidence.tenantId)
                    statement.setString(3, evidence.applicationId)
                    statement.setString(4, evidence.workspaceId)
                    statement.setString(5, evidence.id)
                    statement.setString(6, "retention:${UUID.randomUUID()}")
                    statement.executeUpdate()
                }
            }
            expired.size
        }
    }

    fun cleanupOrphans(now: Instant = Instant.now()): Int {
        val cutoff = now.minusSeconds(orphanGraceSeconds)
        val candidates = storage.list(evidencePrefix).filter { it.lastModified.isBefore(cutoff) }
        var removed = 0
        candidates.forEach { candidate ->
            val exists = database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "SELECT 1 FROM feedback.review_evidence WHERE object_key = ?"
                ).use { statement ->
                    statement.setString(1, candidate.objectKey)
                    statement.executeQuery().use { it.next() }
                }
            }
            if (!exists) {
                storage.delete(candidate.objectKey)
                removed += 1
            }
        }
        return removed
    }

    fun purgeExpiredExports(limit: Int = 100): Int {
        require(limit in 1..1000)
        val targetStorage = exportStorage ?: return 0
        return database.transaction { connection ->
            val expired = connection.prepareStatement(
                """
                SELECT id::text, object_key, tenant_id::text, application_id::text, workspace_id::text
                FROM feedback.export_jobs
                WHERE status = 'completed' AND expires_at <= now() AND object_key IS NOT NULL
                ORDER BY expires_at
                FOR UPDATE SKIP LOCKED
                LIMIT ?
                """.trimIndent()
            ).use { statement ->
                statement.setInt(1, limit)
                statement.executeQuery().use { result ->
                    buildList {
                        while (result.next()) add(
                            ExpiredExport(
                                result.getString(1), result.getString(2), result.getString(3),
                                result.getString(4), result.getString(5)
                            )
                        )
                    }
                }
            }
            expired.forEach { export ->
                targetStorage.delete(export.objectKey)
                connection.prepareStatement(
                    "UPDATE feedback.export_jobs SET object_key = NULL WHERE id = ?::uuid"
                ).use { statement -> statement.setString(1, export.id); statement.executeUpdate() }
                connection.prepareStatement(
                    """
                    INSERT INTO feedback.audit_logs (
                        id, tenant_id, application_id, workspace_id, action, resource_type,
                        resource_id, outcome, request_id, changes
                    ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'export.purge', 'export', ?,
                              'succeeded', ?, '{"reason":"retention-policy"}'::jsonb)
                    """.trimIndent()
                ).use { statement ->
                    statement.setString(1, UUID.randomUUID().toString())
                    statement.setString(2, export.tenantId)
                    statement.setString(3, export.applicationId)
                    statement.setString(4, export.workspaceId)
                    statement.setString(5, export.id)
                    statement.setString(6, "retention:${UUID.randomUUID()}")
                    statement.executeUpdate()
                }
            }
            expired.size
        }
    }
}

private data class ExpiredEvidence(
    val id: String,
    val objectKey: String,
    val tenantId: String,
    val applicationId: String,
    val workspaceId: String
)

private data class ExpiredExport(
    val id: String,
    val objectKey: String,
    val tenantId: String,
    val applicationId: String,
    val workspaceId: String
)
