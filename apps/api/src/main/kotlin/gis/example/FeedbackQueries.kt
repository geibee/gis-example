// フィードバックスレッド・メッセージ・証跡のクエリ。
// 設計は docs/prototype-review.md Phase 2〜4。
//
// 投稿は「セッションが受付中で、その観点が今回 ACTIVE であること」を前提とする。
// 観点の出し分け (FUTURE / OUT_OF_SCOPE のグレーアウト) は UI の親切ではなく
// 基盤の約束なので、サーバ側でも同じ条件を強制する。
package gis.example

import kotlinx.serialization.json.JsonObject
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime

/** スレッドの状態。MVP は 2 値から始める (docs/prototype-review.md 6.2) */
internal val feedbackThreadStatuses = setOf("OPEN", "RESOLVED")

/** コメント対象の種別 (apps/web/src/review/types.ts の FeedbackTarget と対で保つ) */
internal val feedbackTargetTypes = setOf("UI_ELEMENT", "SCREEN_POSITION", "MAP_FEATURE", "MAP_POSITION")

/** 証跡の保存に必要なメタデータ (画像本体は UploadStorage 側)。 */
data class ReviewEvidenceInput(
    val screenshotPath: String,
    val contentType: String,
    val byteSize: Long,
    val viewportWidth: Int,
    val viewportHeight: Int,
    val scrollX: Int,
    val scrollY: Int,
    val pixelRatio: Double,
    val frontendVersion: String,
    val route: String,
    val capturedAt: String
)

data class FeedbackThreadInput(
    val reviewSessionId: String,
    val perspectiveCode: String,
    val targetType: String,
    val targetMetadata: JsonObject,
    val pageId: String?,
    val body: String,
    val evidence: ReviewEvidenceInput?
)

data class FeedbackThreadListQuery(
    val reviewSessionId: String,
    val status: String?,
    val limit: Int? = null,
    val offset: Int = 0
)

data class FeedbackThreadSearchQuery(
    val projectId: String,
    val reviewSessionId: String?,
    val status: String?,
    val perspectiveCode: String?,
    val hasEvidence: Boolean?,
    val query: String?,
    val limit: Int? = null,
    val offset: Int = 0
)

/**
 * 投稿の受付可否。セッションが受付中で、指定観点がそのセッションで ACTIVE であることを要求する。
 * 拒否理由はそのまま顧客に見えるので、何が起きたか分かる文言にする。
 */
