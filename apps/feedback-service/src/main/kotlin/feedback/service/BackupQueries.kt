package feedback.service

import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Types
import java.time.Instant
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

data class ClaimedBackup(
    val id: String,
    val tenantId: String,
    val applicationId: String,
    val workspaceId: String,
    val kind: String,
    val scheduledFor: String,
    val fromChangeSequence: Long,
    val fromAuditSequence: Long,
    val includeEvidence: Boolean,
    val claimToken: String,
    val attempt: Int
)

fun FeedbackDatabase.getBackupPolicy(scope: ResourceScope): Pair<FeedbackBackupPolicy, Int> = transaction { connection ->
    ensureBackupPolicy(connection, requireNotNull(scope.workspaceId))
    readBackupPolicy(connection, scope.workspaceId)
}

fun FeedbackDatabase.getBackupPolicyView(
    scope: ResourceScope,
    now: Instant = Instant.now()
): Pair<FeedbackBackupPolicyView, Int> = transaction { connection ->
    ensureBackupPolicy(connection, requireNotNull(scope.workspaceId))
    val (policy, version) = readBackupPolicy(connection, scope.workspaceId)
    readBackupPolicyView(connection, scope.workspaceId, policy, now) to version
}

fun FeedbackDatabase.patchBackupPolicy(
    scope: ResourceScope,
    expectedVersion: Int,
    value: FeedbackBackupPolicy
): Pair<FeedbackBackupPolicy, Int> = transaction { connection ->
    validateBackupPolicy(value)
    ensureBackupPolicy(connection, requireNotNull(scope.workspaceId))
    connection.prepareStatement(
        """
        UPDATE feedback.backup_policies SET
            enabled = ?, timezone = ?, full_backup_at = ?::time,
            incremental_interval_minutes = ?, include_evidence = ?, retention_days = ?,
            version = version + 1, updated_at = now()
        WHERE workspace_id = ?::uuid AND version = ?
        RETURNING version
        """.trimIndent()
    ).use { statement ->
        statement.setBoolean(1, value.enabled)
        statement.setString(2, value.timezone)
        statement.setString(3, value.fullBackupAt)
        statement.setInt(4, value.incrementalIntervalMinutes)
        statement.setBoolean(5, value.includeEvidence)
        if (value.retentionDays == null) statement.setNull(6, Types.INTEGER) else statement.setInt(6, value.retentionDays)
        statement.setString(7, scope.workspaceId)
        statement.setInt(8, expectedVersion)
        statement.executeQuery().use { result ->
            if (!result.next()) preconditionFailed()
            value to result.getInt(1)
        }
    }
}

