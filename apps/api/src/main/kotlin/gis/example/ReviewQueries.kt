// レビューセッション (app.review_sessions) と、その観点・対象画面のクエリ。
// 設計は docs/prototype-review.md。
//
// perspectives / scopes はセッションに従属し単独では意味を持たないため、
// 個別エンドポイントを設けず ReviewSession の一部として全置換する
// (「今回のレビューで何を見てもらうか」は原子的に決まるべき集合であるため)。
package gis.example

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.SQLException
import java.time.OffsetDateTime

/** レビューセッションの受付状態 */
internal val reviewSessionStatuses = setOf("draft", "open", "closed")

/** セッション内での観点の状態。FUTURE / OUT_OF_SCOPE は UI でグレーアウトして表示する */
internal val reviewPerspectiveStatuses = setOf("ACTIVE", "FUTURE", "OUT_OF_SCOPE")

fun Database.listReviewSessions(query: ReviewSessionListQuery): PagedList<ReviewSessionDto> =
    dataSource.connection.use { connection ->
        val filters = mutableListOf("s.project_id = ?::uuid")
        val binders = mutableListOf<(PreparedStatement, Int) -> Unit>(
            { stmt, index -> stmt.setString(index, query.projectId) }
        )
        query.status?.trim()?.takeIf { it.isNotEmpty() }?.let { status ->
            if (status !in reviewSessionStatuses) {
                throw ApiException(
                    io.ktor.http.HttpStatusCode.BadRequest,
                    "status must be one of ${reviewSessionStatuses.sorted()}"
                )
            }
            filters.add("s.status = ?")
            binders.add { stmt, index -> stmt.setString(index, status) }
        }
        val baseSql = """
            FROM app.review_sessions AS s
            ${whereClause(filters)}
        """.trimIndent()
        val totalCount = queryTotalCount(connection, baseSql, binders)
        val sessions = connection.prepareStatement(
            """
            SELECT ${reviewSessionColumns("s")}
            $baseSql
            ORDER BY s.created_at DESC, s.id${pagingClause(query.limit, query.offset)}
            """.trimIndent()
        ).use { stmt ->
            bindPatchValues(stmt, binders)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(rs.toReviewSessionDto())
                }
            }
        }
        // 行ごとの個別クエリ (N+1) を避け、ページ内のセッション ID をまとめて引く
        PagedList(items = withChildren(connection, sessions), totalCount = totalCount)
    }

fun Database.getReviewSession(id: String): ReviewSessionDto? = dataSource.connection.use { connection ->
    val session = connection.prepareStatement(
        """
        SELECT ${reviewSessionColumns("s")}
        FROM app.review_sessions AS s
        WHERE s.id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.toReviewSessionDto() else null }
    } ?: return@use null
    withChildren(connection, listOf(session)).single()
}

fun Database.createReviewSession(request: JsonObject, createdBy: String?, audit: AuditTrail): ReviewSessionDto = try {
    val projectId = readRequiredUuid(request, "projectId")
    val title = readRequiredText(request, "title")
    val description = readOptionalText(request, "description")
    val status = readReviewSessionStatus(request) ?: "draft"
    val startAt = readOptionalTimestamp(request, "startAt")
    val endAt = readOptionalTimestamp(request, "endAt")
    requireValidPeriod(startAt, endAt)
    val perspectives = readPerspectiveInputs(request)
    val scopes = readScopeInputs(request)

    val id = withTransaction { connection ->
        val newId = connection.prepareStatement(
            """
            INSERT INTO app.review_sessions (project_id, title, description, status, start_at, end_at, created_by)
            VALUES (?::uuid, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::uuid)
            RETURNING id::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setString(2, title)
            setNullableString(stmt, 3, description)
            stmt.setString(4, status)
            setNullableString(stmt, 5, startAt)
            setNullableString(stmt, 6, endAt)
            setNullableUuidString(stmt, 7, createdBy)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
        replacePerspectives(connection, newId, perspectives)
        replaceScopes(connection, newId, scopes)
        newId
    }
    val created = getReviewSession(id) ?: error("Created review session disappeared")
    audit.recordCreate("review_session", created.id, created.auditSnapshot())
    created
} catch (exc: SQLException) {
    throw ApiException(
        io.ktor.http.HttpStatusCode.BadRequest,
        "Review session create failed: ${exc.message ?: "invalid review session"}"
    )
}