fun Database.requirePostableSession(reviewSessionId: String, perspectiveCode: String) {
    dataSource.connection.use { connection ->
        val status = connection.prepareStatement(
            "SELECT status, end_at FROM app.review_sessions WHERE id = ?::uuid"
        ).use { stmt ->
            stmt.setString(1, reviewSessionId)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Review session not found")
                rs.getString("status") to rs.getObject("end_at", OffsetDateTime::class.java)
            }
        }
        if (status.first != "open") {
            throw ApiException(
                io.ktor.http.HttpStatusCode.Conflict,
                "このレビューセッションは受付中ではありません (status=${status.first})"
            )
        }
        val endAt = status.second
        if (endAt != null && OffsetDateTime.now().isAfter(endAt)) {
            throw ApiException(io.ktor.http.HttpStatusCode.Conflict, "このレビューセッションの受付期間は終了しています")
        }

        val perspectiveStatus = connection.prepareStatement(
            """
            SELECT status
            FROM app.review_session_perspectives
            WHERE review_session_id = ?::uuid AND perspective_code = ?
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, reviewSessionId)
            stmt.setString(2, perspectiveCode)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
            ?: throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "観点 $perspectiveCode は今回のレビュー対象に含まれていません"
            )
        if (perspectiveStatus != "ACTIVE") {
            throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "観点 $perspectiveCode は今回選択できません (status=$perspectiveStatus)"
            )
        }
    }
}

fun Database.createFeedbackThread(
    input: FeedbackThreadInput,
    createdBy: String?,
    audit: AuditTrail
): FeedbackThreadDto = try {
    val id = withTransaction { connection ->
        val evidenceId = input.evidence?.let { insertEvidence(connection, it) }
        // 投稿時の画面に対応する ReviewScope を引き当てる (対象外の画面からの投稿もあるので任意)
        val scopeId = input.pageId?.let { pageId -> findScopeId(connection, input.reviewSessionId, pageId) }
        val threadId = connection.prepareStatement(
            """
            INSERT INTO app.feedback_threads (
                project_id, review_session_id, review_scope_id, perspective_code,
                target_type, target_metadata, evidence_id, created_by
            )
            SELECT s.project_id, s.id, ?::uuid, ?, ?, ?::jsonb, ?::uuid, ?::uuid
            FROM app.review_sessions AS s
            WHERE s.id = ?::uuid
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            setNullableUuidString(stmt, 1, scopeId)
            stmt.setString(2, input.perspectiveCode)
            stmt.setString(3, input.targetType)
            stmt.setString(4, input.targetMetadata.toString())
            setNullableUuidString(stmt, 5, evidenceId)
            setNullableUuidString(stmt, 6, createdBy)
            stmt.setString(7, input.reviewSessionId)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Review session not found")
                rs.getString(1)
            }
        }
        connection.prepareStatement(
            "INSERT INTO app.feedback_messages (thread_id, author_id, body) VALUES (?::uuid, ?::uuid, ?)"
        ).use { stmt ->
            stmt.setString(1, threadId)
            setNullableUuidString(stmt, 2, createdBy)
            stmt.setString(3, input.body)
            stmt.executeUpdate()
        }
        threadId
    }
    val created = getFeedbackThread(id) ?: error("Created feedback thread disappeared")
    audit.recordCreate("feedback_thread", created.id, created.auditSnapshot())
    created
} catch (exc: SQLException) {
    throw ApiException(
        io.ktor.http.HttpStatusCode.BadRequest,
        "Feedback thread create failed: ${exc.message ?: "invalid feedback thread"}"
    )
}

fun Database.listFeedbackThreads(query: FeedbackThreadListQuery): PagedList<FeedbackThreadDto> =
    dataSource.connection.use { connection ->
        val filters = mutableListOf("t.review_session_id = ?::uuid")
        val binders = mutableListOf<(java.sql.PreparedStatement, Int) -> Unit>(
            { stmt, index -> stmt.setString(index, query.reviewSessionId) }
        )
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { status ->
            if (status !in feedbackThreadStatuses) {
                throw ApiException(
                    io.ktor.http.HttpStatusCode.BadRequest,
                    "status must be one of ${feedbackThreadStatuses.sorted()}"
                )
            }
            filters.add("t.status = ?")
            binders.add { stmt, index -> stmt.setString(index, status) }
        }
        val baseSql = """
            FROM app.feedback_threads AS t
            ${whereClause(filters)}
        """.trimIndent()
        val totalCount = queryTotalCount(connection, baseSql, binders)
        val threads = connection.prepareStatement(
            """
            SELECT ${feedbackThreadColumns()}
            FROM app.feedback_threads AS t
            JOIN app.review_perspectives AS p ON p.code = t.perspective_code
            LEFT JOIN app.review_evidence AS e ON e.id = t.evidence_id
            LEFT JOIN app.users AS u ON u.id = t.created_by
            ${whereClause(filters)}
            ORDER BY t.created_at DESC, t.id${pagingClause(query.limit, query.offset)}
            """.trimIndent()
        ).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toFeedbackThreadDto())
                }
            }
        }
        // 一覧では本文を先頭 1 件だけ載せる用途もあるため、まとめて引いて N+1 を避ける
        val messages = listMessagesForThreads(connection, threads.map { it.id })
        PagedList(
            items = threads.map { thread -> thread.copy(messages = messages[thread.id].orEmpty()) },
            totalCount = totalCount
        )
    }