fun FeedbackDatabase.scheduleDueBackups(now: Instant = Instant.now()): Int = transaction { connection ->
    val duePolicies = connection.prepareStatement(
        """
        SELECT policy.workspace_id::text, policy.timezone, policy.full_backup_at::text,
               policy.incremental_interval_minutes, policy.include_evidence,
               tenant.id::text, application.id::text, environment.id::text,
               (
                   SELECT max(run.completed_at) FROM feedback.backup_runs run
                   WHERE run.workspace_id = policy.workspace_id AND run.kind = 'full' AND run.status = 'completed'
               ) AS last_full,
               (
                   SELECT max(run.completed_at) FROM feedback.backup_runs run
                   WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'
               ) AS last_any,
               COALESCE((
                   SELECT run.to_change_sequence FROM feedback.backup_runs run
                   WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'
                   ORDER BY run.completed_at DESC LIMIT 1
               ), 0),
               COALESCE((
                   SELECT run.to_audit_sequence FROM feedback.backup_runs run
                   WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'
                   ORDER BY run.completed_at DESC LIMIT 1
               ), 0),
               (
                   SELECT queued.kind FROM feedback.backup_runs queued
                   WHERE queued.workspace_id = policy.workspace_id AND queued.status = 'queued'
                   ORDER BY CASE queued.kind WHEN 'full' THEN 0 ELSE 1 END, queued.scheduled_for
                   LIMIT 1
               ) AS queued_kind
        FROM feedback.backup_policies policy
        JOIN feedback.workspaces workspace ON workspace.id = policy.workspace_id
        JOIN feedback.applications application ON application.id = workspace.application_id
        JOIN feedback.tenants tenant ON tenant.id = application.tenant_id
        JOIN LATERAL (
            SELECT candidate.id FROM feedback.application_environments candidate
            WHERE candidate.application_id = application.id ORDER BY candidate.environment_key LIMIT 1
        ) environment ON true
        WHERE policy.enabled
          AND NOT EXISTS (
              SELECT 1 FROM feedback.backup_runs active
              WHERE active.workspace_id = policy.workspace_id AND active.status IN ('running', 'failed')
          )
        FOR UPDATE OF policy SKIP LOCKED
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        DueBackupPolicy(
                            workspaceId = result.getString(1),
                            timezone = result.getString(2),
                            fullAt = result.getString(3),
                            intervalMinutes = result.getInt(4),
                            includeEvidence = result.getBoolean(5),
                            tenantId = result.getString(6),
                            applicationId = result.getString(7),
                            environmentId = result.getString(8),
                            lastFull = result.getObject(9, OffsetDateTime::class.java)?.toInstant(),
                            lastAny = result.getObject(10, OffsetDateTime::class.java)?.toInstant(),
                            fromChangeSequence = result.getLong(11),
                            fromAuditSequence = result.getLong(12),
                            queuedKind = result.getString(13)
                        )
                    )
                }
            }
        }
    }
    var scheduled = 0
    duePolicies.forEach { policy ->
        val zone = ZoneId.of(policy.timezone)
        val localNow = now.atZone(zone)
        val fullAt = LocalTime.parse(policy.fullAt.take(8))
        val lastFullDate = policy.lastFull?.atZone(zone)?.toLocalDate()
        val fullDue = policy.lastFull == null ||
            (lastFullDate?.isBefore(localNow.toLocalDate()) == true && !localNow.toLocalTime().isBefore(fullAt))
        val intervalDue = policy.lastAny == null ||
            !policy.lastAny.plus(policy.intervalMinutes.toLong(), ChronoUnit.MINUTES).isAfter(now)
        val kind = when {
            fullDue && policy.queuedKind != "full" -> "full"
            intervalDue && policy.queuedKind == null -> "incremental"
            else -> null
        } ?: return@forEach
        val scheduledFor = if (kind == "full") {
            if (policy.lastFull == null) now else ZonedDateTime.of(localNow.toLocalDate(), fullAt, zone).toInstant()
        } else {
            val intervalSeconds = policy.intervalMinutes * 60L
            Instant.ofEpochSecond((now.epochSecond / intervalSeconds) * intervalSeconds)
        }
        connection.prepareStatement(
            """
            INSERT INTO feedback.backup_runs (
                id, tenant_id, application_id, environment_id, workspace_id, kind, scheduled_for,
                from_change_sequence, from_audit_sequence, include_evidence
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?::timestamptz, ?, ?, ?)
            ON CONFLICT (workspace_id, kind, scheduled_for) DO NOTHING
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, UUID.randomUUID().toString())
            statement.setString(2, policy.tenantId)
            statement.setString(3, policy.applicationId)
            statement.setString(4, policy.environmentId)
            statement.setString(5, policy.workspaceId)
            statement.setString(6, kind)
            statement.setString(7, scheduledFor.toString())
            statement.setLong(8, if (kind == "full") 0 else policy.fromChangeSequence)
            statement.setLong(9, if (kind == "full") 0 else policy.fromAuditSequence)
            statement.setBoolean(10, policy.includeEvidence)
            scheduled += statement.executeUpdate()
        }
    }
    scheduled
}

fun FeedbackDatabase.claimBackup(): ClaimedBackup? = transaction { connection ->
    connection.prepareStatement(
        """
        SELECT run.id::text, run.tenant_id::text, run.application_id::text, run.workspace_id::text,
               run.kind, run.scheduled_for, run.from_change_sequence, run.from_audit_sequence,
               run.include_evidence, run.attempt_count
        FROM feedback.backup_runs run
        JOIN feedback.backup_policies policy ON policy.workspace_id = run.workspace_id
        WHERE (
                (run.status = 'queued' AND run.available_at <= now())
                OR (run.status = 'running' AND run.claimed_at < now() - interval '10 minutes')
              )
          AND NOT EXISTS (
              SELECT 1 FROM feedback.backup_runs active
              WHERE active.workspace_id = run.workspace_id
                AND active.status = 'running' AND active.id <> run.id
          )
        ORDER BY CASE run.kind WHEN 'full' THEN 0 ELSE 1 END, run.scheduled_for
        FOR UPDATE OF run, policy SKIP LOCKED LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            if (!result.next()) return@transaction null
            val token = UUID.randomUUID().toString()
            val claimed = ClaimedBackup(
                id = result.getString(1),
                tenantId = result.getString(2),
                applicationId = result.getString(3),
                workspaceId = result.getString(4),
                kind = result.getString(5),
                scheduledFor = result.getObject(6, OffsetDateTime::class.java).toInstant().toString(),
                fromChangeSequence = result.getLong(7),
                fromAuditSequence = result.getLong(8),
                includeEvidence = result.getBoolean(9),
                claimToken = token,
                attempt = result.getInt(10) + 1
            )
            connection.prepareStatement(
                """
                UPDATE feedback.backup_runs SET status = 'running', claim_token = ?::uuid,
                    claimed_at = now(), attempt_count = ?, error = NULL
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { update ->
                update.setString(1, token)
                update.setInt(2, claimed.attempt)
                update.setString(3, claimed.id)
                update.executeUpdate()
            }
            connection.recordBackupAudit(
                claimed,
                action = "backup.run.started",
                outcome = "succeeded",
                changes = kotlinx.serialization.json.buildJsonObject {
                    put("attempt", claimed.attempt)
                    put("kind", claimed.kind)
                    put("fromChangeSequence", claimed.fromChangeSequence)
                    put("fromAuditSequence", claimed.fromAuditSequence)
                }
            )
            claimed
        }
    }
}

