package feedback.service

import java.net.URI
import java.util.UUID

fun main() {
    val database = FeedbackDatabase.create(DatabaseSettings.fromEnv())
    try {
        database.migrate()
        val input = BootstrapInput.fromEnv()
        val result = database.bootstrap(input)
        println("Feedback resources provisioned: tenant=${result.tenantId} application=${result.applicationId} workspace=${result.workspaceId}")
    } finally {
        database.close()
    }
}

data class BootstrapInput(
    val tenantKey: String,
    val tenantDisplayName: String,
    val applicationKey: String,
    val applicationDisplayName: String,
    val environmentKey: String,
    val environmentBaseUrl: String,
    val allowedOrigins: List<String>,
    val externalWorkspaceKey: String,
    val workspaceDisplayName: String,
    val issuer: String,
    val subject: String,
    val email: String?,
    val displayName: String?,
    val permissions: Set<FeedbackPermission>
) {
    companion object {
        fun fromEnv(): BootstrapInput {
            val permissions = requiredEnv("FEEDBACK_BOOTSTRAP_PERMISSIONS").split(',').map { raw ->
                val value = raw.trim()
                FeedbackPermission.entries.firstOrNull { it.wireValue == value }
                    ?: error("不明な feedback permission です: $value")
            }.toSet()
            require(permissions.isNotEmpty()) { "FEEDBACK_BOOTSTRAP_PERMISSIONS は 1 件以上必要です" }
            val baseUrl = validateServiceUrl(requiredEnv("FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL"), "base URL")
            val origins = requiredEnv("FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS").split(',').map { raw ->
                validateOrigin(raw.trim())
            }.distinct()
            return BootstrapInput(
                tenantKey = validateKey(requiredEnv("FEEDBACK_BOOTSTRAP_TENANT_KEY"), "tenantKey", 100),
                tenantDisplayName = validateKey(
                    requiredEnv("FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME"),
                    "tenantDisplayName",
                    200
                ),
                applicationKey = validateApplicationKey(requiredEnv("FEEDBACK_BOOTSTRAP_APPLICATION_KEY")),
                applicationDisplayName = validateKey(
                    requiredEnv("FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME"),
                    "applicationDisplayName",
                    200
                ),
                environmentKey = validateKey(
                    requiredEnv("FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY"),
                    "environmentKey",
                    100
                ),
                environmentBaseUrl = baseUrl,
                allowedOrigins = origins,
                externalWorkspaceKey = validateKey(
                    requiredEnv("FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY"),
                    "externalWorkspaceKey",
                    200
                ),
                workspaceDisplayName = validateKey(
                    requiredEnv("FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME"),
                    "workspaceDisplayName",
                    200
                ),
                issuer = validateServiceUrl(requiredEnv("FEEDBACK_BOOTSTRAP_ISSUER"), "issuer").trimEnd('/'),
                subject = validateKey(requiredEnv("FEEDBACK_BOOTSTRAP_SUBJECT"), "subject", 200),
                email = System.getenv("FEEDBACK_BOOTSTRAP_EMAIL")?.takeIf { it.isNotBlank() }
                    ?.also { require(it.length <= 320) { "FEEDBACK_BOOTSTRAP_EMAIL は 320 文字以下です" } },
                displayName = System.getenv("FEEDBACK_BOOTSTRAP_DISPLAY_NAME")?.takeIf { it.isNotBlank() }
                    ?.also { require(it.length <= 200) { "FEEDBACK_BOOTSTRAP_DISPLAY_NAME は 200 文字以下です" } },
                permissions = permissions
            )
        }
    }
}

data class BootstrapResult(
    val tenantId: String,
    val applicationId: String,
    val environmentId: String,
    val workspaceId: String,
    val userId: String
)