/** 管理画面向けのプロジェクト横断検索。値はすべてバインドし、任意条件だけを SQL へ足す。 */
fun Database.searchFeedbackThreads(query: FeedbackThreadSearchQuery): PagedList<FeedbackThreadDto> =
    dataSource.connection.use { connection ->
        val filters = mutableListOf("t.project_id = ?::uuid")
        val binders = mutableListOf<(java.sql.PreparedStatement, Int) -> Unit>(
            { stmt, index -> stmt.setString(index, query.projectId) }
        )
        query.reviewSessionId?.let { reviewSessionId ->
            filters.add("t.review_session_id = ?::uuid")
            binders.add { stmt, index -> stmt.setString(index, reviewSessionId) }
        }
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { status ->
            if (status !in feedbackThreadStatuses) {
                throw ApiException(
                    io.ktor.http.HttpStatusCode.BadRequest,
                    "status must be one of ${feedbackThreadStatuses.sorted()}"
                )
            }
            filters.add("t.status = ?")
            binders.add { stmt, index -> stmt.setString(index, status) }
        }
        query.perspectiveCode?.trim()?.takeIf { it.isNotEmpty() }?.let { perspectiveCode ->
            filters.add("t.perspective_code = ?")
            binders.add { stmt, index -> stmt.setString(index, perspectiveCode) }
        }
        query.hasEvidence?.let { hasEvidence ->
            filters.add(if (hasEvidence) "t.evidence_id IS NOT NULL" else "t.evidence_id IS NULL")
        }
        query.query?.trim()?.takeIf { it.isNotEmpty() }?.let { text ->
            filters.add(
                """
                EXISTS (
                    SELECT 1 FROM app.feedback_messages AS search_message
                    WHERE search_message.thread_id = t.id
                      AND lower(search_message.body) LIKE lower(?)
                )
                """.trimIndent()
            )
            binders.add { stmt, index -> stmt.setString(index, "%$text%") }
        }

        val baseSql = """
            FROM app.feedback_threads AS t
            ${whereClause(filters)}
        """.trimIndent()
        val totalCount = queryTotalCount(connection, baseSql, binders)
        val threads = connection.prepareStatement(
            """
            SELECT ${feedbackThreadColumns()}
            FROM app.feedback_threads AS t
            JOIN app.review_perspectives AS p ON p.code = t.perspective_code
            LEFT JOIN app.review_evidence AS e ON e.id = t.evidence_id
            LEFT JOIN app.users AS u ON u.id = t.created_by
            ${whereClause(filters)}
            ORDER BY t.updated_at DESC, t.id${pagingClause(query.limit, query.offset)}
            """.trimIndent()
        ).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toFeedbackThreadDto())
                }
            }
        }
        val messages = listMessagesForThreads(connection, threads.map { it.id })
        PagedList(
            items = threads.map { thread -> thread.copy(messages = messages[thread.id].orEmpty()) },
            totalCount = totalCount
        )
    }

