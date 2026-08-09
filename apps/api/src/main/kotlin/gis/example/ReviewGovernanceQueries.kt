// プロトタイプレビュー Phase 6: 証跡の保存期間と期限切れ削除。
package gis.example

import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.sql.Connection

internal const val MIN_EVIDENCE_RETENTION_DAYS = 1
internal const val MAX_EVIDENCE_RETENTION_DAYS = 3650

internal fun readEvidenceRetentionDays(request: kotlinx.serialization.json.JsonObject, key: String): Int? {
    val days = readOptionalInt(request, key) ?: return null
    if (days !in MIN_EVIDENCE_RETENTION_DAYS..MAX_EVIDENCE_RETENTION_DAYS) {
        throw ApiException(
            HttpStatusCode.BadRequest,
            "$key must be between $MIN_EVIDENCE_RETENTION_DAYS and $MAX_EVIDENCE_RETENTION_DAYS"
        )
    }
    return days
}

fun Database.getReviewRetentionPolicy(projectId: String): ReviewRetentionPolicyDto =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT p.id::text,
                   p.review_evidence_retention_days,
                   count(e.id) FILTER (WHERE e.expires_at <= now()) AS expired_count,
                   coalesce(sum(e.byte_size) FILTER (WHERE e.expires_at <= now()), 0) AS expired_bytes
            FROM app.projects AS p
            LEFT JOIN app.feedback_threads AS t ON t.project_id = p.id
            LEFT JOIN app.review_evidence AS e ON e.id = t.evidence_id
            WHERE p.id = ?::uuid
            GROUP BY p.id, p.review_evidence_retention_days
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) throw ApiException(HttpStatusCode.NotFound, "Project not found")
                ReviewRetentionPolicyDto(
                    projectId = rs.getString(1),
                    defaultEvidenceRetentionDays = (rs.getObject(2) as? Number)?.toInt(),
                    expiredEvidenceCount = rs.getLong(3),
                    expiredEvidenceBytes = rs.getLong(4)
                )
            }
        }
    }

fun Database.updateReviewRetentionPolicy(
    projectId: String,
    defaultEvidenceRetentionDays: Int?,
    audit: AuditTrail
): ReviewRetentionPolicyDto {
    val before = getReviewRetentionPolicy(projectId)
    withTransaction { connection ->
        connection.prepareStatement(
            "UPDATE app.projects SET review_evidence_retention_days = ? WHERE id = ?::uuid"
        ).use { stmt ->
            if (defaultEvidenceRetentionDays == null) stmt.setNull(1, java.sql.Types.INTEGER)
            else stmt.setInt(1, defaultEvidenceRetentionDays)
            stmt.setString(2, projectId)
            if (stmt.executeUpdate() == 0) throw ApiException(HttpStatusCode.NotFound, "Project not found")
        }
        refreshEvidenceExpirationsForProject(connection, projectId)
    }
    val after = getReviewRetentionPolicy(projectId)
    audit.recordUpdate(
        "review_retention_policy",
        projectId,
        before.retentionAuditSnapshot(),
        after.retentionAuditSnapshot()
    )
    return after
}

/** セッション上書きを持たない証跡を含め、プロジェクト内の期限を現在のポリシーで再計算する。 */
internal fun refreshEvidenceExpirationsForProject(connection: Connection, projectId: String) {
    connection.prepareStatement(
        """
        UPDATE app.review_evidence AS e
        SET expires_at = CASE
            WHEN coalesce(s.evidence_retention_days, p.review_evidence_retention_days) IS NULL THEN NULL
            ELSE e.captured_at + make_interval(
                days => coalesce(s.evidence_retention_days, p.review_evidence_retention_days)
            )
        END
        FROM app.feedback_threads AS t
        JOIN app.review_sessions AS s ON s.id = t.review_session_id
        JOIN app.projects AS p ON p.id = t.project_id
        WHERE t.evidence_id = e.id
          AND t.project_id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, projectId)
        stmt.executeUpdate()
    }
}

/** セッションの上書き変更時、そのセッションの証跡だけを再計算する。 */
internal fun refreshEvidenceExpirationsForSession(connection: Connection, reviewSessionId: String) {
    connection.prepareStatement(
        """
        UPDATE app.review_evidence AS e
        SET expires_at = CASE
            WHEN coalesce(s.evidence_retention_days, p.review_evidence_retention_days) IS NULL THEN NULL
            ELSE e.captured_at + make_interval(
                days => coalesce(s.evidence_retention_days, p.review_evidence_retention_days)
            )
        END
        FROM app.feedback_threads AS t
        JOIN app.review_sessions AS s ON s.id = t.review_session_id
        JOIN app.projects AS p ON p.id = t.project_id
        WHERE t.evidence_id = e.id
          AND t.review_session_id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, reviewSessionId)
        stmt.executeUpdate()
    }
}