fun FeedbackDatabase.bootstrap(input: BootstrapInput): BootstrapResult = transaction { connection ->
    val tenantId = upsertReturningId(
        connection,
        """
        INSERT INTO feedback.tenants (id, tenant_key, display_name)
        VALUES (?::uuid, ?, ?)
        ON CONFLICT (tenant_key) DO UPDATE SET display_name = EXCLUDED.display_name
        RETURNING id::text
        """.trimIndent(),
        UUID.randomUUID().toString(),
        input.tenantKey,
        input.tenantDisplayName
    )
    val applicationId = connection.prepareStatement(
        """
        INSERT INTO feedback.applications (id, tenant_id, application_key, display_name)
        VALUES (?::uuid, ?::uuid, ?, ?)
        ON CONFLICT (application_key) DO UPDATE SET display_name = EXCLUDED.display_name
        WHERE feedback.applications.tenant_id = EXCLUDED.tenant_id
        RETURNING id::text
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, tenantId)
        statement.setString(3, input.applicationKey)
        statement.setString(4, input.applicationDisplayName)
        statement.executeQuery().use { result ->
            if (!result.next()) conflict("applicationKey は別 tenant で使用済みです", "application.key_conflict")
            result.getString(1)
        }
    }
    val environmentId = connection.prepareStatement(
        """
        INSERT INTO feedback.application_environments (
            id, application_id, environment_key, base_url, allowed_origins
        ) VALUES (?::uuid, ?::uuid, ?, ?, ?)
        ON CONFLICT (application_id, environment_key) DO UPDATE SET
            base_url = EXCLUDED.base_url, allowed_origins = EXCLUDED.allowed_origins
        RETURNING id::text
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, applicationId)
        statement.setString(3, input.environmentKey)
        statement.setString(4, input.environmentBaseUrl)
        statement.setArray(5, connection.createArrayOf("text", input.allowedOrigins.toTypedArray()))
        statement.executeQuery().use { result -> result.next(); result.getString(1) }
    }
    val workspaceId = connection.prepareStatement(
        """
        INSERT INTO feedback.workspaces (
            id, tenant_id, application_id, external_workspace_key, display_name
        ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?)
        ON CONFLICT (application_id, external_workspace_key) DO UPDATE SET display_name = EXCLUDED.display_name
        RETURNING id::text
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, tenantId)
        statement.setString(3, applicationId)
        statement.setString(4, input.externalWorkspaceKey)
        statement.setString(5, input.workspaceDisplayName)
        statement.executeQuery().use { result -> result.next(); result.getString(1) }
    }
    val userId = connection.prepareStatement(
        """
        INSERT INTO feedback.users (id, issuer, subject, email, display_name)
        VALUES (?::uuid, ?, ?, ?, ?)
        ON CONFLICT (issuer, subject) DO UPDATE SET
            email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
        RETURNING id::text
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, UUID.randomUUID().toString())
        statement.setString(2, input.issuer)
        statement.setString(3, input.subject)
        statement.setString(4, input.email)
        statement.setString(5, input.displayName)
        statement.executeQuery().use { result -> result.next(); result.getString(1) }
    }
    val permissionValues = input.permissions.map { it.wireValue }.sorted().toTypedArray()
    connection.prepareStatement(
        """
        INSERT INTO feedback.application_memberships (application_id, user_id, permissions)
        VALUES (?::uuid, ?::uuid, ?)
        ON CONFLICT (application_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, applicationId)
        statement.setString(2, userId)
        statement.setArray(3, connection.createArrayOf("text", permissionValues))
        statement.executeUpdate()
    }
    connection.prepareStatement(
        """
        INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions)
        VALUES (?::uuid, ?::uuid, ?)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
            permissions = EXCLUDED.permissions,
            version = feedback.workspace_memberships.version + 1,
            updated_at = now()
        WHERE feedback.workspace_memberships.permissions IS DISTINCT FROM EXCLUDED.permissions
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, workspaceId)
        statement.setString(2, userId)
        statement.setArray(3, connection.createArrayOf("text", permissionValues))
        statement.executeUpdate()
    }
    BootstrapResult(tenantId, applicationId, environmentId, workspaceId, userId)
}

private fun upsertReturningId(connection: java.sql.Connection, sql: String, vararg values: String): String =
    connection.prepareStatement(sql).use { statement ->
        values.forEachIndexed { index, value -> statement.setString(index + 1, value) }
        statement.executeQuery().use { result -> result.next(); result.getString(1) }
    }

private fun validateOrigin(raw: String): String {
    val uri = URI(raw)
    val localHttp = uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1")
    require((uri.scheme == "https" || localHttp) && uri.host != null &&
        uri.rawPath.orEmpty().isEmpty() && uri.rawQuery == null && uri.rawFragment == null && uri.userInfo == null) {
        "origin は https://host[:port] (ローカル開発だけ http://localhost) で指定してください: $raw"
    }
    return raw.trimEnd('/')
}

private fun validateServiceUrl(raw: String, name: String): String {
    val uri = URI(raw)
    val localHttp = uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1")
    require((uri.scheme == "https" || localHttp) && uri.host != null && uri.userInfo == null && uri.fragment == null) {
        "$name は userinfo/fragment を含まない https URL (ローカル開発だけ http://localhost) で指定してください"
    }
    return raw
}