/** プロジェクト全体を対象に、状態・セッション・観点の集計を 3 クエリで返す。 */
fun Database.summarizeFeedbackThreads(projectId: String): FeedbackSummaryDto =
    dataSource.connection.use { connection ->
        val totals = connection.prepareStatement(
            """
            SELECT count(*) AS total_count,
                   count(*) FILTER (WHERE status = 'OPEN') AS open_count,
                   count(*) FILTER (WHERE status = 'RESOLVED') AS resolved_count,
                   count(*) FILTER (WHERE evidence_id IS NOT NULL) AS with_evidence_count
            FROM app.feedback_threads
            WHERE project_id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                rs.next()
                longArrayOf(
                    rs.getLong("total_count"),
                    rs.getLong("open_count"),
                    rs.getLong("resolved_count"),
                    rs.getLong("with_evidence_count")
                )
            }
        }
        val sessions = connection.prepareStatement(
            """
            SELECT s.id::text, s.title, s.status,
                   count(t.id) AS total_count,
                   count(t.id) FILTER (WHERE t.status = 'OPEN') AS open_count,
                   count(t.id) FILTER (WHERE t.status = 'RESOLVED') AS resolved_count
            FROM app.review_sessions AS s
            LEFT JOIN app.feedback_threads AS t ON t.review_session_id = s.id
            WHERE s.project_id = ?::uuid
            GROUP BY s.id, s.title, s.status, s.created_at
            ORDER BY s.created_at DESC, s.id
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            FeedbackSessionSummaryDto(
                                reviewSessionId = rs.getString(1),
                                title = rs.getString(2),
                                sessionStatus = rs.getString(3),
                                totalCount = rs.getLong(4),
                                openCount = rs.getLong(5),
                                resolvedCount = rs.getLong(6)
                            )
                        )
                    }
                }
            }
        }
        val perspectives = connection.prepareStatement(
            """
            SELECT p.code, p.label,
                   count(t.id) AS total_count,
                   count(t.id) FILTER (WHERE t.status = 'OPEN') AS open_count,
                   count(t.id) FILTER (WHERE t.status = 'RESOLVED') AS resolved_count
            FROM app.feedback_threads AS t
            JOIN app.review_perspectives AS p ON p.code = t.perspective_code
            WHERE t.project_id = ?::uuid
            GROUP BY p.code, p.label, p.display_order
            ORDER BY p.display_order, p.code
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            FeedbackPerspectiveSummaryDto(
                                perspectiveCode = rs.getString(1),
                                perspectiveLabel = rs.getString(2),
                                totalCount = rs.getLong(3),
                                openCount = rs.getLong(4),
                                resolvedCount = rs.getLong(5)
                            )
                        )
                    }
                }
            }
        }
        FeedbackSummaryDto(
            totalCount = totals[0],
            openCount = totals[1],
            resolvedCount = totals[2],
            withEvidenceCount = totals[3],
            sessions = sessions,
            perspectives = perspectives
        )
    }

fun Database.getFeedbackThread(id: String): FeedbackThreadDto? = dataSource.connection.use { connection ->
    val thread = connection.prepareStatement(
        """
        SELECT ${feedbackThreadColumns()}
        FROM app.feedback_threads AS t
        JOIN app.review_perspectives AS p ON p.code = t.perspective_code
        LEFT JOIN app.review_evidence AS e ON e.id = t.evidence_id
        LEFT JOIN app.users AS u ON u.id = t.created_by
        WHERE t.id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.toFeedbackThreadDto() else null }
    } ?: return@use null
    thread.copy(messages = listMessagesForThreads(connection, listOf(id))[id].orEmpty())
}

/**
 * OPEN のスレッドへ返信する。解決済みへの暗黙の返信は状態の意味を曖昧にするため、
 * editor が明示的に Reopen してから返信する。
 */
