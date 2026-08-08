package feedback.service.integration

import feedback.service.*
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@Tag("integration")
class LegacyMigrationIntegrationTest {
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
                poolSize = 3,
                connectionTimeoutMillis = 5000,
                statementTimeoutMillis = 30000
            )
        )
        database.dataSource.connection.use { connection ->
            connection.createStatement().use { it.execute("DROP SCHEMA IF EXISTS feedback CASCADE") }
        }
        database.migrate()
        provisionMigrationScope()
    }

    @AfterTest
    fun tearDown() = database.close()

    @Test
    fun `匿名fixtureをdry-run copy reconcile rollbackできる`() {
        val snapshot = migrationSnapshot()
        LocalEvidenceStorage(temporaryDirectory).use { storage ->
            val migration = LegacyFeedbackMigration(database, storage)
            val dryRun = migration.dryRun(snapshot)
            assertTrue(dryRun.dryRun)
            assertEquals(0, count("feedback.review_sessions"))

            val applied = migration.apply(snapshot, dryRun.runId)
            assertFalse(applied.dryRun)
            assertTrue(migration.reconcile(snapshot, applied.runId).differences.isEmpty())

            database.dataSource.connection.use { connection ->
                connection.prepareStatement(
                    "SELECT display_number, location->'queryParameters'->>'tab', " +
                        "jsonb_exists(location->'queryParameters', 'token') " +
                        "FROM feedback.feedback_threads WHERE id = ?::uuid"
                ).use { statement ->
                    statement.setString(1, THREAD_ID)
                    statement.executeQuery().use { result ->
                        assertTrue(result.next())
                        assertEquals(4, result.getInt(1))
                        assertEquals("detail", result.getString(2))
                        assertFalse(result.getBoolean(3))
                    }
                }
                connection.prepareStatement(
                    "SELECT evidence_retention_days FROM feedback.review_sessions WHERE id = ?::uuid"
                ).use { statement ->
                    statement.setString(1, SESSION_ID)
                    statement.executeQuery().use { result -> assertTrue(result.next()); assertEquals(30, result.getInt(1)) }
                }
                connection.prepareStatement(
                    """
                    SELECT p.evidence_retention_days
                    FROM feedback.retention_policies p
                    JOIN feedback.workspaces w ON w.id = p.workspace_id
                    WHERE w.external_workspace_key = 'project-anonymous'
                    """.trimIndent()
                ).use { statement ->
                    statement.executeQuery().use { result -> assertTrue(result.next()); assertEquals(90, result.getInt(1)) }
                }
                connection.prepareStatement(
                    "SELECT expires_at::text, sha256 FROM feedback.review_evidence WHERE id = ?::uuid"
                ).use { statement ->
                    statement.setString(1, EVIDENCE_ID)
                    statement.executeQuery().use { result ->
                        assertTrue(result.next())
                        assertTrue(result.getString(1).startsWith("2026-09-08"))
                        assertEquals(PNG_SHA256, result.getString(2))
                    }
                }
                connection.prepareStatement(
                    "SELECT body FROM feedback.feedback_message_versions WHERE message_id = ?::uuid ORDER BY version"
                ).use { statement ->
                    statement.setString(1, MESSAGE_ID)
                    statement.executeQuery().use { result ->
                        assertTrue(result.next()); assertEquals("初版", result.getString(1))
                        assertTrue(result.next()); assertEquals("修正版", result.getString(1))
                    }
                }
            }
            assertEquals(1, storage.list("evidence/migration/${applied.runId}").size)

            // コピー後に値が変わった場合は、新サービス側の書き込みを失わないよう rollback を拒否する。
            updateDisplayNumber(5)
            assertFailsWith<IllegalArgumentException> { migration.rollback(snapshot, applied.runId) }
            updateDisplayNumber(4)

            migration.rollback(snapshot, applied.runId)
            assertEquals(0, count("feedback.review_sessions"))
            assertEquals(0, count("feedback.feedback_threads"))
            assertEquals(0, count("feedback.retention_policies"))
            assertEquals(0, storage.list("evidence/migration/${applied.runId}").size)
            assertEquals("rolled-back", migrationStatus(applied.runId))
        }
    }

    private fun provisionMigrationScope() {
        val input = BootstrapInput(
            tenantKey = "migration-fixture",
            tenantDisplayName = "匿名移行 fixture",
            applicationKey = "web-gis",
            applicationDisplayName = "Web GIS",
            environmentKey = "local",
            environmentBaseUrl = "https://consumer.example.invalid",
            allowedOrigins = listOf("https://consumer.example.invalid"),
            externalWorkspaceKey = "project-anonymous",
            workspaceDisplayName = "匿名案件",
            issuer = "https://issuer.example.invalid",
            subject = "migration-admin",
            email = "admin@example.invalid",
            displayName = "移行管理者",
            permissions = FeedbackPermission.entries.toSet()
        )
        database.bootstrap(input)
        val principal = database.resolvePrincipal(input.issuer, input.subject, input.email, input.displayName)
        val applicationScope = database.resolveApplicationScope(principal.userId, input.applicationKey)
        database.putManifest(applicationScope, principal, validateManifest(input.applicationKey, buildJsonObject {
            put("schemaVersion", "1")
            put("applicationKey", input.applicationKey)
            put("displayName", "Web GIS")
            put("manifestVersion", "migration-v1")
            put("routes", buildJsonArray {
                add(buildJsonObject {
                    put("pageKey", "orders.detail")
                    put("template", "/orders/{orderId}")
                    put("label", "注文詳細")
                    put("parameters", buildJsonObject {
                        put("orderId", buildJsonObject { put("persistence", "store") })
                    })
                    put("queryParameters", buildJsonObject {
                        put("tab", buildJsonObject { put("persistence", "store") })
                        put("token", buildJsonObject { put("persistence", "discard") })
                    })
                })
            })
        }), null)
    }

    private fun migrationSnapshot(): LegacyFeedbackSnapshot {
        val png = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0)
        return LegacyFeedbackSnapshot(
            sourceSystem = "web-gis-fixture",
            applicationKey = "web-gis",
            environmentKey = "local",
            externalWorkspaceKey = "project-anonymous",
            manifestVersion = "migration-v1",
            projectEvidenceRetentionDays = 90,
            sessions = listOf(
                LegacySessionSnapshot(
                    id = SESSION_ID,
                    title = "受入レビュー",
                    status = "open",
                    createdBy = "legacy-user-1",
                    createdAt = "2026-08-09T00:00:00Z",
                    updatedAt = "2026-08-09T01:00:00Z",
                    evidenceRetentionDays = 30,
                    scopes = listOf(
                        LegacyScopeSnapshot(
                            id = SCOPE_ID,
                            pageId = "orders.detail",
                            route = "/orders/{orderId}",
                            reviewable = true
                        )
                    ),
                    perspectives = listOf(
                        LegacyPerspectiveSnapshot("USABILITY", "操作性", "ACTIVE", "迷わず操作できるか")
                    )
                )
            ),
            threads = listOf(
                LegacyThreadSnapshot(
                    id = THREAD_ID,
                    reviewSessionId = SESSION_ID,
                    displayNumber = 4,
                    pageId = "orders.detail",
                    pageRoute = "/orders/ORDER-1?tab=detail&token=do-not-copy",
                    perspectiveCode = "USABILITY",
                    targetType = "MAP_FEATURE",
                    targetMetadata = buildJsonObject {
                        put("source", "orders"); put("sourceLayer", "active")
                        put("featureId", "ORDER-1"); put("longitude", 139.7); put("latitude", 35.6)
                    },
                    evidenceId = EVIDENCE_ID,
                    status = "RESOLVED",
                    reporterPrincipalId = "legacy-user-1",
                    reporterDisplayName = "匿名利用者",
                    reporterName = "レビュー担当A",
                    createdAt = "2026-08-09T00:10:00Z",
                    updatedAt = "2026-08-09T00:30:00Z"
                )
            ),
            messages = listOf(
                LegacyMessageSnapshot(
                    id = MESSAGE_ID,
                    threadId = THREAD_ID,
                    authorPrincipalId = "legacy-user-1",
                    authorDisplayName = "匿名利用者",
                    participantName = "レビュー担当A",
                    body = "修正版",
                    createdAt = "2026-08-09T00:10:00Z",
                    editedAt = "2026-08-09T00:20:00Z"
                )
            ),
            messageVersions = listOf(
                LegacyMessageVersionSnapshot(MESSAGE_ID, 1, "初版", "legacy-user-1", createdAt = "2026-08-09T00:10:00Z"),
                LegacyMessageVersionSnapshot(MESSAGE_ID, 2, "修正版", "legacy-user-1", createdAt = "2026-08-09T00:20:00Z")
            ),
            evidence = listOf(
                LegacyEvidenceSnapshot(
                    id = EVIDENCE_ID,
                    dataBase64 = Base64.getEncoder().encodeToString(png),
                    contentType = "image/png",
                    sha256 = PNG_SHA256,
                    viewportWidth = 1280,
                    viewportHeight = 720,
                    pixelRatio = 1.0,
                    capturedAt = "2026-08-09T00:10:00Z",
                    createdAt = "2026-08-09T00:10:00Z",
                    expiresAt = "2026-09-08T00:10:00Z",
                    legacyObjectReference = "fixture://legacy/evidence.png"
                )
            ),
            audits = listOf(
                LegacyAuditSnapshot(
                    id = AUDIT_ID,
                    principalId = "legacy-user-1",
                    action = "feedback.thread.resolve",
                    resourceType = "thread",
                    resourceId = THREAD_ID,
                    outcome = "succeeded",
                    requestId = "fixture-request-1",
                    occurredAt = "2026-08-09T00:30:00Z"
                )
            ),
            outbox = listOf(
                LegacyOutboxSnapshot(
                    id = OUTBOX_ID,
                    reviewSessionId = SESSION_ID,
                    threadId = THREAD_ID,
                    messageId = MESSAGE_ID,
                    eventType = "THREAD_RESOLVED",
                    actorPrincipalId = "legacy-user-1",
                    createdAt = "2026-08-09T00:30:00Z"
                )
            )
        )
    }

    private fun updateDisplayNumber(value: Int) {
        database.dataSource.connection.use { connection ->
            connection.prepareStatement(
                "UPDATE feedback.feedback_threads SET display_number = ? WHERE id = ?::uuid"
            ).use { statement -> statement.setInt(1, value); statement.setString(2, THREAD_ID); statement.executeUpdate() }
        }
    }

    private fun count(table: String): Int = database.dataSource.connection.use { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery("SELECT count(*) FROM $table").use { result -> result.next(); result.getInt(1) }
        }
    }

    private fun migrationStatus(runId: String): String = database.dataSource.connection.use { connection ->
        connection.prepareStatement(
            "SELECT status FROM feedback.legacy_migration_runs WHERE id = ?::uuid"
        ).use { statement ->
            statement.setString(1, runId)
            statement.executeQuery().use { result -> assertTrue(result.next()); result.getString(1) }
        }
    }

    private fun required(name: String): String = System.getenv(name) ?: error("$name が必要です")

    companion object {
        private const val SESSION_ID = "81000000-0000-4000-8000-000000000001"
        private const val SCOPE_ID = "82000000-0000-4000-8000-000000000001"
        private const val THREAD_ID = "83000000-0000-4000-8000-000000000001"
        private const val MESSAGE_ID = "84000000-0000-4000-8000-000000000001"
        private const val EVIDENCE_ID = "85000000-0000-4000-8000-000000000001"
        private const val AUDIT_ID = "86000000-0000-4000-8000-000000000001"
        private const val OUTBOX_ID = "87000000-0000-4000-8000-000000000001"
        private const val PNG_SHA256 = "843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9"
    }
}