fun FeedbackDatabase.prepareBackup(claimed: ClaimedBackup): PreparedBackupArchive = transaction { connection ->
    connection.transactionIsolation = Connection.TRANSACTION_REPEATABLE_READ
    val metadata = connection.prepareStatement(
        """
        SELECT tenant.tenant_key, application.application_key,
               COALESCE(string_agg(DISTINCT environment.environment_key, ',' ORDER BY environment.environment_key), ''),
               workspace.external_workspace_key,
               COALESCE(policy.retention_days, NULL),
               (SELECT recorded_at FROM feedback.system_metadata
                WHERE key = 'backup_history_coverage_started_at')
        FROM feedback.backup_runs run
        JOIN feedback.tenants tenant ON tenant.id = run.tenant_id
        JOIN feedback.applications application ON application.id = run.application_id
        JOIN feedback.workspaces workspace ON workspace.id = run.workspace_id
        LEFT JOIN feedback.feedback_threads thread ON thread.workspace_id = run.workspace_id
        LEFT JOIN feedback.application_environments environment ON environment.id = thread.environment_id
        LEFT JOIN feedback.backup_policies policy ON policy.workspace_id = run.workspace_id
        WHERE run.id = ?::uuid
        GROUP BY tenant.tenant_key, application.application_key, workspace.external_workspace_key, policy.retention_days
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, claimed.id)
        statement.executeQuery().use { result ->
            check(result.next())
            BackupMetadata(
                result.getString(1), result.getString(2), result.getString(3).ifBlank { "*" }, result.getString(4),
                result.getInt(5).let { if (result.wasNull()) null else it },
                result.getObject(6, OffsetDateTime::class.java).toInstant().toString()
            )
        }
    }
    val toChange = connection.maximumSequence(
        "feedback.feedback_change_journal", "workspace_id", claimed.workspaceId
    )
    val toAudit = connection.maximumSequence("feedback.audit_logs", "workspace_id", claimed.workspaceId)
    val full = claimed.kind == "full"
    val csv = listOf(
        connection.backupThreads(claimed, toChange, full),
        connection.backupMessages(claimed, toChange, full),
        connection.backupMessageVersions(claimed, toChange, full),
        connection.backupStatusEvents(claimed, toChange, full),
        connection.backupAudits(claimed, toAudit)
    )
    val (evidenceCsv, evidenceEntries) = connection.backupEvidence(claimed, toChange, full)
    PreparedBackupArchive(
        runId = claimed.id,
        kind = claimed.kind,
        scheduledFor = claimed.scheduledFor,
        tenantKey = metadata.tenantKey,
        applicationKey = metadata.applicationKey,
        environmentKey = metadata.environmentKeys,
        externalWorkspaceKey = metadata.externalWorkspaceKey,
        fromChangeSequence = claimed.fromChangeSequence,
        toChangeSequence = toChange,
        fromAuditSequence = claimed.fromAuditSequence,
        toAuditSequence = toAudit,
        historyCoverageStartedAt = metadata.historyCoverageStartedAt,
        includeEvidence = claimed.includeEvidence,
        csvEntries = csv + evidenceCsv,
        evidenceEntries = evidenceEntries,
        retentionDays = metadata.retentionDays
    )
}

fun FeedbackDatabase.completeBackup(
    claimed: ClaimedBackup,
    prepared: PreparedBackupArchive,
    objectKey: String,
    archive: BackupArchiveResult
) = transaction { connection ->
    connection.prepareStatement(
        """
        UPDATE feedback.backup_runs SET status = 'completed', object_key = ?, archive_sha256 = ?,
            archive_bytes = ?, entry_counts = ?::jsonb, to_change_sequence = ?, to_audit_sequence = ?,
            history_coverage_started_at = ?::timestamptz,
            expires_at = CASE WHEN ? IS NULL THEN NULL ELSE now() + (? * interval '1 day') END,
            completed_at = now(), claim_token = NULL, error = NULL
        WHERE id = ?::uuid AND status = 'running' AND claim_token = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, objectKey)
        statement.setString(2, archive.sha256)
        statement.setLong(3, archive.byteSize)
        statement.setString(4, serviceJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), kotlinx.serialization.json.buildJsonObject {
            archive.entryCounts.forEach { (key, value) -> put(key, value) }
        }))
        statement.setLong(5, prepared.toChangeSequence)
        statement.setLong(6, prepared.toAuditSequence)
        statement.setString(7, prepared.historyCoverageStartedAt)
        if (prepared.retentionDays == null) {
            statement.setNull(8, Types.INTEGER)
            statement.setNull(9, Types.INTEGER)
        } else {
            statement.setInt(8, prepared.retentionDays)
            statement.setInt(9, prepared.retentionDays)
        }
        statement.setString(10, claimed.id)
        statement.setString(11, claimed.claimToken)
        check(statement.executeUpdate() == 1) { "backup run の完了状態を更新できません" }
    }
    if (claimed.kind == "full") {
        connection.prepareStatement(
            """
            UPDATE feedback.backup_runs SET status = 'superseded', error = 'completed full backup superseded this run'
            WHERE workspace_id = ?::uuid AND kind = 'incremental' AND status = 'queued'
              AND scheduled_for <= now()
            """.trimIndent()
        ).use { statement -> statement.setString(1, claimed.workspaceId); statement.executeUpdate() }
    }
    connection.recordBackupAudit(
        claimed,
        action = "backup.run.completed",
        outcome = "succeeded",
        changes = kotlinx.serialization.json.buildJsonObject {
            put("objectKey", objectKey)
            put("archiveSha256", archive.sha256)
            put("archiveBytes", archive.byteSize)
            put("toChangeSequence", prepared.toChangeSequence)
            put("toAuditSequence", prepared.toAuditSequence)
            put("entryCounts", kotlinx.serialization.json.buildJsonObject {
                archive.entryCounts.forEach { (key, value) -> put(key, value) }
            })
        }
    )
}