fun Database.updateReviewSession(id: String, request: JsonObject, audit: AuditTrail): ReviewSessionDto = try {
    val before = getReviewSession(id)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Review session not found")

    val setters = mutableListOf<String>()
    val binders = mutableListOf<(PreparedStatement, Int) -> Unit>()
    addTextPatch(request, "title", "title", setters, binders, required = true)
    addTextPatch(request, "description", "description", setters, binders)
    readReviewSessionStatus(request)?.let { status ->
        setters.add("status = ?")
        binders.add { stmt, index -> stmt.setString(index, status) }
    }
    // 期間は片側だけの更新でも整合を検査するため、変更後の値で突き合わせる
    val startAt = if ("startAt" in request) readOptionalTimestamp(request, "startAt") else before.startAt
    val endAt = if ("endAt" in request) readOptionalTimestamp(request, "endAt") else before.endAt
    requireValidPeriod(startAt, endAt)
    if ("startAt" in request) {
        setters.add("start_at = ?::timestamptz")
        binders.add { stmt, index -> setNullableString(stmt, index, startAt) }
    }
    if ("endAt" in request) {
        setters.add("end_at = ?::timestamptz")
        binders.add { stmt, index -> setNullableString(stmt, index, endAt) }
    }
    // 観点・対象画面はキーがある場合のみ全置換する (部分更新は「何を外したか」が曖昧になる)
    val perspectives = if ("perspectives" in request) readPerspectiveInputs(request) else null
    val scopes = if ("scopes" in request) readScopeInputs(request) else null

    withTransaction { connection ->
        if (setters.isNotEmpty()) {
            connection.prepareStatement(
                """
                UPDATE app.review_sessions
                SET ${setters.joinToString(", ")}, updated_at = now()
                WHERE id = ?::uuid
                """.trimIndent()
            ).use { stmt ->
                bindPatchValues(stmt, binders)
                stmt.setString(binders.size + 1, id)
                if (stmt.executeUpdate() == 0) {
                    throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Review session not found")
                }
            }
        }
        if (perspectives != null) replacePerspectives(connection, id, perspectives)
        if (scopes != null) replaceScopes(connection, id, scopes)
    }

    val after = getReviewSession(id)
        ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Review session not found")
    audit.recordUpdate("review_session", id, before.auditSnapshot(), after.auditSnapshot())
    after
} catch (exc: SQLException) {
    throw ApiException(
        io.ktor.http.HttpStatusCode.BadRequest,
        "Review session update failed: ${exc.message ?: "invalid review session"}"
    )
}

// ---------------------------------------------------------------- 子要素 (観点・対象画面)

internal data class ReviewPerspectiveInput(val code: String, val status: String, val guidance: String?)

internal data class ReviewScopeInput(val pageId: String, val description: String?, val reviewable: Boolean)

private fun Database.withChildren(
    connection: Connection,
    sessions: List<ReviewSessionDto>
): List<ReviewSessionDto> {
    if (sessions.isEmpty()) return sessions
    val ids = sessions.map { it.id }
    val perspectives = listPerspectivesForSessions(connection, ids)
    val scopes = listScopesForSessions(connection, ids)
    return sessions.map { session ->
        session.copy(
            perspectives = perspectives[session.id].orEmpty(),
            scopes = scopes[session.id].orEmpty()
        )
    }
}

