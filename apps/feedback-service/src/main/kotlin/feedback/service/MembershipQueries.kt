package feedback.service

import java.sql.Connection

fun FeedbackDatabase.listWorkspaceMembers(scope: ResourceScope): List<FeedbackWorkspaceMember> =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT u.id::text, u.issuer, u.subject, u.email, u.display_name, wm.permissions, wm.version
            FROM feedback.workspace_memberships wm
            JOIN feedback.users u ON u.id = wm.user_id
            WHERE wm.workspace_id = ?::uuid
            ORDER BY COALESCE(u.display_name, u.subject), u.id
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) {
                        add(
                            FeedbackWorkspaceMember(
                                userId = result.getString(1),
                                issuer = result.getString(2),
                                subject = result.getString(3),
                                email = result.getString(4),
                                displayName = result.getString(5),
                                permissions = (result.getArray(6).array as Array<*>).map { it.toString() }.sorted(),
                                version = result.getInt(7)
                            )
                        )
                    }
                }
            }
        }
    }

fun FeedbackDatabase.createWorkspaceMember(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    request: FeedbackMembershipCreateRequest,
    idempotencyKey: String,
    hash: String
): FeedbackWorkspaceMember = idempotent(
    scope = scope,
    principal = principal,
    endpoint = "POST /memberships",
    key = idempotencyKey,
    requestHash = hash,
    responseStatus = 201,
    serializer = FeedbackWorkspaceMember.serializer()
) { connection ->
    validateMembershipRequest(request.issuer, request.subject, request.permissions)
    val userId = connection.prepareStatement(
        "SELECT id::text FROM feedback.users WHERE issuer = ? AND subject = ?"
    ).use { statement ->
        statement.setString(1, request.issuer)
        statement.setString(2, request.subject)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound("指定したOIDC主体はまだFeedback Serviceへ登録されていません")
            result.getString(1)
        }
    }
    try {
        connection.prepareStatement(
            """
            INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions)
            VALUES (?::uuid, ?::uuid, ?)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.setString(2, userId)
            statement.setArray(3, connection.createArrayOf("text", request.permissions.distinct().sorted().toTypedArray()))
            statement.executeUpdate()
        }
    } catch (exception: java.sql.SQLException) {
        if (exception.sqlState == "23505") conflict("membership は既に存在します", "membership.exists")
        throw exception
    }
    readWorkspaceMember(connection, requireNotNull(scope.workspaceId), userId)
}

fun FeedbackDatabase.patchWorkspaceMember(
    scope: ResourceScope,
    userId: String,
    expectedVersion: Int,
    request: FeedbackMembershipPatchRequest
): FeedbackWorkspaceMember = transaction { connection ->
    validateMembershipRequest("issuer", "subject", request.permissions, validateIdentity = false)
    connection.prepareStatement(
        """
        UPDATE feedback.workspace_memberships SET permissions = ?, version = version + 1, updated_at = now()
        WHERE workspace_id = ?::uuid AND user_id = ?::uuid AND version = ?
        """.trimIndent()
    ).use { statement ->
        statement.setArray(1, connection.createArrayOf("text", request.permissions.distinct().sorted().toTypedArray()))
        statement.setString(2, scope.workspaceId)
        statement.setString(3, userId)
        statement.setInt(4, expectedVersion)
        if (statement.executeUpdate() != 1) preconditionFailed()
    }
    readWorkspaceMember(connection, requireNotNull(scope.workspaceId), userId)
}

fun FeedbackDatabase.deleteWorkspaceMember(scope: ResourceScope, userId: String, expectedVersion: Int) {
    transaction { connection ->
        val member = readWorkspaceMember(connection, requireNotNull(scope.workspaceId), userId)
        if ("feedback.admin" in member.permissions) {
            val otherAdmins = connection.prepareStatement(
                """
                SELECT count(*) FROM feedback.workspace_memberships
                WHERE workspace_id = ?::uuid AND user_id <> ?::uuid
                  AND permissions @> ARRAY['feedback.admin']::text[]
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, scope.workspaceId)
                statement.setString(2, userId)
                statement.executeQuery().use { result -> result.next(); result.getInt(1) }
            }
            if (otherAdmins == 0) conflict("workspace最後のadminは削除できません", "membership.last_admin")
        }
        connection.prepareStatement(
            "DELETE FROM feedback.workspace_memberships WHERE workspace_id = ?::uuid AND user_id = ?::uuid AND version = ?"
        ).use { statement ->
            statement.setString(1, scope.workspaceId)
            statement.setString(2, userId)
            statement.setInt(3, expectedVersion)
            if (statement.executeUpdate() != 1) preconditionFailed()
        }
    }
}

private fun validateMembershipRequest(
    issuer: String,
    subject: String,
    permissions: List<String>,
    validateIdentity: Boolean = true
) {
    if (validateIdentity) {
        validateKey(issuer, "issuer", 1000)
        validateKey(subject, "subject", 200)
    }
    val allowed = FeedbackPermission.entries.map { it.wireValue }.toSet()
    if (permissions.isEmpty() || permissions.size != permissions.distinct().size || permissions.any { it !in allowed }) {
        badRequest("permissions はFeedback permissionを重複なく1件以上指定してください")
    }
}

private fun readWorkspaceMember(connection: Connection, workspaceId: String, userId: String): FeedbackWorkspaceMember =
    connection.prepareStatement(
        """
        SELECT u.id::text, u.issuer, u.subject, u.email, u.display_name, wm.permissions, wm.version
        FROM feedback.workspace_memberships wm
        JOIN feedback.users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ?::uuid AND wm.user_id = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, workspaceId)
        statement.setString(2, userId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            FeedbackWorkspaceMember(
                userId = result.getString(1),
                issuer = result.getString(2),
                subject = result.getString(3),
                email = result.getString(4),
                displayName = result.getString(5),
                permissions = (result.getArray(6).array as Array<*>).map { it.toString() }.sorted(),
                version = result.getInt(7)
            )
        }
    }
