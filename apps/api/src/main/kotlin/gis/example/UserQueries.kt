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