private fun listPerspectivesForSessions(
    connection: Connection,
    sessionIds: List<String>
): Map<String, List<ReviewPerspectiveDto>> = connection.prepareStatement(
    """
    SELECT sp.review_session_id::text AS session_id, p.code, p.label, p.description, p.display_order,
           sp.status, sp.guidance
    FROM app.review_session_perspectives AS sp
    JOIN app.review_perspectives AS p ON p.code = sp.perspective_code
    WHERE sp.review_session_id = ANY(?::uuid[])
    ORDER BY p.display_order, p.code
    """.trimIndent()
).use { stmt ->
    stmt.setArray(1, connection.createArrayOf("uuid", sessionIds.toTypedArray()))
    stmt.executeQuery().use { rs ->
        buildMap<String, MutableList<ReviewPerspectiveDto>> {
            while (rs.next()) {
                getOrPut(rs.getString("session_id")) { mutableListOf() }.add(
                    ReviewPerspectiveDto(
                        code = rs.getString("code"),
                        label = rs.getString("label"),
                        description = rs.getString("description"),
                        displayOrder = rs.getInt("display_order"),
                        status = rs.getString("status"),
                        guidance = rs.getString("guidance")
                    )
                )
            }
        }
    }
}

private fun listScopesForSessions(
    connection: Connection,
    sessionIds: List<String>
): Map<String, List<ReviewScopeDto>> = connection.prepareStatement(
    """
    SELECT review_session_id::text AS session_id, id::text, page_id, description, reviewable, display_order
    FROM app.review_scopes
    WHERE review_session_id = ANY(?::uuid[])
    ORDER BY display_order, page_id
    """.trimIndent()
).use { stmt ->
    stmt.setArray(1, connection.createArrayOf("uuid", sessionIds.toTypedArray()))
    stmt.executeQuery().use { rs ->
        buildMap<String, MutableList<ReviewScopeDto>> {
            while (rs.next()) {
                getOrPut(rs.getString("session_id")) { mutableListOf() }.add(
                    ReviewScopeDto(
                        id = rs.getString("id"),
                        pageId = rs.getString("page_id"),
                        description = rs.getString("description"),
                        reviewable = rs.getBoolean("reviewable"),
                        displayOrder = rs.getInt("display_order")
                    )
                )
            }
        }
    }
}

private fun replacePerspectives(
    connection: Connection,
    sessionId: String,
    perspectives: List<ReviewPerspectiveInput>
) {
    connection.prepareStatement("DELETE FROM app.review_session_perspectives WHERE review_session_id = ?::uuid")
        .use { stmt ->
            stmt.setString(1, sessionId)
            stmt.executeUpdate()
        }
    if (perspectives.isEmpty()) return
    connection.prepareStatement(
        """
        INSERT INTO app.review_session_perspectives (review_session_id, perspective_code, status, guidance)
        VALUES (?::uuid, ?, ?, ?)
        """.trimIndent()
    ).use { stmt ->
        for (perspective in perspectives) {
            stmt.setString(1, sessionId)
            stmt.setString(2, perspective.code)
            stmt.setString(3, perspective.status)
            setNullableString(stmt, 4, perspective.guidance)
            stmt.addBatch()
        }
        stmt.executeBatch()
    }
}

private fun replaceScopes(connection: Connection, sessionId: String, scopes: List<ReviewScopeInput>) {
    connection.prepareStatement("DELETE FROM app.review_scopes WHERE review_session_id = ?::uuid").use { stmt ->
        stmt.setString(1, sessionId)
        stmt.executeUpdate()
    }
    if (scopes.isEmpty()) return
    connection.prepareStatement(
        """
        INSERT INTO app.review_scopes (review_session_id, page_id, description, reviewable, display_order)
        VALUES (?::uuid, ?, ?, ?, ?)
        """.trimIndent()
    ).use { stmt ->
        scopes.forEachIndexed { index, scope ->
            stmt.setString(1, sessionId)
            stmt.setString(2, scope.pageId)
            setNullableString(stmt, 3, scope.description)
            stmt.setBoolean(4, scope.reviewable)
            // 表示順はリクエストの配列順 (顧客に見せる並びをそのまま保存する)
            stmt.setInt(5, (index + 1) * 10)
            stmt.addBatch()
        }
        stmt.executeBatch()
    }
}

// ---------------------------------------------------------------- リクエスト読み取り

