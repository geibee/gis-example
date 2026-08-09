package feedback.service

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.Connection
import java.sql.Types
import java.util.Base64
import java.util.UUID

@Serializable
data class LegacyFeedbackSnapshot(
    val schemaVersion: String = "1",
    val sourceSystem: String,
    val applicationKey: String,
    val environmentKey: String,
    val externalWorkspaceKey: String,
    val manifestVersion: String,
    val projectEvidenceRetentionDays: Int? = null,
    val sessions: List<LegacySessionSnapshot>,
    val threads: List<LegacyThreadSnapshot>,
    val messages: List<LegacyMessageSnapshot>,
    val messageVersions: List<LegacyMessageVersionSnapshot>,
    val evidence: List<LegacyEvidenceSnapshot> = emptyList(),
    val audits: List<LegacyAuditSnapshot> = emptyList(),
    val outbox: List<LegacyOutboxSnapshot> = emptyList()
)

@Serializable
data class LegacySessionSnapshot(
    val id: String,
    val title: String,
    val description: String? = null,
    val status: String,
    val startAt: String? = null,
    val endAt: String? = null,
    val createdBy: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val evidenceRetentionDays: Int? = null,
    val scopes: List<LegacyScopeSnapshot>,
    val perspectives: List<LegacyPerspectiveSnapshot>
)

@Serializable
data class LegacyScopeSnapshot(
    val id: String,
    val pageId: String,
    val route: String? = null,
    val reviewable: Boolean,
    val displayOrder: Int = 0
)

@Serializable
data class LegacyPerspectiveSnapshot(
    val code: String,
    val label: String,
    val status: String,
    val guidance: String? = null,
    val displayOrder: Int = 0
)