fun FeedbackDatabase.failBackup(claimed: ClaimedBackup, error: String, maxAttempts: Int = 5) = transaction { connection ->
    val terminal = claimed.attempt >= maxAttempts
    val delaySeconds = minOf(3600, 1 shl minOf(claimed.attempt, 10))
    connection.prepareStatement(
        """
        UPDATE feedback.backup_runs SET status = ?, available_at = now() + (? * interval '1 second'),
            claim_token = NULL, error = ?
        WHERE id = ?::uuid AND claim_token = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, if (terminal) "failed" else "queued")
        statement.setInt(2, delaySeconds)
        statement.setString(3, error.take(2000))
        statement.setString(4, claimed.id)
        statement.setString(5, claimed.claimToken)
        statement.executeUpdate()
    }
    connection.recordBackupAudit(
        claimed,
        action = "backup.run.failed",
        outcome = "failed",
        changes = kotlinx.serialization.json.buildJsonObject {
            put("attempt", claimed.attempt)
            put("terminal", terminal)
            put("error", error.take(2000))
        }
    )
}

fun FeedbackDatabase.listBackups(scope: ResourceScope, limit: Int, offset: Int = 0): FeedbackBackupRunPage =
    dataSource.connection.use { connection ->
        val rows = connection.prepareStatement(
            "SELECT * FROM feedback.backup_runs WHERE workspace_id = ?::uuid ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.setInt(2, limit + 1)
            statement.setInt(3, offset)
            statement.executeQuery().use { result -> buildList { while (result.next()) add(readBackupRun(result)) } }
        }
        FeedbackBackupRunPage(
            items = rows.take(limit),
            nextCursor = if (rows.size > limit) encodeCursor(offset + limit) else null
        )
    }

fun FeedbackDatabase.getBackup(id: String): FeedbackBackupRun = dataSource.connection.use { connection ->
    connection.prepareStatement("SELECT * FROM feedback.backup_runs WHERE id = ?::uuid").use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result -> if (!result.next()) notFound(); readBackupRun(result) }
    }
}

fun FeedbackDatabase.getStoredBackup(id: String, storage: EvidenceStorage): StoredBackup =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT object_key, archive_sha256 FROM feedback.backup_runs
            WHERE id = ?::uuid AND status = 'completed' AND object_key IS NOT NULL
              AND (expires_at IS NULL OR expires_at > now())
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, id)
            statement.executeQuery().use { result ->
                if (!result.next()) notFound("backup file がないか期限切れです")
                val bytes = try { storage.get(result.getString(1)) } catch (_: Exception) {
                    throw FeedbackApiException(io.ktor.http.HttpStatusCode.ServiceUnavailable, "backup.storage_unavailable", "backup storage を読み取れません")
                }
                val expected = result.getString(2)
                if (sha256(bytes) != expected) {
                    throw FeedbackApiException(io.ktor.http.HttpStatusCode.ServiceUnavailable, "backup.integrity_error", "backup の整合性を確認できません")
                }
                StoredBackup("feedback-backup-$id.zip", bytes = bytes, sha256 = expected)
            }
        }
    }

fun FeedbackDatabase.retryBackup(scope: ResourceScope, id: String): FeedbackBackupRun = transaction { connection ->
    connection.prepareStatement(
        """
        UPDATE feedback.backup_runs SET status = 'queued', attempt_count = 0, available_at = now(), error = NULL
        WHERE id = ?::uuid AND workspace_id = ?::uuid AND status = 'failed'
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, id)
        statement.setString(2, scope.workspaceId)
        if (statement.executeUpdate() != 1) {
            val visible = connection.prepareStatement(
                "SELECT 1 FROM feedback.backup_runs WHERE id = ?::uuid AND workspace_id = ?::uuid"
            ).use { lookup ->
                lookup.setString(1, id)
                lookup.setString(2, scope.workspaceId)
                lookup.executeQuery().use { it.next() }
            }
            if (!visible) notFound()
            conflict("failed backupだけを再試行できます", "backup.not_failed")
        }
    }
    connection.prepareStatement("SELECT * FROM feedback.backup_runs WHERE id = ?::uuid").use { statement ->
        statement.setString(1, id)
        statement.executeQuery().use { result -> result.next(); readBackupRun(result) }
    }
}