fun Database.createFeedbackMessage(
    threadId: String,
    body: String,
    authorId: String?,
    audit: AuditTrail
): FeedbackMessageDto = try {
    val messageId = withTransaction { connection ->
        val status = connection.prepareStatement(
            "SELECT status FROM app.feedback_threads WHERE id = ?::uuid FOR UPDATE"
        ).use { stmt ->
            stmt.setString(1, threadId)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        } ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feedback thread not found")
        if (status != "OPEN") {
            throw ApiException(
                io.ktor.http.HttpStatusCode.Conflict,
                "解決済みのスレッドへ返信するには、先にスレッドを再開してください"
            )
        }

        val id = connection.prepareStatement(
            """
            INSERT INTO app.feedback_messages (thread_id, author_id, body)
            VALUES (?::uuid, ?::uuid, ?)
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, threadId)
            setNullableUuidString(stmt, 2, authorId)
            stmt.setString(3, body)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
        connection.prepareStatement(
            "UPDATE app.feedback_threads SET updated_at = now() WHERE id = ?::uuid"
        ).use { stmt ->
            stmt.setString(1, threadId)
            stmt.executeUpdate()
        }
        id
    }
    val created = getFeedbackMessage(messageId) ?: error("Created feedback message disappeared")
    audit.recordCreate("feedback_message", created.id, created.auditSnapshot())
    created
} catch (exc: SQLException) {
    throw ApiException(
        io.ktor.http.HttpStatusCode.BadRequest,
        "Feedback message create failed: ${exc.message ?: "invalid feedback message"}"
    )
}

/** OPEN / RESOLVED を明示的に遷移させ、監査差分から Resolve / Reopen の履歴を追えるようにする。 */
fun Database.updateFeedbackThreadStatus(
    id: String,
    status: String,
    audit: AuditTrail
): FeedbackThreadDto = try {
    if (status !in feedbackThreadStatuses) {
        throw ApiException(
            io.ktor.http.HttpStatusCode.BadRequest,
            "status must be one of ${feedbackThreadStatuses.sorted()}"
        )
    }
    val before = getFeedbackThread(id)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feedback thread not found")
    withTransaction { connection ->
        connection.prepareStatement(
            "UPDATE app.feedback_threads SET status = ?, updated_at = now() WHERE id = ?::uuid"
        ).use { stmt ->
            stmt.setString(1, status)
            stmt.setString(2, id)
            if (stmt.executeUpdate() == 0) {
                throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feedback thread not found")
            }
        }
    }
    val after = getFeedbackThread(id)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Feedback thread not found")
    audit.recordUpdate("feedback_thread", id, before.auditSnapshot(), after.auditSnapshot())
    after
} catch (exc: SQLException) {
    throw ApiException(
        io.ktor.http.HttpStatusCode.BadRequest,
        "Feedback thread status update failed: ${exc.message ?: "invalid feedback thread status"}"
    )
}

/** 証跡画像の実体参照 (UploadStorage 用)。存在しない・証跡なしの場合は null */
fun Database.getEvidenceReference(threadId: String): Pair<String, String>? =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT e.screenshot_path, e.content_type
            FROM app.feedback_threads AS t
            JOIN app.review_evidence AS e ON e.id = t.evidence_id
            WHERE t.id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, threadId)
            stmt.executeQuery().use { rs ->
                if (rs.next()) rs.getString(1) to rs.getString(2) else null
            }
        }
    }

// ---------------------------------------------------------------- 内部

private fun insertEvidence(connection: Connection, evidence: ReviewEvidenceInput): String =
    connection.prepareStatement(
        """
        INSERT INTO app.review_evidence (
            screenshot_path, content_type, byte_size, viewport_width, viewport_height,
            scroll_x, scroll_y, pixel_ratio, frontend_version, route, captured_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)
        RETURNING id::text
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, evidence.screenshotPath)
        stmt.setString(2, evidence.contentType)
        stmt.setLong(3, evidence.byteSize)
        stmt.setInt(4, evidence.viewportWidth)
        stmt.setInt(5, evidence.viewportHeight)
        stmt.setInt(6, evidence.scrollX)
        stmt.setInt(7, evidence.scrollY)
        stmt.setDouble(8, evidence.pixelRatio)
        stmt.setString(9, evidence.frontendVersion)
        stmt.setString(10, evidence.route)
        stmt.setString(11, evidence.capturedAt)
        stmt.executeQuery().use { rs ->
            rs.next()
            rs.getString(1)
        }
    }

private fun findScopeId(connection: Connection, reviewSessionId: String, pageId: String): String? =
    connection.prepareStatement(
        "SELECT id::text FROM app.review_scopes WHERE review_session_id = ?::uuid AND page_id = ?"
    ).use { stmt ->
        stmt.setString(1, reviewSessionId)
        stmt.setString(2, pageId)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    }

private fun listMessagesForThreads(
    connection: Connection,
    threadIds: List<String>
): Map<String, List<FeedbackMessageDto>> {
    if (threadIds.isEmpty()) return emptyMap()
    return connection.prepareStatement(
        """
        SELECT m.id::text, m.thread_id::text, m.author_id::text, u.display_name, m.body,
               m.created_at, m.edited_at
        FROM app.feedback_messages AS m
        LEFT JOIN app.users AS u ON u.id = m.author_id
        WHERE m.thread_id = ANY(?::uuid[])
        ORDER BY m.created_at, m.id
        """.trimIndent()
    ).use { stmt ->
        stmt.setArray(1, connection.createArrayOf("uuid", threadIds.toTypedArray()))
        stmt.executeQuery().use { rs ->
            buildMap<String, MutableList<FeedbackMessageDto>> {
                while (rs.next()) {
                    val threadId = rs.getString(2)
                    getOrPut(threadId) { mutableListOf() }.add(
                        FeedbackMessageDto(
                            id = rs.getString(1),
                            threadId = threadId,
                            authorId = rs.getString(3),
                            authorName = rs.getString(4),
                            body = rs.getString(5),
                            createdAt = rs.isoTimestamp("created_at") ?: error("created_at must not be null"),
                            editedAt = rs.isoTimestamp("edited_at")
                        )
                    )
                }
            }
        }
    }
}

private fun Database.getFeedbackMessage(id: String): FeedbackMessageDto? =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT m.id::text, m.thread_id::text, m.author_id::text, u.display_name, m.body,
                   m.created_at, m.edited_at
            FROM app.feedback_messages AS m
            LEFT JOIN app.users AS u ON u.id = m.author_id
            WHERE m.id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) return@use null
                FeedbackMessageDto(
                    id = rs.getString(1),
                    threadId = rs.getString(2),
                    authorId = rs.getString(3),
                    authorName = rs.getString(4),
                    body = rs.getString(5),
                    createdAt = rs.isoTimestamp("created_at") ?: error("created_at must not be null"),
                    editedAt = rs.isoTimestamp("edited_at")
                )
            }
        }
    }

