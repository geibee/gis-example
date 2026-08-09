package feedback.service

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.postgresql.util.PGobject
import java.sql.Connection
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID

fun FeedbackDatabase.resolvePrincipal(
    issuer: String,
    subject: String,
    email: String?,
    displayName: String?
): FeedbackPrincipal = transaction { connection ->
    connection.prepareStatement(
        """
        INSERT INTO feedback.users (id, issuer, subject, email, display_name)
        VALUES (?::uuid, ?, ?, ?, ?)
        ON CONFLICT (issuer, subject) DO UPDATE SET
            email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            updated_at = now()
        RETURNING id::text
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, issuer)
        statement.setString(3, subject)
        statement.setString(4, email)
        statement.setString(5, displayName)
        statement.executeQuery().use { result ->
            check(result.next())
            FeedbackPrincipal(result.getString(1), issuer, subject, email, displayName)
        }
    }
}

fun FeedbackDatabase.listMemberships(userId: String): List<Membership> = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT a.application_key, w.external_workspace_key, wm.permissions
        FROM feedback.workspace_memberships wm
        JOIN feedback.workspaces w ON w.id = wm.workspace_id
        JOIN feedback.applications a ON a.id = w.application_id
        WHERE wm.user_id = ?::uuid
        ORDER BY a.application_key, w.external_workspace_key
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, userId)
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    add(
                        Membership(
                            applicationKey = result.getString(1),
                            externalWorkspaceKey = result.getString(2),
                            permissions = (result.getArray(3).array as Array<*>).map { it.toString() }.sorted()
                        )
                    )
                }
            }
        }
    }
}

fun FeedbackDatabase.resolveApplicationScope(userId: String, applicationKey: String): ResourceScope =
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            SELECT t.id::text, t.tenant_key, a.id::text, a.application_key
            FROM feedback.application_memberships am
            JOIN feedback.applications a ON a.id = am.application_id
            JOIN feedback.tenants t ON t.id = a.tenant_id
            WHERE am.user_id = ?::uuid AND a.application_key = ?
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, userId)
            statement.setString(2, applicationKey)
            statement.executeQuery().use { result ->
                if (!result.next()) notFound()
                val scope = ResourceScope(
                    tenantId = result.getString(1),
                    tenantKey = result.getString(2),
                    applicationId = result.getString(3),
                    applicationKey = result.getString(4)
                )
                if (result.next()) conflict("applicationKey が複数 tenant で曖昧です", "application.ambiguous")
                scope
            }
        }
    }

fun FeedbackDatabase.resolveWorkspaceScope(
    userId: String,
    applicationKey: String,
    externalWorkspaceKey: String,
    environmentKey: String? = null
): ResourceScope = dataSource.connection.use { connection ->
    val environmentJoin = if (environmentKey == null) "" else
        "JOIN feedback.application_environments e ON e.application_id = a.id AND e.environment_key = ?"
    val environmentIdSelect = if (environmentKey == null) "NULL::text" else "e.id::text"
    val environmentKeySelect = if (environmentKey == null) "NULL::text" else "e.environment_key"
    connection.prepareStatement(
        """
        SELECT t.id::text, t.tenant_key, a.id::text, $environmentIdSelect, w.id::text,
               a.application_key, $environmentKeySelect, w.external_workspace_key
        FROM feedback.workspace_memberships wm
        JOIN feedback.workspaces w ON w.id = wm.workspace_id
        JOIN feedback.applications a ON a.id = w.application_id
        JOIN feedback.tenants t ON t.id = a.tenant_id
        $environmentJoin
        WHERE wm.user_id = ?::uuid
          AND a.application_key = ?
          AND w.external_workspace_key = ?
        """.trimIndent()
    ).use { statement ->
        var index = 1
        if (environmentKey != null) statement.setString(index++, environmentKey)
        statement.setString(index++, userId)
        statement.setString(index++, applicationKey)
        statement.setString(index, externalWorkspaceKey)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            val scope = result.toResourceScope()
            if (result.next()) conflict("workspace key が複数 tenant で曖昧です", "workspace.ambiguous")
            scope
        }
    }
}

fun FeedbackDatabase.resolveResourceScope(
    userId: String,
    kind: ScopeKind,
    resourceId: String
): ResourceScope = dataSource.connection.use { connection ->
    val (table, idColumn, joins) = when (kind) {
        ScopeKind.SESSION -> Triple("feedback.review_sessions r", "r.id", "")
        ScopeKind.THREAD -> Triple("feedback.feedback_threads r", "r.id", "")
        ScopeKind.MESSAGE -> Triple(
            "feedback.feedback_messages m",
            "m.id",
            "JOIN feedback.feedback_threads r ON r.id = m.thread_id"
        )
        ScopeKind.EXPORT -> Triple("feedback.export_jobs r", "r.id", "")
        ScopeKind.BACKUP -> Triple("feedback.backup_runs r", "r.id", "")
        else -> error("resource ID から解決できない scope kind です: $kind")
    }
    connection.prepareStatement(
        """
        SELECT r.tenant_id::text, t.tenant_key, r.application_id::text, r.environment_id::text, r.workspace_id::text,
               a.application_key, e.environment_key, w.external_workspace_key
        FROM $table
        $joins
        JOIN feedback.workspace_memberships wm ON wm.workspace_id = r.workspace_id AND wm.user_id = ?::uuid
        JOIN feedback.tenants t ON t.id = r.tenant_id
        JOIN feedback.applications a ON a.id = r.application_id
        JOIN feedback.application_environments e ON e.id = r.environment_id
        JOIN feedback.workspaces w ON w.id = r.workspace_id
        WHERE $idColumn = ?::uuid
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, userId)
        statement.setString(2, resourceId)
        statement.executeQuery().use { result ->
            if (!result.next()) notFound()
            result.toResourceScope()
        }
    }
}