internal data class ExpiredReviewEvidence(
    val id: String,
    val screenshotPath: String,
    val byteSize: Long,
    val capturedAt: String,
    val expiresAt: String
)

internal fun Database.listExpiredReviewEvidence(projectId: String, limit: Int): List<ExpiredReviewEvidence> =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT e.id::text, e.screenshot_path, e.byte_size, e.captured_at, e.expires_at
            FROM app.review_evidence AS e
            JOIN app.feedback_threads AS t ON t.evidence_id = e.id
            WHERE t.project_id = ?::uuid
              AND e.expires_at <= now()
            ORDER BY e.expires_at, e.id
            LIMIT ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setInt(2, limit)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            ExpiredReviewEvidence(
                                id = rs.getString(1),
                                screenshotPath = rs.getString(2),
                                byteSize = rs.getLong(3),
                                capturedAt = rs.isoTimestamp("captured_at") ?: error("captured_at must not be null"),
                                expiresAt = rs.isoTimestamp("expires_at") ?: error("expires_at must not be null")
                            )
                        )
                    }
                }
            }
        }
    }

/**
 * 行ロック中に期限を再検査して Blob → DB の順に削除する。ポリシー延長との競合で、
 * 期限が延びた証跡を削除しない。Blob 削除後の DB 失敗は再試行時の冪等削除で収束する。
 */
internal fun Database.purgeExpiredReviewEvidence(
    projectId: String,
    evidence: ExpiredReviewEvidence,
    deleteBlob: (String) -> Unit,
    audit: AuditTrail
): Boolean = withTransaction { connection ->
    val stillExpired = connection.prepareStatement(
        """
        SELECT 1
        FROM app.review_evidence AS e
        JOIN app.feedback_threads AS t ON t.evidence_id = e.id
        JOIN app.review_sessions AS s ON s.id = t.review_session_id
        JOIN app.projects AS p ON p.id = t.project_id
        WHERE e.id = ?::uuid
          AND t.project_id = ?::uuid
          AND e.expires_at <= now()
        FOR UPDATE OF p, s, e
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, evidence.id)
        stmt.setString(2, projectId)
        stmt.executeQuery().use { it.next() }
    }
    if (!stillExpired) return@withTransaction false

    deleteBlob(evidence.screenshotPath)
    val deleted = connection.prepareStatement(
        "DELETE FROM app.review_evidence WHERE id = ?::uuid"
    ).use { stmt ->
        stmt.setString(1, evidence.id)
        stmt.executeUpdate() > 0
    }
    if (deleted) {
        audit.recordDelete(
            "review_evidence",
            evidence.id,
            buildJsonObject {
                put("id", evidence.id)
                put("byteSize", evidence.byteSize)
                put("capturedAt", evidence.capturedAt)
                put("expiresAt", evidence.expiresAt)
            }
        )
    }
    deleted
}

private fun ReviewRetentionPolicyDto.retentionAuditSnapshot() = buildJsonObject {
    put("projectId", projectId)
    if (defaultEvidenceRetentionDays == null) put("defaultEvidenceRetentionDays", JsonNull)
    else put("defaultEvidenceRetentionDays", defaultEvidenceRetentionDays)
}