private data class DueBackupPolicy(
    val workspaceId: String,
    val timezone: String,
    val fullAt: String,
    val intervalMinutes: Int,
    val includeEvidence: Boolean,
    val tenantId: String,
    val applicationId: String,
    val environmentId: String,
    val lastFull: Instant?,
    val lastAny: Instant?,
    val fromChangeSequence: Long,
    val fromAuditSequence: Long,
    val queuedKind: String?
)

private data class BackupMetadata(
    val tenantKey: String,
    val applicationKey: String,
    val environmentKeys: String,
    val externalWorkspaceKey: String,
    val retentionDays: Int?,
    val historyCoverageStartedAt: String
)

private fun ensureBackupPolicy(connection: Connection, workspaceId: String) {
    connection.prepareStatement(
        "INSERT INTO feedback.backup_policies (workspace_id) VALUES (?::uuid) ON CONFLICT DO NOTHING"
    ).use { statement -> statement.setString(1, workspaceId); statement.executeUpdate() }
}

private fun readBackupPolicy(connection: Connection, workspaceId: String): Pair<FeedbackBackupPolicy, Int> =
    connection.prepareStatement("SELECT * FROM feedback.backup_policies WHERE workspace_id = ?::uuid").use { statement ->
        statement.setString(1, workspaceId)
        statement.executeQuery().use { result ->
            check(result.next())
            FeedbackBackupPolicy(
                enabled = result.getBoolean("enabled"),
                timezone = result.getString("timezone"),
                fullBackupAt = result.getString("full_backup_at").take(5),
                incrementalIntervalMinutes = result.getInt("incremental_interval_minutes"),
                includeEvidence = result.getBoolean("include_evidence"),
                retentionDays = result.getInt("retention_days").let { if (result.wasNull()) null else it }
            ) to result.getInt("version")
        }
    }