fun FeedbackDatabase.applicationPermissions(userId: String, applicationId: String): Set<FeedbackPermission> =
    permissionQuery(
        "SELECT permissions FROM feedback.application_memberships WHERE user_id = ?::uuid AND application_id = ?::uuid",
        userId,
        applicationId
    )

fun FeedbackDatabase.workspacePermissions(userId: String, workspaceId: String): Set<FeedbackPermission> =
    permissionQuery(
        "SELECT permissions FROM feedback.workspace_memberships WHERE user_id = ?::uuid AND workspace_id = ?::uuid",
        userId,
        workspaceId
    )

fun FeedbackDatabase.isIssuerAllowed(
    scope: ResourceScope,
    issuer: String,
    applicationOnly: Boolean
): Boolean = dataSource.connection.use { connection ->
    val sql = when {
        !applicationOnly && scope.environmentId != null ->
            "SELECT ? = ANY(allowed_issuers) FROM feedback.application_environments WHERE id = ?::uuid"
        else ->
            "SELECT coalesce(bool_or(? = ANY(allowed_issuers)), false) " +
                "FROM feedback.application_environments WHERE application_id = ?::uuid"
    }
    connection.prepareStatement(sql).use { statement ->
        statement.setString(1, issuer.trimEnd('/'))
        statement.setString(2, if (!applicationOnly && scope.environmentId != null) scope.environmentId else scope.applicationId)
        statement.executeQuery().use { result -> result.next() && result.getBoolean(1) }
    }
}

private fun FeedbackDatabase.permissionQuery(sql: String, userId: String, resourceId: String): Set<FeedbackPermission> =
    dataSource.connection.use { connection ->
        connection.prepareStatement(sql).use { statement ->
            statement.setString(1, userId)
            statement.setString(2, resourceId)
            statement.executeQuery().use { result ->
                if (!result.next()) return@use emptySet()
                val values = (result.getArray(1).array as Array<*>).map { it.toString() }.toSet()
                FeedbackPermission.entries.filterTo(mutableSetOf()) { it.wireValue in values }
            }
        }
    }

fun FeedbackDatabase.recordAudit(
    scope: ResourceScope?,
    principalId: String?,
    action: String,
    resourceType: String?,
    resourceId: String?,
    outcome: String,
    requestId: String,
    changes: JsonObject?
) {
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            INSERT INTO feedback.audit_logs (
                id, tenant_id, application_id, workspace_id, principal_id, action,
                resource_type, resource_id, outcome, request_id, changes
            ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::jsonb)
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, UUID.randomUUID().toString())
            statement.setString(2, scope?.tenantId)
            statement.setString(3, scope?.applicationId)
            statement.setString(4, scope?.workspaceId)
            statement.setString(5, principalId)
            statement.setString(6, action)
            statement.setString(7, resourceType)
            statement.setString(8, resourceId)
            statement.setString(9, outcome)
            statement.setString(10, requestId)
            statement.setString(11, sanitizeAuditChanges(changes)?.toString())
            statement.executeUpdate()
        }
    }
}

/** 監査の全書き込み経路で、secret・本文・巨大値を同じ規則により無害化する。 */
internal fun sanitizeAuditChanges(changes: JsonObject?): JsonObject? =
    changes?.let { sanitizeAuditElement(it, null) as JsonObject }

private val auditSensitiveKey = Regex(
    "(?i)(password|passwd|token|secret|authorization|cookie|body|dataBase64|evidence|webhookEndpoint|privateKey)"
)

private fun sanitizeAuditElement(value: JsonElement, key: String?): JsonElement {
    if (key != null && auditSensitiveKey.containsMatchIn(key)) return JsonPrimitive("[REDACTED]")
    return when (value) {
        is JsonObject -> JsonObject(value.mapValues { (childKey, child) -> sanitizeAuditElement(child, childKey) })
        is JsonArray -> if (value.size <= 50) {
            JsonArray(value.map { sanitizeAuditElement(it, null) })
        } else {
            JsonArray(value.take(50).map { sanitizeAuditElement(it, null) } + JsonPrimitive("[TRUNCATED:${value.size}]") )
        }
        is JsonPrimitive -> if (value.isString && value.content.length > 1000) {
            JsonPrimitive("[SUMMARY:length=${value.content.length},sha256=${sha256(value.content.toByteArray())}]")
        } else value
    }
}