@Serializable
data class LegacyThreadSnapshot(
    val id: String,
    val reviewSessionId: String,
    val displayNumber: Int,
    val pageId: String,
    val pageRoute: String? = null,
    val perspectiveCode: String,
    val targetType: String,
    val targetMetadata: JsonObject,
    val evidenceId: String? = null,
    val status: String,
    val reporterPrincipalId: String,
    val reporterDisplayName: String? = null,
    val reporterName: String? = null,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class LegacyMessageSnapshot(
    val id: String,
    val threadId: String,
    val authorPrincipalId: String,
    val authorDisplayName: String? = null,
    val participantName: String? = null,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null
)

@Serializable
data class LegacyMessageVersionSnapshot(
    val messageId: String,
    val version: Int,
    val body: String,
    val editorPrincipalId: String,
    val editorDisplayName: String? = null,
    val editorParticipantName: String? = null,
    val createdAt: String
)

@Serializable
data class LegacyEvidenceSnapshot(
    val id: String,
    val dataBase64: String,
    val contentType: String,
    val sha256: String,
    val viewportWidth: Int,
    val viewportHeight: Int,
    val pixelRatio: Double,
    val capturedAt: String,
    val createdAt: String,
    val expiresAt: String? = null,
    val legacyObjectReference: String
)

@Serializable
data class LegacyAuditSnapshot(
    val id: String,
    val principalId: String? = null,
    val action: String,
    val resourceType: String? = null,
    val resourceId: String? = null,
    val outcome: String,
    val requestId: String,
    val changes: JsonObject? = null,
    val occurredAt: String
)

@Serializable
data class LegacyOutboxSnapshot(
    val id: String,
    val reviewSessionId: String,
    val threadId: String,
    val messageId: String? = null,
    val eventType: String,
    val actorPrincipalId: String? = null,
    val createdAt: String
)

@Serializable
data class LegacyMigrationReport(
    val runId: String,
    val sourceChecksum: String,
    val dryRun: Boolean,
    val sessions: Int,
    val threads: Int,
    val messages: Int,
    val messageVersions: Int,
    val evidence: Int,
    val audits: Int,
    val outbox: Int,
    val differences: List<String> = emptyList()
)

private data class LegacyMigrationScope(
    val tenantId: String,
    val applicationId: String,
    val environmentId: String,
    val workspaceId: String,
    val manifest: JsonObject
)

private data class MappedLegacyThread(val source: LegacyThreadSnapshot, val location: JsonObject, val target: JsonObject)

class LegacyFeedbackMigration(
    private val database: FeedbackDatabase,
    private val storage: EvidenceStorage,
    private val evidencePrefix: String = "evidence/migration/"
) {
    fun dryRun(snapshot: LegacyFeedbackSnapshot): LegacyMigrationReport =
        plan(snapshot, UUID.randomUUID().toString(), dryRun = true).second

    fun apply(snapshot: LegacyFeedbackSnapshot, runId: String = UUID.randomUUID().toString()): LegacyMigrationReport {
        UUID.fromString(runId)
        val (plan, report) = plan(snapshot, runId, dryRun = false)
        val copiedKeys = mutableListOf<String>()
        try {
            snapshot.evidence.forEach { evidence ->
                val bytes = Base64.getDecoder().decode(evidence.dataBase64)
                val objectKey = evidenceObjectKey(runId, evidence.id)
                storage.put(objectKey, evidence.contentType, bytes)
                copiedKeys += objectKey
            }
            database.transaction { connection -> insertPlan(connection, snapshot, plan, report) }
            return report
        } catch (exception: Exception) {
            copiedKeys.forEach { storage.delete(it) }
            throw exception
        }
    }

    fun reconcile(snapshot: LegacyFeedbackSnapshot, runId: String): LegacyMigrationReport {
        val (_, expected) = plan(snapshot, runId, dryRun = false, preflightDatabase = false)
        validateAppliedRun(runId, expected.sourceChecksum)
        val differences = database.dataSource.connection.use { connection ->
            buildList {
                compareCount(connection, "review_sessions", "id", snapshot.sessions.map { it.id }, "session", this)
                compareCount(connection, "feedback_threads", "id", snapshot.threads.map { it.id }, "thread", this)
                compareCount(connection, "feedback_messages", "id", snapshot.messages.map { it.id }, "message", this)
                compareCount(connection, "review_evidence", "id", snapshot.evidence.map { it.id }, "evidence", this)
                compareDescendantCount(connection, snapshot.sessions.map { it.id }, snapshot, this)
                snapshot.sessions.forEach { session ->
                    connection.prepareStatement(
                        "SELECT title, status FROM feedback.review_sessions WHERE id = ?::uuid"
                    ).use { statement ->
                        statement.setString(1, session.id)
                        statement.executeQuery().use { result ->
                            if (result.next() &&
                                (result.getString(1) != session.title || result.getString(2) != session.status.lowercase())) {
                                add("session ${session.id}: title/status が一致しません")
                            }
                        }
                    }
                }
                snapshot.threads.forEach { thread ->
                    connection.prepareStatement(
                        "SELECT display_number, status FROM feedback.feedback_threads WHERE id = ?::uuid"
                    ).use { statement ->
                        statement.setString(1, thread.id)
                        statement.executeQuery().use { result ->
                            if (result.next() &&
                                (result.getInt(1) != thread.displayNumber || result.getString(2) != thread.status.lowercase())) {
                                add("thread ${thread.id}: displayNumber/status が一致しません")
                            }
                        }
                    }
                }
                snapshot.evidence.forEach { evidence ->
                    connection.prepareStatement("SELECT sha256 FROM feedback.review_evidence WHERE id = ?::uuid").use { statement ->
                        statement.setString(1, evidence.id)
                        statement.executeQuery().use { result ->
                            if (result.next() && result.getString(1) != evidence.sha256) {
                                add("evidence ${evidence.id}: SHA-256 が一致しません")
                            }
                        }
                    }
                }
                val historyCount = scalarCount(
                    connection,
                    "feedback.feedback_message_versions",
                    "message_id",
                    snapshot.messageVersions.map { it.messageId }.distinct()
                )
                if (historyCount != snapshot.messageVersions.size.toLong()) {
                    add("message history: expected=${snapshot.messageVersions.size}, actual=$historyCount")
                }
            }
        }
        return expected.copy(differences = differences)
    }

    private fun validateAppliedRun(runId: String, expectedChecksum: String) {
        database.dataSource.connection.use { connection ->
            connection.prepareStatement(
                "SELECT source_checksum, status FROM feedback_migration.legacy_migration_runs WHERE id = ?::uuid"
            ).use { statement ->
                statement.setString(1, runId)
                statement.executeQuery().use { result ->
                    require(result.next()) { "migration run がありません" }
                    require(result.getString(1) == expectedChecksum) { "migration run と snapshot が一致しません" }
                    require(result.getString(2) == "applied") { "migration run は適用中ではありません" }
                }
            }
        }
    }

    fun rollback(snapshot: LegacyFeedbackSnapshot, runId: String): LegacyMigrationReport {
        val reconciliation = reconcile(snapshot, runId)
        require(reconciliation.differences.isEmpty()) {
            "コピー後に差分があるため rollback を拒否しました: ${reconciliation.differences.joinToString()}"
        }
        val objectKeys = database.transaction { connection ->
            val status = connection.prepareStatement(
                "SELECT status FROM feedback_migration.legacy_migration_runs WHERE id = ?::uuid FOR UPDATE"
            ).use { statement ->
                statement.setString(1, runId)
                statement.executeQuery().use { result -> require(result.next()) { "migration run がありません" }; result.getString(1) }
            }
            require(status == "applied") { "migration run は rollback 済みです" }
            val keys = migrationEntities(connection, runId, "evidence-object")
            deleteMigrationEntities(connection, runId, "audit", "feedback.audit_logs")
            deleteMigrationEntities(connection, runId, "outbox", "feedback.notification_outbox")
            deleteMigrationEntities(connection, runId, "session", "feedback.review_sessions")
            migrationEntities(connection, runId, "retention-policy").forEach { workspaceId ->
                connection.prepareStatement(
                    "DELETE FROM feedback.retention_policies WHERE workspace_id = ?::uuid"
                ).use { statement -> statement.setString(1, workspaceId); statement.executeUpdate() }
            }
            connection.prepareStatement(
                "UPDATE feedback_migration.legacy_migration_runs SET status = 'rolled-back', rolled_back_at = now() WHERE id = ?::uuid"
            ).use { statement -> statement.setString(1, runId); statement.executeUpdate() }
            keys
        }
        objectKeys.forEach { storage.delete(it) }
        return reconciliation.copy(differences = emptyList())
    }

    private fun plan(
        snapshot: LegacyFeedbackSnapshot,
        runId: String = UUID.nameUUIDFromBytes(
            "${snapshot.sourceSystem}:${snapshotChecksum(snapshot)}".toByteArray(StandardCharsets.UTF_8)
        ).toString(),
        dryRun: Boolean,
        preflightDatabase: Boolean = true
    ): Pair<List<MappedLegacyThread>, LegacyMigrationReport> {
        require(snapshot.schemaVersion == "1") { "未対応の legacy snapshot schemaVersion です" }
        require(snapshot.sourceSystem.isNotBlank()) { "sourceSystem が必要です" }
        val scope = resolveScope(snapshot)
        validateIdsAndRelations(snapshot)
        val mapped = snapshot.threads.map { thread ->
            MappedLegacyThread(thread, mapLocation(thread, snapshot, scope.manifest), mapTarget(thread))
        }
        snapshot.evidence.forEach { evidence ->
            val bytes = try { Base64.getDecoder().decode(evidence.dataBase64) } catch (_: IllegalArgumentException) {
                error("evidence ${evidence.id}: base64 が不正です")
            }
            require(sha256(bytes) == evidence.sha256) { "evidence ${evidence.id}: SHA-256 が一致しません" }
            decodeEvidence(
                EvidenceCreateRequest(
                    evidence.contentType, evidence.dataBase64, evidence.viewportWidth,
                    evidence.viewportHeight, evidence.pixelRatio, evidence.capturedAt
                ),
                20L * 1024 * 1024
            )
        }
        if (preflightDatabase) requireNoCollisions(snapshot, runId)
        val checksum = snapshotChecksum(snapshot)
        return mapped to LegacyMigrationReport(
            runId, checksum, dryRun, snapshot.sessions.size, snapshot.threads.size,
            snapshot.messages.size, snapshot.messageVersions.size, snapshot.evidence.size,
            snapshot.audits.size, snapshot.outbox.size
        )
    }

    private fun resolveScope(snapshot: LegacyFeedbackSnapshot): LegacyMigrationScope =
        database.dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                SELECT t.id::text, a.id::text, e.id::text, w.id::text, m.manifest
                FROM feedback.applications a
                JOIN feedback.tenants t ON t.id = a.tenant_id
                JOIN feedback.application_environments e ON e.application_id = a.id AND e.environment_key = ?
                JOIN feedback.workspaces w ON w.application_id = a.id AND w.external_workspace_key = ?
                JOIN feedback.application_manifests m ON m.application_id = a.id AND m.manifest_version = ?
                WHERE a.application_key = ?
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, snapshot.environmentKey)
                statement.setString(2, snapshot.externalWorkspaceKey)
                statement.setString(3, snapshot.manifestVersion)
                statement.setString(4, snapshot.applicationKey)
                statement.executeQuery().use { result ->
                    require(result.next()) { "対象 application/environment/workspace/manifest が provision 済みではありません" }
                    LegacyMigrationScope(
                        result.getString(1), result.getString(2), result.getString(3), result.getString(4),
                        serviceJson.parseToJsonElement(result.getString(5)).jsonObject
                    )
                }
            }
        }

    private fun insertPlan(
        connection: Connection,
        snapshot: LegacyFeedbackSnapshot,
        plan: List<MappedLegacyThread>,
        report: LegacyMigrationReport
    ) {
        val scope = resolveScope(snapshot)
        connection.prepareStatement(
            """
            INSERT INTO feedback_migration.legacy_migration_runs (
                id, source_system, source_checksum, application_id, environment_id, workspace_id, status, summary
            ) VALUES (?::uuid, ?, ?, ?::uuid, ?::uuid, ?::uuid, 'applied', ?::jsonb)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, report.runId); statement.setString(2, snapshot.sourceSystem)
            statement.setString(3, report.sourceChecksum); statement.setString(4, scope.applicationId)
            statement.setString(5, scope.environmentId); statement.setString(6, scope.workspaceId)
            statement.setString(7, serviceJson.encodeToString(report)); statement.executeUpdate()
        }
        snapshot.sessions.forEach { insertSession(connection, it, snapshot, scope) }
        plan.forEach { insertThread(connection, it, scope) }
        snapshot.messages.forEach { insertMessage(connection, it, snapshot.messageVersions) }
        snapshot.messageVersions.forEach { insertMessageVersion(connection, it, snapshot.messages) }
        snapshot.evidence.forEach { insertEvidence(connection, it, snapshot, report.runId) }
        snapshot.audits.forEach { insertAudit(connection, it, scope) }
        snapshot.outbox.forEach { insertOutbox(connection, it, scope) }
        if (insertRetentionPolicy(connection, snapshot.projectEvidenceRetentionDays, scope.workspaceId)) {
            track(connection, report.runId, "retention-policy", scope.workspaceId)
        }
        snapshot.sessions.forEach { track(connection, report.runId, "session", it.id) }
        snapshot.evidence.forEach { track(connection, report.runId, "evidence-object", evidenceObjectKey(report.runId, it.id)) }
        snapshot.audits.forEach { track(connection, report.runId, "audit", it.id) }
        snapshot.outbox.forEach { track(connection, report.runId, "outbox", it.id) }
    }

    private fun insertRetentionPolicy(connection: Connection, days: Int?, workspaceId: String): Boolean {
        if (days == null) return false
        val existing = connection.prepareStatement(
            "SELECT evidence_retention_days FROM feedback.retention_policies WHERE workspace_id = ?::uuid"
        ).use { statement ->
            statement.setString(1, workspaceId)
            statement.executeQuery().use { result ->
                if (!result.next()) null else result.getInt(1).let { if (result.wasNull()) -1 else it }
            }
        }
        if (existing != null) {
            require(existing == days) { "既存 workspace retention policy と snapshot が一致しません" }
            return false
        }
        connection.prepareStatement(
            "INSERT INTO feedback.retention_policies (workspace_id, evidence_retention_days) VALUES (?::uuid, ?)"
        ).use { statement ->
            statement.setString(1, workspaceId); statement.setInt(2, days); statement.executeUpdate()
        }
        return true
    }

    private fun insertSession(connection: Connection, value: LegacySessionSnapshot, snapshot: LegacyFeedbackSnapshot, scope: LegacyMigrationScope) {
        connection.prepareStatement(
            """
            INSERT INTO feedback.review_sessions (
                id, tenant_id, application_id, environment_id, workspace_id, manifest_version, title,
                description, status, out_of_scope_posting, start_at, end_at, created_by, created_at,
                updated_at, evidence_retention_days
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, 'warn',
                      ?::timestamptz, ?::timestamptz, ?, ?::timestamptz, ?::timestamptz, ?)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, scope.tenantId)
            statement.setString(3, scope.applicationId); statement.setString(4, scope.environmentId)
            statement.setString(5, scope.workspaceId); statement.setString(6, snapshot.manifestVersion)
            statement.setString(7, value.title); statement.setString(8, value.description)
            statement.setString(9, value.status.lowercase()); statement.setString(10, value.startAt)
            statement.setString(11, value.endAt); statement.setString(12, value.createdBy ?: "legacy:unknown")
            statement.setString(13, value.createdAt); statement.setString(14, value.updatedAt)
            setNullableInt(statement, 15, value.evidenceRetentionDays); statement.executeUpdate()
        }
        value.scopes.sortedBy { it.displayOrder }.forEach { scopeValue ->
            connection.prepareStatement(
                "INSERT INTO feedback.review_scopes (id, session_id, page_key, route_template, reviewable) VALUES (?::uuid, ?::uuid, ?, ?, ?)"
            ).use { statement ->
                statement.setString(1, scopeValue.id); statement.setString(2, value.id)
                statement.setString(3, scopeValue.pageId); statement.setString(4, scopeValue.route)
                statement.setBoolean(5, scopeValue.reviewable); statement.executeUpdate()
            }
        }
        value.perspectives.sortedBy { it.displayOrder }.forEach { perspective ->
            connection.prepareStatement(
                """
                INSERT INTO feedback.review_session_perspectives (session_id, code, label, status, guidance)
                VALUES (?::uuid, ?, ?, ?, ?)
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, value.id); statement.setString(2, perspective.code)
                statement.setString(3, perspective.label)
                statement.setString(4, perspective.status.lowercase().replace('_', '-'))
                statement.setString(5, perspective.guidance); statement.executeUpdate()
            }
        }
        val next = (snapshot.threads.filter { it.reviewSessionId == value.id }.maxOfOrNull { it.displayNumber } ?: 0) + 1
        connection.prepareStatement(
            "INSERT INTO feedback.thread_sequences (session_id, next_number) VALUES (?::uuid, ?)"
        ).use { statement -> statement.setString(1, value.id); statement.setInt(2, next); statement.executeUpdate() }
    }

    private fun insertThread(connection: Connection, mapped: MappedLegacyThread, scope: LegacyMigrationScope) {
        val value = mapped.source
        connection.prepareStatement(
            """
            INSERT INTO feedback.feedback_threads (
                id, tenant_id, application_id, environment_id, workspace_id, session_id, display_number,
                location, target, perspective_code, status, reporter_principal_id, reporter_display_name,
                reporter_participant_name, created_at, updated_at
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?::jsonb, ?::jsonb,
                      ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, scope.tenantId)
            statement.setString(3, scope.applicationId); statement.setString(4, scope.environmentId)
            statement.setString(5, scope.workspaceId); statement.setString(6, value.reviewSessionId)
            statement.setInt(7, value.displayNumber); statement.setString(8, mapped.location.toString())
            statement.setString(9, mapped.target.toString()); statement.setString(10, value.perspectiveCode)
            statement.setString(11, value.status.lowercase()); statement.setString(12, value.reporterPrincipalId)
            statement.setString(13, value.reporterDisplayName); statement.setString(14, value.reporterName)
            statement.setString(15, value.createdAt); statement.setString(16, value.updatedAt); statement.executeUpdate()
        }
    }

    private fun insertMessage(connection: Connection, value: LegacyMessageSnapshot, versions: List<LegacyMessageVersionSnapshot>) {
        val currentVersion = versions.filter { it.messageId == value.id }.maxOf { it.version }
        connection.prepareStatement(
            """
            INSERT INTO feedback.feedback_messages (
                id, thread_id, author_principal_id, author_display_name, author_participant_name,
                body, version, created_at, edited_at
            ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, value.threadId)
            statement.setString(3, value.authorPrincipalId); statement.setString(4, value.authorDisplayName)
            statement.setString(5, value.participantName); statement.setString(6, value.body)
            statement.setInt(7, currentVersion); statement.setString(8, value.createdAt)
            statement.setString(9, value.editedAt); statement.executeUpdate()
        }
    }

    private fun insertMessageVersion(
        connection: Connection,
        value: LegacyMessageVersionSnapshot,
        messages: List<LegacyMessageSnapshot>
    ) {
        val message = messages.single { it.id == value.messageId }
        connection.prepareStatement(
            """
            INSERT INTO feedback.feedback_message_versions (
                message_id, thread_id, version, author_principal_id, author_display_name,
                author_participant_name, body, created_at, edited_at
            ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.messageId); statement.setString(2, message.threadId)
            statement.setInt(3, value.version); statement.setString(4, value.editorPrincipalId)
            statement.setString(5, value.editorDisplayName); statement.setString(6, value.editorParticipantName)
            statement.setString(7, value.body); statement.setString(8, message.createdAt)
            statement.setString(9, value.createdAt); statement.executeUpdate()
        }
    }

    private fun insertEvidence(connection: Connection, value: LegacyEvidenceSnapshot, snapshot: LegacyFeedbackSnapshot, runId: String) {
        val threadId = snapshot.threads.single { it.evidenceId == value.id }.id
        val bytes = Base64.getDecoder().decode(value.dataBase64)
        connection.prepareStatement(
            """
            INSERT INTO feedback.review_evidence (
                id, thread_id, object_key, content_type, byte_size, sha256, viewport_width,
                viewport_height, pixel_ratio, captured_at, created_at, expires_at
            ) VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, threadId)
            statement.setString(3, evidenceObjectKey(runId, value.id)); statement.setString(4, value.contentType)
            statement.setLong(5, bytes.size.toLong()); statement.setString(6, value.sha256)
            statement.setInt(7, value.viewportWidth); statement.setInt(8, value.viewportHeight)
            statement.setDouble(9, value.pixelRatio); statement.setString(10, value.capturedAt)
            statement.setString(11, value.createdAt); statement.setString(12, value.expiresAt); statement.executeUpdate()
        }
    }

    private fun insertAudit(connection: Connection, value: LegacyAuditSnapshot, scope: LegacyMigrationScope) {
        connection.prepareStatement(
            """
            INSERT INTO feedback.audit_logs (
                id, tenant_id, application_id, workspace_id, principal_id, action, resource_type,
                resource_id, outcome, request_id, changes, occurred_at
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, scope.tenantId)
            statement.setString(3, scope.applicationId); statement.setString(4, scope.workspaceId)
            statement.setString(5, value.principalId); statement.setString(6, value.action)
            statement.setString(7, value.resourceType); statement.setString(8, value.resourceId)
            statement.setString(9, mapOutcome(value.outcome)); statement.setString(10, value.requestId)
            statement.setString(11, value.changes?.let(::sanitizeLegacyAuditChanges)?.toString())
            statement.setString(12, value.occurredAt)
            statement.executeUpdate()
        }
    }

    private fun insertOutbox(connection: Connection, value: LegacyOutboxSnapshot, scope: LegacyMigrationScope) {
        val eventType = mapEventType(value.eventType)
        val payload = buildJsonObject {
            put("eventId", value.id); put("eventType", eventType); put("workspaceId", scope.workspaceId)
            put("sessionId", value.reviewSessionId); put("threadId", value.threadId)
            value.messageId?.let { put("messageId", it) }
            value.actorPrincipalId?.let { put("actorPrincipalId", it) }
        }
        connection.prepareStatement(
            """
            INSERT INTO feedback.notification_outbox (
                id, tenant_id, workspace_id, event_type, payload, status, attempt_count,
                available_at, delivered_at, created_at
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::jsonb, 'delivered', 0,
                      ?::timestamptz, ?::timestamptz, ?::timestamptz)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, value.id); statement.setString(2, scope.tenantId)
            statement.setString(3, scope.workspaceId); statement.setString(4, eventType)
            statement.setString(5, payload.toString()); statement.setString(6, value.createdAt)
            statement.setString(7, value.createdAt); statement.setString(8, value.createdAt); statement.executeUpdate()
        }
    }

    private fun validateIdsAndRelations(snapshot: LegacyFeedbackSnapshot) {
        val ids = buildList {
            addAll(snapshot.sessions.map { it.id }); addAll(snapshot.sessions.flatMap { it.scopes }.map { it.id })
            addAll(snapshot.threads.map { it.id }); addAll(snapshot.messages.map { it.id })
            addAll(snapshot.evidence.map { it.id }); addAll(snapshot.audits.map { it.id }); addAll(snapshot.outbox.map { it.id })
        }
        ids.forEach(UUID::fromString)
        require(ids.size == ids.distinct().size) { "resource ID が重複しています" }
        val sessionIds = snapshot.sessions.map { it.id }.toSet()
        val threadIds = snapshot.threads.map { it.id }.toSet()
        val messageIds = snapshot.messages.map { it.id }.toSet()
        val evidenceIds = snapshot.evidence.map { it.id }.toSet()
        require(snapshot.threads.all { it.reviewSessionId in sessionIds }) { "thread が未知の session を参照しています" }
        require(snapshot.messages.all { it.threadId in threadIds }) { "message が未知の thread を参照しています" }
        require(snapshot.messageVersions.all { it.messageId in messageIds }) { "history が未知の message を参照しています" }
        require(snapshot.threads.mapNotNull { it.evidenceId }.toSet() == evidenceIds) { "evidence 参照が一致しません" }
        snapshot.messages.forEach { message ->
            val versions = snapshot.messageVersions.filter { it.messageId == message.id }.sortedBy { it.version }
            require(versions.map { it.version } == (1..versions.size).toList()) { "message ${message.id}: version が連続していません" }
            require(versions.last().body == message.body) { "message ${message.id}: 現在版 body が一致しません" }
        }
        listOfNotNull(snapshot.projectEvidenceRetentionDays).plus(snapshot.sessions.mapNotNull { it.evidenceRetentionDays })
            .forEach { require(it in 1..3650) { "evidenceRetentionDays が範囲外です" } }
    }

    private fun mapLocation(thread: LegacyThreadSnapshot, snapshot: LegacyFeedbackSnapshot, manifest: JsonObject): JsonObject {
        val rawRoute = thread.pageRoute ?: error("thread ${thread.id}: pageRoute がありません")
        val uri = URI(rawRoute)
        val path = uri.path ?: error("thread ${thread.id}: pageRoute path がありません")
        val routes = manifest["routes"]!!.jsonArray.map { it.jsonObject }
        val route = routes.firstOrNull { candidate ->
            candidate["pageKey"]!!.jsonPrimitive.content == thread.pageId &&
                routeParameters(candidate["template"]!!.jsonPrimitive.content, path) != null
        } ?: routes.firstOrNull { routeParameters(it["template"]!!.jsonPrimitive.content, path) != null }
            ?: error("thread ${thread.id}: pageRoute は manifest に登録されていません")
        val template = route["template"]!!.jsonPrimitive.content
        val pathParameters = requireNotNull(routeParameters(template, path))
        val queryParameters = parseQuery(uri.rawQuery)
        return sanitizeLocation(buildJsonObject {
            put("schemaVersion", "1")
            put("pageKey", route["pageKey"]!!.jsonPrimitive.content)
            put("routeTemplate", template)
            put("pathParameters", JsonObject(pathParameters.mapValues { JsonPrimitive(it.value) }))
            if (queryParameters.isNotEmpty()) {
                put("queryParameters", JsonObject(queryParameters.mapValues { JsonPrimitive(it.value) }))
            }
        }, manifest)
    }

    private fun mapTarget(thread: LegacyThreadSnapshot): JsonObject {
        val source = thread.targetMetadata
        fun value(name: String) = source[name] ?: error("thread ${thread.id}: target.$name がありません")
        val target = when (thread.targetType) {
            "UI_ELEMENT" -> buildJsonObject {
                put("schemaVersion", "1"); put("kind", "ui-element")
                put("elementKey", value("feedbackTargetId")); put("relativeX", value("relativeX")); put("relativeY", value("relativeY"))
            }
            "SCREEN_POSITION" -> buildJsonObject {
                put("schemaVersion", "1"); put("kind", "screen-position")
                put("relativeX", value("relativeX")); put("relativeY", value("relativeY"))
            }
            "MAP_FEATURE" -> buildJsonObject {
                put("schemaVersion", "1"); put("kind", "map-feature"); put("provider", "maplibre")
                put("sourceKey", value("source")); source["sourceLayer"]?.let { put("sourceLayer", it) }
                put("featureKey", value("featureId")); put("longitude", value("longitude")); put("latitude", value("latitude"))
            }
            "MAP_POSITION" -> buildJsonObject {
                put("schemaVersion", "1"); put("kind", "map-position")
                put("longitude", value("longitude")); put("latitude", value("latitude"))
            }
            else -> error("thread ${thread.id}: targetType が不正です")
        }
        return validateTarget(target)
    }

    private fun requireNoCollisions(snapshot: LegacyFeedbackSnapshot, runId: String) {
        database.dataSource.connection.use { connection ->
            val targets = listOf(
                "review_sessions" to snapshot.sessions.map { it.id },
                "review_scopes" to snapshot.sessions.flatMap { it.scopes }.map { it.id },
                "feedback_threads" to snapshot.threads.map { it.id },
                "feedback_messages" to snapshot.messages.map { it.id },
                "review_evidence" to snapshot.evidence.map { it.id },
                "audit_logs" to snapshot.audits.map { it.id },
                "notification_outbox" to snapshot.outbox.map { it.id }
            )
            targets.forEach { (table, ids) ->
                require(scalarCount(connection, "feedback.$table", "id", ids) == 0L) { "$table に同じ ID が既にあります" }
            }
            require(scalarCount(connection, "feedback_migration.legacy_migration_runs", "id", listOf(runId)) == 0L) {
                "migration run ID が既にあります"
            }
            snapshot.evidence.forEach { evidence ->
                require(storage.list(evidenceObjectKey(runId, evidence.id)).isEmpty()) { "evidence object が既にあります" }
            }
        }
    }

    private fun snapshotChecksum(snapshot: LegacyFeedbackSnapshot): String =
        sha256(serviceJson.encodeToString(snapshot).toByteArray(StandardCharsets.UTF_8))

    private fun evidenceObjectKey(runId: String, evidenceId: String): String = "$evidencePrefix$runId/$evidenceId"
}

private fun routeParameters(template: String, path: String): Map<String, String>? {
    val templateParts = template.trim('/').takeIf { it.isNotEmpty() }?.split('/') ?: emptyList()
    val pathParts = path.trim('/').takeIf { it.isNotEmpty() }?.split('/') ?: emptyList()
    if (templateParts.size != pathParts.size) return null
    return buildMap {
        templateParts.zip(pathParts).forEach { (expected, actual) ->
            val match = Regex("^\\{([A-Za-z_][A-Za-z0-9_]*)}$").matchEntire(expected)
            if (match == null) {
                if (expected != actual) return null
            } else {
                put(match.groupValues[1], java.net.URLDecoder.decode(actual, StandardCharsets.UTF_8))
            }
        }
    }
}

private fun parseQuery(raw: String?): Map<String, String> = raw?.split('&')?.filter { it.isNotEmpty() }?.associate { pair ->
    val parts = pair.split('=', limit = 2)
    java.net.URLDecoder.decode(parts[0], StandardCharsets.UTF_8) to
        java.net.URLDecoder.decode(parts.getOrElse(1) { "" }, StandardCharsets.UTF_8)
} ?: emptyMap()

private fun mapEventType(value: String): String = when (value.uppercase()) {
    "THREAD_CREATED" -> "feedback.thread.created.v1"
    "MESSAGE_CREATED" -> "feedback.message.created.v1"
    "THREAD_RESOLVED" -> "feedback.thread.resolved.v1"
    "THREAD_REOPENED" -> "feedback.thread.reopened.v1"
    else -> error("未知の legacy eventType です: $value")
}

private fun mapOutcome(value: String): String = when (value.lowercase()) {
    "allowed", "denied", "succeeded", "failed" -> value.lowercase()
    "success" -> "succeeded"
    "failure" -> "failed"
    else -> error("未知の legacy audit outcome です: $value")
}

private val legacyAuditSensitiveFragments =
    listOf("password", "secret", "token", "credential", "apikey", "api_key", "body", "evidence")

private fun sanitizeLegacyAuditChanges(value: JsonObject): JsonObject =
    sanitizeLegacyAuditElement(value, "changes").jsonObject

private fun sanitizeLegacyAuditElement(value: JsonElement, fieldName: String): JsonElement {
    if (value is JsonNull) return value
    if (legacyAuditSensitiveFragments.any { it in fieldName.lowercase() }) return JsonPrimitive("***")
    val sanitized = when (value) {
        is JsonObject -> JsonObject(value.mapValues { (key, child) -> sanitizeLegacyAuditElement(child, key) })
        is JsonArray -> JsonArray(value.take(100).map { sanitizeLegacyAuditElement(it, fieldName) })
        else -> value
    }
    val encoded = sanitized.toString()
    if (encoded.length <= 1000) return sanitized
    return buildJsonObject {
        put("truncated", true)
        put("sizeChars", encoded.length)
        put("sha256", sha256(encoded.toByteArray()).take(16))
    }
}

private fun setNullableInt(statement: java.sql.PreparedStatement, index: Int, value: Int?) {
    if (value == null) statement.setNull(index, Types.INTEGER) else statement.setInt(index, value)
}

private fun scalarCount(connection: Connection, table: String, column: String, ids: List<String>): Long {
    if (ids.isEmpty()) return 0
    val placeholders = ids.joinToString(",") { "?::uuid" }
    return connection.prepareStatement("SELECT count(*) FROM $table WHERE $column IN ($placeholders)").use { statement ->
        ids.forEachIndexed { index, id -> statement.setString(index + 1, id) }
        statement.executeQuery().use { result -> result.next(); result.getLong(1) }
    }
}

private fun compareCount(
    connection: Connection,
    table: String,
    column: String,
    ids: List<String>,
    label: String,
    differences: MutableList<String>
) {
    val count = scalarCount(connection, "feedback.$table", column, ids)
    if (count != ids.size.toLong()) differences += "$label: expected=${ids.size}, actual=$count"
}

private fun compareDescendantCount(
    connection: Connection,
    sessionIds: List<String>,
    snapshot: LegacyFeedbackSnapshot,
    differences: MutableList<String>
) {
    if (sessionIds.isEmpty()) return
    val placeholders = sessionIds.joinToString(",") { "?::uuid" }
    val counts = listOf(
        Triple(
            "thread",
            "SELECT count(*) FROM feedback.feedback_threads t WHERE t.session_id IN ($placeholders)",
            snapshot.threads.size
        ),
        Triple(
            "message",
            """
            SELECT count(*) FROM feedback.feedback_messages m
            JOIN feedback.feedback_threads t ON t.id = m.thread_id
            WHERE t.session_id IN ($placeholders)
            """.trimIndent(),
            snapshot.messages.size
        ),
        Triple(
            "message history",
            """
            SELECT count(*) FROM feedback.feedback_message_versions v
            JOIN feedback.feedback_threads t ON t.id = v.thread_id
            WHERE t.session_id IN ($placeholders)
            """.trimIndent(),
            snapshot.messageVersions.size
        ),
        Triple(
            "evidence",
            """
            SELECT count(*) FROM feedback.review_evidence e
            JOIN feedback.feedback_threads t ON t.id = e.thread_id
            WHERE t.session_id IN ($placeholders)
            """.trimIndent(),
            snapshot.evidence.size
        )
    )
    counts.forEach { (label, sql, expected) ->
        val actual = connection.prepareStatement(sql).use { statement ->
            sessionIds.forEachIndexed { index, id -> statement.setString(index + 1, id) }
            statement.executeQuery().use { result -> result.next(); result.getLong(1) }
        }
        if (actual != expected.toLong()) differences += "$label descendant: expected=$expected, actual=$actual"
    }
}

private fun track(connection: Connection, runId: String, type: String, key: String) {
    connection.prepareStatement(
        "INSERT INTO feedback_migration.legacy_migration_entities (run_id, entity_type, entity_key) VALUES (?::uuid, ?, ?)"
    ).use { statement ->
        statement.setString(1, runId); statement.setString(2, type); statement.setString(3, key); statement.executeUpdate()
    }
}

private fun migrationEntities(connection: Connection, runId: String, type: String): List<String> =
    connection.prepareStatement(
        "SELECT entity_key FROM feedback_migration.legacy_migration_entities WHERE run_id = ?::uuid AND entity_type = ?"
    ).use { statement ->
        statement.setString(1, runId); statement.setString(2, type)
        statement.executeQuery().use { result -> buildList { while (result.next()) add(result.getString(1)) } }
    }

private fun deleteMigrationEntities(connection: Connection, runId: String, type: String, table: String) {
    val ids = migrationEntities(connection, runId, type)
    if (ids.isEmpty()) return
    val placeholders = ids.joinToString(",") { "?::uuid" }
    connection.prepareStatement("DELETE FROM $table WHERE id IN ($placeholders)").use { statement ->
        ids.forEachIndexed { index, id -> statement.setString(index + 1, id) }
        statement.executeUpdate()
    }
}
