// app.users のクエリ: 認証時のユーザー解決 (JIT プロビジョニング) を担う
package gis.example

import java.sql.Connection

internal data class UserRecord(
    val id: String,
    val email: String?,
    val displayName: String?,
    val systemRole: SystemRole,
    val isActive: Boolean
)

// 認証済み JWT のクレームを app.users と突合する。
// - 未登録の subject は user ロールで自動登録する (メンバーシップゼロ = 既定拒否なので安全)
// - email が AUTH_ADMIN_EMAILS にあれば admin へ昇格する (初期管理者のブートストラップ用。
//   環境変数から外しても自動では降格しない)
// - is_active = false のユーザーは null を返す (= 401)
fun Database.resolveUser(
    subject: String,
    email: String?,
    displayName: String?,
    adminEmails: Set<String>
): AppPrincipal? = dataSource.connection.use { connection ->
    val shouldBeAdmin = email != null && email.lowercase() in adminEmails
    val existing = selectUser(connection, subject)
    val needsUpsert = existing == null ||
        (email != null && email != existing.email) ||
        (displayName != null && displayName != existing.displayName) ||
        (shouldBeAdmin && existing.systemRole != SystemRole.ADMIN)
    val user = if (needsUpsert) upsertUser(connection, subject, email, displayName, shouldBeAdmin) else existing
    if (!user.isActive) return null
    AppPrincipal(
        userId = user.id,
        subject = subject,
        email = user.email,
        displayName = user.displayName,
        systemRole = user.systemRole,
        memberships = selectMemberships(connection, user.id)
    )
}

private fun selectMemberships(connection: Connection, userId: String): Map<String, ProjectRole> =
    connection.prepareStatement(
        """
        SELECT project_id::text, role
        FROM app.project_members
        WHERE user_id = ?::uuid
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, userId)
        stmt.executeQuery().use { rs ->
            buildMap {
                while (rs.next()) {
                    put(
                        rs.getString(1),
                        if (rs.getString(2) == "editor") ProjectRole.EDITOR else ProjectRole.VIEWER
                    )
                }
            }
        }
    }

private fun selectUser(connection: Connection, subject: String): UserRecord? =
    connection.prepareStatement(
        """
        SELECT id::text, email, display_name, system_role, is_active
        FROM app.users
        WHERE subject = ?
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, subject)
        stmt.executeQuery().use { rs ->
            if (rs.next()) readUserRecord(rs) else null
        }
    }

// 同一 subject の同時初回アクセスでも一意制約違反にならないよう単一の upsert にする
private fun upsertUser(
    connection: Connection,
    subject: String,
    email: String?,
    displayName: String?,
    shouldBeAdmin: Boolean
): UserRecord =
    connection.prepareStatement(
        """
        INSERT INTO app.users (subject, email, display_name, system_role)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (subject) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, app.users.email),
            display_name = COALESCE(EXCLUDED.display_name, app.users.display_name),
            system_role = CASE
                WHEN EXCLUDED.system_role = 'admin' THEN 'admin'
                ELSE app.users.system_role
            END,
            updated_at = now()
        RETURNING id::text, email, display_name, system_role, is_active
        """.trimIndent()
    ).use { stmt ->
        stmt.setString(1, subject)
        stmt.setString(2, email)
        stmt.setString(3, displayName)
        stmt.setString(4, if (shouldBeAdmin) "admin" else "user")
        stmt.executeQuery().use { rs ->
            check(rs.next()) { "users への upsert が行を返しませんでした" }
            readUserRecord(rs)
        }
    }

private fun readUserRecord(rs: java.sql.ResultSet): UserRecord =
    UserRecord(
        id = rs.getString("id"),
        email = rs.getString("email"),
        displayName = rs.getString("display_name"),
        systemRole = if (rs.getString("system_role") == "admin") SystemRole.ADMIN else SystemRole.USER,
        isActive = rs.getBoolean("is_active")
    )

// ---------------------------------------------------------------- 管理 API (admin 専用)