private fun readBackupPolicyView(
    connection: Connection,
    workspaceId: String,
    policy: FeedbackBackupPolicy,
    now: Instant
): FeedbackBackupPolicyView {
    val last = connection.prepareStatement(
        """
        SELECT completed_at, to_change_sequence, to_audit_sequence
        FROM feedback.backup_runs
        WHERE workspace_id = ?::uuid AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, workspaceId)
        statement.executeQuery().use { result ->
            if (!result.next()) null else Triple(
                result.getObject(1, OffsetDateTime::class.java).toInstant(),
                result.getLong(2),
                result.getLong(3)
            )
        }
    }
    if (!policy.enabled) {
        return FeedbackBackupPolicyView(
            policy = policy,
            lastSuccessfulAt = last?.first?.toString(),
            changeCursor = last?.second ?: 0,
            auditCursor = last?.third ?: 0
        )
    }
    val zone = ZoneId.of(policy.timezone)
    val localNow = now.atZone(zone)
    val fullTime = LocalTime.parse(policy.fullBackupAt)
    var nextFull = ZonedDateTime.of(localNow.toLocalDate(), fullTime, zone).toInstant()
    if (!nextFull.isAfter(now)) nextFull = nextFull.plus(1, ChronoUnit.DAYS)
    val nextIncremental = last?.first?.plus(policy.incrementalIntervalMinutes.toLong(), ChronoUnit.MINUTES) ?: now
    val next = minOf(nextFull, nextIncremental)
    return FeedbackBackupPolicyView(
        policy = policy,
        nextExecutionAt = next.toString(),
        nextFullAt = nextFull.toString(),
        nextIncrementalAt = nextIncremental.toString(),
        lastSuccessfulAt = last?.first?.toString(),
        changeCursor = last?.second ?: 0,
        auditCursor = last?.third ?: 0
    )
}

private fun validateBackupPolicy(value: FeedbackBackupPolicy) {
    runCatching { ZoneId.of(value.timezone) }.getOrElse { badRequest("timezone はIANA timezone IDで指定してください") }
    runCatching { LocalTime.parse(value.fullBackupAt) }.getOrElse { badRequest("fullBackupAt は HH:mm で指定してください") }
    if (value.incrementalIntervalMinutes !in 15..1440) badRequest("incrementalIntervalMinutes は15..1440です")
    if (value.retentionDays != null && value.retentionDays !in 1..3650) badRequest("retentionDays は1..3650です")
}

private fun Connection.maximumSequence(table: String, scopeColumn: String, workspaceId: String): Long =
    prepareStatement("SELECT COALESCE(max(sequence), 0) FROM $table WHERE $scopeColumn = ?::uuid").use { statement ->
        statement.setString(1, workspaceId)
        statement.executeQuery().use { result -> result.next(); result.getLong(1) }
    }

private val changedThreadsCte =
    """
    WITH changed_threads AS (
        SELECT DISTINCT CASE
            WHEN resource_type = 'thread' THEN resource_id::uuid
            ELSE NULLIF(payload->>'threadId', '')::uuid
        END AS thread_id
        FROM feedback.feedback_change_journal
        WHERE workspace_id = ?::uuid AND sequence > ? AND sequence <= ?
    )
    """.trimIndent()

private val changedMessagesCte =
    """
    WITH changed_messages AS (
        SELECT DISTINCT resource_id::uuid AS message_id
        FROM feedback.feedback_change_journal
        WHERE workspace_id = ?::uuid AND sequence > ? AND sequence <= ?
          AND resource_type = 'message'
          AND event_type IN ('feedback.message.created.v1', 'feedback.message.updated.v1')
    )
    """.trimIndent()

private val changedMessageVersionsCte =
    """
    WITH changed_message_events AS (
        SELECT resource_id::uuid AS message_id, event_type,
               NULLIF(payload->>'fromVersion', '')::integer AS from_version
        FROM feedback.feedback_change_journal
        WHERE workspace_id = ?::uuid AND sequence > ? AND sequence <= ?
          AND resource_type = 'message'
          AND event_type IN ('feedback.message.created.v1', 'feedback.message.updated.v1')
    ), changed_messages AS (
        SELECT DISTINCT message_id FROM changed_message_events
    )
    """.trimIndent()

private val changedEvidenceThreadsCte =
    """
    WITH changed_evidence_threads AS (
        SELECT DISTINCT resource_id::uuid AS thread_id
        FROM feedback.feedback_change_journal
        WHERE workspace_id = ?::uuid AND sequence > ? AND sequence <= ?
          AND resource_type = 'thread' AND event_type = 'feedback.thread.created.v1'
          AND COALESCE((payload->>'evidenceIncluded')::boolean, false)
    )
    """.trimIndent()

private fun Connection.backupThreads(claimed: ClaimedBackup, upper: Long, full: Boolean): BackupCsvEntry {
    val prefix = if (full) "" else changedThreadsCte
    val filter = if (full) "" else "AND thread.id IN (SELECT thread_id FROM changed_threads WHERE thread_id IS NOT NULL)"
    return csvQuery(
        "threads.csv",
        listOf("thread_id", "session_id", "environment_key", "display_number", "status", "perspective_code", "location_json", "target_json", "reporter_principal_id", "reporter_display_name", "reporter_participant_name", "version", "created_at", "updated_at"),
        "$prefix SELECT thread.id::text, thread.session_id::text, environment.environment_key, thread.display_number::text, thread.status, thread.perspective_code, thread.location::text, thread.target::text, thread.reporter_principal_id, thread.reporter_display_name, thread.reporter_participant_name, thread.version::text, thread.created_at::text, thread.updated_at::text FROM feedback.feedback_threads thread JOIN feedback.application_environments environment ON environment.id = thread.environment_id WHERE thread.workspace_id = ?::uuid $filter ORDER BY thread.created_at, thread.id",
        if (full) listOf(claimed.workspaceId) else listOf(claimed.workspaceId, claimed.fromChangeSequence, upper, claimed.workspaceId)
    )
}

private fun Connection.backupMessages(claimed: ClaimedBackup, upper: Long, full: Boolean): BackupCsvEntry {
    val prefix = if (full) "" else changedMessagesCte
    val filter = if (full) "" else "AND message.id IN (SELECT message_id FROM changed_messages)"
    return csvQuery(
        "messages.csv",
        listOf("message_id", "thread_id", "author_principal_id", "author_display_name", "author_participant_name", "body", "version", "created_at", "edited_at"),
        "$prefix SELECT message.id::text, message.thread_id::text, message.author_principal_id, message.author_display_name, message.author_participant_name, message.body, message.version::text, message.created_at::text, message.edited_at::text FROM feedback.feedback_messages message JOIN feedback.feedback_threads thread ON thread.id = message.thread_id WHERE thread.workspace_id = ?::uuid $filter ORDER BY message.created_at, message.id",
        if (full) listOf(claimed.workspaceId) else listOf(claimed.workspaceId, claimed.fromChangeSequence, upper, claimed.workspaceId)
    )
}

private fun Connection.backupMessageVersions(claimed: ClaimedBackup, upper: Long, full: Boolean): BackupCsvEntry {
    if (!full) {
        return csvQuery(
            "message_versions.csv",
            listOf("message_id", "thread_id", "version", "current", "author_principal_id", "author_display_name", "author_participant_name", "body", "created_at", "edited_at"),
            "$changedMessageVersionsCte " +
                "SELECT version.message_id::text, version.thread_id::text, version.version::text, 'false', version.author_principal_id, version.author_display_name, version.author_participant_name, version.body, version.created_at::text, version.edited_at::text " +
                "FROM feedback.feedback_message_versions version JOIN changed_message_events event ON event.message_id = version.message_id AND event.event_type = 'feedback.message.updated.v1' AND event.from_version = version.version " +
                "UNION ALL SELECT message.id::text, message.thread_id::text, message.version::text, 'true', message.author_principal_id, message.author_display_name, message.author_participant_name, message.body, message.created_at::text, message.edited_at::text " +
                "FROM feedback.feedback_messages message JOIN changed_messages changed ON changed.message_id = message.id ORDER BY 2, 1, 3",
            listOf(claimed.workspaceId, claimed.fromChangeSequence, upper)
        )
    }
    return csvQuery(
        "message_versions.csv",
        listOf("message_id", "thread_id", "version", "current", "author_principal_id", "author_display_name", "author_participant_name", "body", "created_at", "edited_at"),
        "SELECT version.message_id::text, version.thread_id::text, version.version::text, 'false', version.author_principal_id, version.author_display_name, version.author_participant_name, version.body, version.created_at::text, version.edited_at::text FROM feedback.feedback_message_versions version JOIN feedback.feedback_threads thread ON thread.id = version.thread_id WHERE thread.workspace_id = ?::uuid UNION ALL SELECT message.id::text, message.thread_id::text, message.version::text, 'true', message.author_principal_id, message.author_display_name, message.author_participant_name, message.body, message.created_at::text, message.edited_at::text FROM feedback.feedback_messages message JOIN feedback.feedback_threads thread ON thread.id = message.thread_id WHERE thread.workspace_id = ?::uuid ORDER BY 2, 1, 3",
        listOf(claimed.workspaceId, claimed.workspaceId)
    )
}

private fun Connection.backupStatusEvents(claimed: ClaimedBackup, upper: Long, full: Boolean): BackupCsvEntry {
    return csvQuery(
        "status_events.csv",
        listOf("sequence", "thread_id", "event_type", "status", "occurred_at", "source"),
        "SELECT journal.sequence::text, journal.resource_id, journal.event_type, CASE journal.event_type WHEN 'feedback.thread.resolved.v1' THEN 'resolved' WHEN 'feedback.thread.reopened.v1' THEN 'open' ELSE 'open' END, journal.occurred_at::text, 'journal' FROM feedback.feedback_change_journal journal WHERE journal.workspace_id = ?::uuid AND journal.sequence > ? AND journal.sequence <= ? AND journal.event_type IN ('feedback.thread.created.v1', 'feedback.thread.resolved.v1', 'feedback.thread.reopened.v1') ORDER BY journal.occurred_at, journal.sequence",
        listOf(claimed.workspaceId, if (full) 0L else claimed.fromChangeSequence, upper)
    )
}

private fun Connection.backupAudits(claimed: ClaimedBackup, upper: Long): BackupCsvEntry = csvQuery(
    "audit_logs.csv",
    listOf("sequence", "audit_id", "principal_id", "action", "resource_type", "resource_id", "outcome", "request_id", "changes_json", "occurred_at"),
    "SELECT sequence::text, id::text, principal_id, action, resource_type, resource_id, outcome, request_id, changes::text, occurred_at::text FROM feedback.audit_logs WHERE workspace_id = ?::uuid AND sequence > ? AND sequence <= ? ORDER BY sequence",
    listOf(claimed.workspaceId, claimed.fromAuditSequence, upper)
)

private fun Connection.backupEvidence(
    claimed: ClaimedBackup,
    upper: Long,
    full: Boolean
): Pair<BackupCsvEntry, List<BackupEvidenceEntry>> {
    val prefix = if (full) "" else changedEvidenceThreadsCte
    val filter = if (full) "" else "AND thread.id IN (SELECT thread_id FROM changed_evidence_threads)"
    val sql = "$prefix SELECT evidence.id::text, evidence.thread_id::text, evidence.object_key, evidence.content_type, evidence.byte_size::text, evidence.sha256, evidence.viewport_width::text, evidence.viewport_height::text, evidence.pixel_ratio::text, evidence.captured_at::text, evidence.created_at::text FROM feedback.review_evidence evidence JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id WHERE thread.workspace_id = ?::uuid $filter ORDER BY evidence.created_at, evidence.id"
    val params = if (full) listOf(claimed.workspaceId) else listOf(claimed.workspaceId, claimed.fromChangeSequence, upper, claimed.workspaceId)
    val rows = queryRows(sql, params)
    val archiveRows = rows.map { row ->
        val extension = if (row[3] == "image/webp") "webp" else "png"
        row + "evidence/${row[1]}.$extension"
    }
    val csv = BackupCsvEntry(
        "evidence.csv",
        listOf("evidence_id", "thread_id", "object_key", "content_type", "byte_size", "sha256", "viewport_width", "viewport_height", "pixel_ratio", "captured_at", "created_at", "archive_path"),
        archiveRows
    )
    val entries = archiveRows.map { row -> BackupEvidenceEntry(requireNotNull(row[11]), requireNotNull(row[2]), requireNotNull(row[3]), requireNotNull(row[5])) }
    return csv to entries
}

private fun Connection.csvQuery(path: String, header: List<String>, sql: String, params: List<Any?>): BackupCsvEntry =
    BackupCsvEntry(path, header, queryRows(sql, params))

private fun Connection.queryRows(sql: String, params: List<Any?>): List<List<String?>> =
    prepareStatement(sql).use { statement ->
        params.forEachIndexed { index, value -> statement.bind(index + 1, value) }
        statement.executeQuery().use { result ->
            val columns = result.metaData.columnCount
            buildList { while (result.next()) add((1..columns).map(result::getString)) }
        }
    }

private fun PreparedStatement.bind(index: Int, value: Any?) = when (value) {
    null -> setNull(index, Types.VARCHAR)
    is Long -> setLong(index, value)
    is Int -> setInt(index, value)
    is Boolean -> setBoolean(index, value)
    else -> setString(index, value.toString())
}

private fun Connection.recordBackupAudit(
    claimed: ClaimedBackup,
    action: String,
    outcome: String,
    changes: kotlinx.serialization.json.JsonObject
) {
    prepareStatement(
        """
        INSERT INTO feedback.audit_logs (
            id, tenant_id, application_id, workspace_id, principal_id, action,
            resource_type, resource_id, outcome, request_id, changes
        ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, NULL, ?, 'backup', ?, ?, ?, ?::jsonb)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, claimed.tenantId)
        statement.setString(3, claimed.applicationId)
        statement.setString(4, claimed.workspaceId)
        statement.setString(5, action)
        statement.setString(6, claimed.id)
        statement.setString(7, outcome)
        statement.setString(8, "backup-worker:${claimed.id}:${claimed.attempt}:$action")
        statement.setString(9, sanitizeAuditChanges(changes)?.toString())
        statement.executeUpdate()
    }
}