private fun feedbackThreadColumns(): String = """
    t.id::text AS id,
    t.project_id::text AS project_id,
    t.review_session_id::text AS review_session_id,
    t.review_scope_id::text AS review_scope_id,
    t.perspective_code,
    p.label AS perspective_label,
    t.target_type,
    t.target_metadata::text AS target_metadata,
    t.status,
    t.created_by::text AS created_by,
    u.display_name AS created_by_name,
    t.created_at,
    t.updated_at,
    e.id::text AS evidence_id,
    e.content_type,
    e.byte_size,
    e.viewport_width,
    e.viewport_height,
    e.scroll_x,
    e.scroll_y,
    e.pixel_ratio,
    e.frontend_version,
    e.route,
    e.captured_at
""".trimIndent()

private fun ResultSet.toFeedbackThreadDto(): FeedbackThreadDto = FeedbackThreadDto(
    id = getString("id"),
    projectId = getString("project_id"),
    reviewSessionId = getString("review_session_id"),
    reviewScopeId = getString("review_scope_id"),
    perspectiveCode = getString("perspective_code"),
    perspectiveLabel = getString("perspective_label"),
    targetType = getString("target_type"),
    targetMetadata = databaseJson.parseToJsonElement(getString("target_metadata")) as JsonObject,
    evidence = getString("evidence_id")?.let { evidenceId ->
        ReviewEvidenceDto(
            id = evidenceId,
            contentType = getString("content_type"),
            byteSize = getLong("byte_size"),
            viewportWidth = getInt("viewport_width"),
            viewportHeight = getInt("viewport_height"),
            scrollX = getInt("scroll_x"),
            scrollY = getInt("scroll_y"),
            pixelRatio = getDouble("pixel_ratio"),
            frontendVersion = getString("frontend_version"),
            route = getString("route"),
            capturedAt = isoTimestamp("captured_at") ?: error("captured_at must not be null")
        )
    },
    status = getString("status"),
    createdBy = getString("created_by"),
    createdByName = getString("created_by_name"),
    createdAt = isoTimestamp("created_at") ?: error("created_at must not be null"),
    updatedAt = isoTimestamp("updated_at") ?: error("updated_at must not be null")
)

internal fun ResultSet.isoTimestamp(column: String): String? =
    getObject(column, OffsetDateTime::class.java)?.toString()

internal fun FeedbackThreadDto.auditSnapshot(): JsonObject =
    auditSnapshot(FeedbackThreadDto.serializer(), this, exclude = setOf("messages", "perspectiveLabel", "createdByName"))

internal fun FeedbackMessageDto.auditSnapshot(): JsonObject =
    auditSnapshot(FeedbackMessageDto.serializer(), this, exclude = setOf("authorName"))