fun Database.listUsers(): List<UserDto> = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT id::text, subject, email, display_name, system_role, is_active, created_at::text
        FROM app.users
        ORDER BY created_at
        """.trimIndent()
    ).use { stmt ->
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(
                        UserDto(
                            id = rs.getString("id"),
                            subject = rs.getString("subject"),
                            email = rs.getString("email"),
                            displayName = rs.getString("display_name"),
                            systemRole = rs.getString("system_role"),
                            isActive = rs.getBoolean("is_active"),
                            createdAt = rs.getString("created_at")
                        )
                    )
                }
            }
        }
    }
}

fun Database.updateUser(id: String, request: UserPatchRequest, audit: AuditTrail): UserDto {
    if (request.systemRole != null && request.systemRole !in setOf("admin", "user")) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "systemRole must be 'admin' or 'user'")
    }
    return dataSource.connection.use { connection ->
        // 監査 diff 用の変更前スナップショット (存在しない ID は従来どおり 404)
        val before = connection.prepareStatement(
            """
            SELECT id::text, subject, email, display_name, system_role, is_active, created_at::text
            FROM app.users
            WHERE id = ?::uuid
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs ->
                if (rs.next()) rs.toUserDto() else null
            }
        } ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "User not found")
        val updated = connection.prepareStatement(
            """
            UPDATE app.users
            SET system_role = COALESCE(?, system_role),
                is_active = COALESCE(?, is_active),
                updated_at = now()
            WHERE id = ?::uuid
            RETURNING id::text, subject, email, display_name, system_role, is_active, created_at::text
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, request.systemRole)
            if (request.isActive == null) {
                stmt.setNull(2, java.sql.Types.BOOLEAN)
            } else {
                stmt.setBoolean(2, request.isActive)
            }
            stmt.setString(3, id)
            stmt.executeQuery().use { rs ->
                if (!rs.next()) throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "User not found")
                rs.toUserDto()
            }
        }
        audit.recordUpdate("user", id, before.auditSnapshot(), updated.auditSnapshot())
        updated
    }
}

private fun java.sql.ResultSet.toUserDto(): UserDto = UserDto(
    id = getString("id"),
    subject = getString("subject"),
    email = getString("email"),
    displayName = getString("display_name"),
    systemRole = getString("system_role"),
    isActive = getBoolean("is_active"),
    createdAt = getString("created_at")
)

fun Database.listProjectMembers(projectId: String): List<ProjectMemberDto> =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT m.user_id::text, m.project_id::text, m.role, u.email, u.display_name
            FROM app.project_members AS m
            JOIN app.users AS u ON u.id = m.user_id
            WHERE m.project_id = ?::uuid
            ORDER BY u.created_at
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            ProjectMemberDto(
                                userId = rs.getString("user_id"),
                                projectId = rs.getString("project_id"),
                                role = rs.getString("role"),
                                email = rs.getString("email"),
                                displayName = rs.getString("display_name")
                            )
                        )
                    }
                }
            }
        }
    }

fun Database.putProjectMember(projectId: String, userId: String, role: String, audit: AuditTrail): ProjectMemberDto {
    if (role !in setOf("editor", "viewer")) {
        throw ApiException(io.ktor.http.HttpStatusCode.BadRequest, "role must be 'editor' or 'viewer'")
    }
    return dataSource.connection.use { connection ->
        // 監査 diff 用: 既存メンバーなら upsert 前のロールを取っておく
        val beforeRole = findMemberRole(connection, projectId, userId)
        val updated = connection.prepareStatement(
            """
            INSERT INTO app.project_members (user_id, project_id, role)
            SELECT u.id, p.id, ?
            FROM app.users AS u, app.projects AS p
            WHERE u.id = ?::uuid AND p.id = ?::uuid
            ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, role)
            stmt.setString(2, userId)
            stmt.setString(3, projectId)
            stmt.executeUpdate()
        }
        // ユーザーかプロジェクトが存在しなければ INSERT ... SELECT が 0 行になる
        if (updated == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "User or project not found")
        }
        val member = listProjectMembers(projectId).first { it.userId == userId }
        val memberKey = "$projectId/$userId"
        if (beforeRole == null) {
            audit.recordCreate("projectMember", memberKey, member.auditSnapshot())
        } else {
            audit.recordUpdate(
                "projectMember",
                memberKey,
                ProjectMemberDto(userId = userId, projectId = projectId, role = beforeRole).auditSnapshot(),
                member.auditSnapshot()
            )
        }
        member
    }
}

fun Database.deleteProjectMember(projectId: String, userId: String, audit: AuditTrail) {
    dataSource.connection.use { connection ->
        // 監査 diff 用の削除前スナップショット (存在しないメンバーは従来どおり 404)
        val beforeRole = findMemberRole(connection, projectId, userId)
            ?: throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Member not found")
        val deleted = connection.prepareStatement(
            "DELETE FROM app.project_members WHERE project_id = ?::uuid AND user_id = ?::uuid"
        ).use { stmt ->
            stmt.setString(1, projectId)
            stmt.setString(2, userId)
            stmt.executeUpdate()
        }
        if (deleted == 0) {
            throw ApiException(io.ktor.http.HttpStatusCode.NotFound, "Member not found")
        }
        audit.recordDelete(
            "projectMember",
            "$projectId/$userId",
            ProjectMemberDto(userId = userId, projectId = projectId, role = beforeRole).auditSnapshot()
        )
    }
}

private fun findMemberRole(connection: java.sql.Connection, projectId: String, userId: String): String? =
    connection.prepareStatement(
        "SELECT role FROM app.project_members WHERE project_id = ?::uuid AND user_id = ?::uuid"
    ).use { stmt ->
        stmt.setString(1, projectId)
        stmt.setString(2, userId)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString("role") else null }
    }