fun FeedbackDatabase.enforceWriteRateLimit(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    limitPerMinute: Int
): Unit = enforceWriteRateLimit(
    scope = scope,
    principal = principal,
    remoteAddress = "fixture",
    principalLimitPerMinute = limitPerMinute,
    tenantLimitPerMinute = Int.MAX_VALUE,
    ipLimitPerMinute = Int.MAX_VALUE
)

fun FeedbackDatabase.enforceWriteRateLimit(
    scope: ResourceScope,
    principal: FeedbackPrincipal,
    remoteAddress: String,
    principalLimitPerMinute: Int,
    tenantLimitPerMinute: Int,
    ipLimitPerMinute: Int,
    requestId: String = "unknown"
) {
    val dimensions = listOf(
        RateLimitDimension("tenant", scope.tenantId, tenantLimitPerMinute),
        RateLimitDimension("principal", principal.subject, principalLimitPerMinute),
        RateLimitDimension("ip", remoteAddress, ipLimitPerMinute)
    )
    val exceeded = transaction { connection ->
        dimensions.mapNotNull { dimension ->
            val count = connection.prepareStatement(
                """
                INSERT INTO feedback.write_rate_limit_counters (
                    tenant_id, dimension, subject_hash, window_epoch, request_count
                ) VALUES (?::uuid, ?, ?, floor(extract(epoch FROM now()) / 60)::bigint, 1)
                ON CONFLICT (tenant_id, dimension, subject_hash, window_epoch)
                DO UPDATE SET request_count = feedback.write_rate_limit_counters.request_count + 1
                RETURNING request_count
                """.trimIndent()
            ).use { statement ->
                statement.setString(1, scope.tenantId)
                statement.setString(2, dimension.name)
                statement.setString(3, sha256(dimension.subject.toByteArray()))
                statement.executeQuery().use { result -> result.next(); result.getInt(1) }
            }
            dimension.takeIf { count > it.limit }
        }
    }
    if (exceeded.isNotEmpty()) {
        recordOperationalMetric("rate_limit_rejections_total", scope.tenantId)
        recordAudit(
            scope = scope,
            principalId = principal.subject,
            action = "rate_limit",
            resourceType = "workspace",
            resourceId = scope.workspaceId,
            outcome = "denied",
            requestId = requestId,
            changes = JsonObject(mapOf("dimensions" to JsonArray(exceeded.map { JsonPrimitive(it.name) })))
        )
        throw FeedbackApiException(
            io.ktor.http.HttpStatusCode.TooManyRequests,
            "rate_limit.exceeded",
            "${exceeded.joinToString { it.name }} write rate limit を超えました"
        )
    }
}

fun FeedbackDatabase.recordOperationalMetric(metricName: String, tenantId: String, increment: Long = 1) {
    require(metricName.matches(Regex("[a-z][a-z0-9_]{0,99}"))) { "metric name が不正です" }
    require(increment > 0) { "metric increment は正数です" }
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            INSERT INTO feedback.operational_metric_counters (metric_name, tenant_id, value)
            VALUES (?, ?::uuid, ?)
            ON CONFLICT (metric_name, tenant_id)
            DO UPDATE SET value = feedback.operational_metric_counters.value + EXCLUDED.value, updated_at = now()
            """.trimIndent()
        ).use { statement ->
            statement.setString(1, metricName)
            statement.setString(2, tenantId)
            statement.setLong(3, increment)
            statement.executeUpdate()
        }
    }
}

internal fun Connection.incrementOperationalMetric(metricName: String, tenantId: String, increment: Long = 1) {
    prepareStatement(
        """
        INSERT INTO feedback.operational_metric_counters (metric_name, tenant_id, value)
        VALUES (?, ?::uuid, ?)
        ON CONFLICT (metric_name, tenant_id)
        DO UPDATE SET value = feedback.operational_metric_counters.value + EXCLUDED.value, updated_at = now()
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, metricName)
        statement.setString(2, tenantId)
        statement.setLong(3, increment)
        statement.executeUpdate()
    }
}

private data class RateLimitDimension(val name: String, val subject: String, val limit: Int)

internal fun ResultSet.toResourceScope(): ResourceScope = ResourceScope(
    tenantId = getString(1),
    tenantKey = getString(2),
    applicationId = getString(3),
    environmentId = getString(4),
    workspaceId = getString(5),
    applicationKey = getString(6),
    environmentKey = getString(7),
    externalWorkspaceKey = getString(8)
)

internal fun jsonb(value: String): PGobject = PGobject().apply {
    type = "jsonb"
    this.value = value
}

internal fun ResultSet.offsetDateTime(column: String): String? =
    getObject(column, OffsetDateTime::class.java)?.toInstant()?.toString()

internal fun Connection.lockIdempotency(principalId: String, endpoint: String, key: String) {
    prepareStatement("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").use { statement ->
        statement.setString(1, "$principalId\u001f$endpoint\u001f$key")
        statement.executeQuery().use { it.next() }
    }
}