private fun readBackupRun(result: ResultSet): FeedbackBackupRun {
    val status = result.getString("status")
    val expiresAt = result.getObject("expires_at", OffsetDateTime::class.java)?.toInstant()?.toString()
    val counts = result.getString("entry_counts")?.let { raw ->
        serviceJson.parseToJsonElement(raw).jsonObject.mapValues { (_, value) -> value.jsonPrimitive.long }
    }
    return FeedbackBackupRun(
        id = result.getString("id"),
        kind = result.getString("kind"),
        status = status,
        scheduledFor = result.getObject("scheduled_for", OffsetDateTime::class.java).toInstant().toString(),
        downloadUrl = if (status == "completed" && (expiresAt == null || Instant.parse(expiresAt).isAfter(Instant.now()))) "/feedback/v1/backups/${result.getString("id")}/download" else null,
        fromChangeSequence = result.getLong("from_change_sequence"),
        toChangeSequence = result.getLong("to_change_sequence").let { if (result.wasNull()) null else it },
        fromAuditSequence = result.getLong("from_audit_sequence"),
        toAuditSequence = result.getLong("to_audit_sequence").let { if (result.wasNull()) null else it },
        archiveSha256 = result.getString("archive_sha256"),
        archiveBytes = result.getLong("archive_bytes").let { if (result.wasNull()) null else it },
        entryCounts = counts,
        historyCoverageStartedAt = result.getObject("history_coverage_started_at", OffsetDateTime::class.java).toInstant().toString(),
        expiresAt = expiresAt,
        completedAt = result.getObject("completed_at", OffsetDateTime::class.java)?.toInstant()?.toString(),
        createdAt = result.getObject("created_at", OffsetDateTime::class.java).toInstant().toString(),
        error = result.getString("error")
    )
}