internal fun readReviewSessionStatus(request: JsonObject): String? {
    val status = readOptionalText(request, "status") ?: return null
    if (status !in reviewSessionStatuses) {
        throw ApiException(
            io.ktor.http.HttpStatusCode.BadRequest,
            "status must be one of ${reviewSessionStatuses.sorted()}"
        )
    }
    return status
}

internal fun readPerspectiveInputs(request: JsonObject): List<ReviewPerspectiveInput> {
    val element = request["perspectives"] ?: return emptyList()
    val array = try {
        element.jsonArray
    } catch (exc: IllegalArgumentException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "perspectives must be an array")
    }
    val inputs = array.map { item ->
        val entry = try {
            item.jsonObject
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "perspectives must be an array of objects")
        }
        val status = readRequiredText(entry, "status")
        if (status !in reviewPerspectiveStatuses) {
            throw ApiException(
                io.ktor.http.HttpStatusCode.BadRequest,
                "perspectives[].status must be one of ${reviewPerspectiveStatuses.sorted()}"
            )
        }
        ReviewPerspectiveInput(
            code = readRequiredText(entry, "code"),
            status = status,
            guidance = readOptionalText(entry, "guidance")
        )
    }
    val duplicated = inputs.groupingBy { it.code }.eachCount().filterValues { it > 1 }.keys
    if (duplicated.isNotEmpty()) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "perspectives[].code is duplicated: $duplicated")
    }
    return inputs
}

internal fun readScopeInputs(request: JsonObject): List<ReviewScopeInput> {
    val element = request["scopes"] ?: return emptyList()
    val array = try {
        element.jsonArray
    } catch (exc: IllegalArgumentException) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "scopes must be an array")
    }
    val inputs = array.map { item ->
        val entry = try {
            item.jsonObject
        } catch (exc: IllegalArgumentException) {
            throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "scopes must be an array of objects")
        }
        ReviewScopeInput(
            pageId = readRequiredText(entry, "pageId"),
            description = readOptionalText(entry, "description"),
            // 既定は「レビュー対象」。対象外の画面を明示的に並べたいときだけ false にする
            reviewable = readOptionalBoolean(entry, "reviewable") ?: true
        )
    }
    val duplicated = inputs.groupingBy { it.pageId }.eachCount().filterValues { it > 1 }.keys
    if (duplicated.isNotEmpty()) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "scopes[].pageId is duplicated: $duplicated")
    }
    return inputs
}

internal fun requireValidPeriod(startAt: String?, endAt: String?) {
    if (startAt == null || endAt == null) return
    if (OffsetDateTime.parse(endAt).isBefore(OffsetDateTime.parse(startAt))) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "endAt must not be before startAt")
    }
}

// ---------------------------------------------------------------- 行 → DTO

// 期間 (startAt / endAt) は「いつまでレビュー可能か」を機械的に比較する値なので、
// PostgreSQL の既定表記ではなくオフセット付き ISO-8601 で返す。同じ DTO 内で表記が
// 割れないよう createdAt / updatedAt も揃える
private fun reviewSessionColumns(alias: String): String = """
    $alias.id::text AS id,
    $alias.project_id::text AS project_id,
    $alias.title,
    $alias.description,
    $alias.status,
    $alias.start_at,
    $alias.end_at,
    $alias.created_by::text AS created_by,
    $alias.created_at,
    $alias.updated_at
""".trimIndent()

private fun java.sql.ResultSet.toReviewSessionDto(): ReviewSessionDto = ReviewSessionDto(
    id = getString("id"),
    projectId = getString("project_id"),
    title = getString("title"),
    description = getString("description"),
    status = getString("status"),
    startAt = isoTimestamp("start_at"),
    endAt = isoTimestamp("end_at"),
    createdBy = getString("created_by"),
    createdAt = isoTimestamp("created_at") ?: error("created_at must not be null"),
    updatedAt = isoTimestamp("updated_at") ?: error("updated_at must not be null")
)

private fun java.sql.ResultSet.isoTimestamp(column: String): String? =
    getObject(column, OffsetDateTime::class.java)?.toString()

internal fun ReviewSessionDto.auditSnapshot(): JsonObject =
    auditSnapshot(ReviewSessionDto.serializer(), this)
