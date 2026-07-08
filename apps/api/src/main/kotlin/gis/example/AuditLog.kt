// 監査ログ: 変更系 (POST/PATCH/DELETE) の成功と、認証失敗・認可拒否 (401/403) を
// app.audit_logs へ記録する。記録はベストエフォート (失敗はログのみ、リクエストは落とさない)
package gis.example

import io.ktor.server.application.ApplicationPlugin
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.auth.principal
import io.ktor.server.plugins.callid.callId
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path

// PEP (AuthorizationEnforcement) が判定時に格納し、監査ログが読み出す
internal val AuditedAction = io.ktor.util.AttributeKey<Action>("audit.action")
internal val AuditedProjectId = io.ktor.util.AttributeKey<String>("audit.projectId")

private val mutationMethods = setOf("POST", "PATCH", "DELETE")

fun auditLogPlugin(db: Database): ApplicationPlugin<Unit> =
    createApplicationPlugin("AuditLog") {
        on(ResponseSent) { call ->
            val status = call.response.status()?.value ?: return@on
            val path = call.request.path()
            if (path.startsWith("/health")) return@on
            val method = call.request.httpMethod.value
            val denied = status == 401 || status == 403
            val mutationSucceeded = method in mutationMethods && status < 400
            if (!denied && !mutationSucceeded) return@on

            val principal = call.principal<AppPrincipal>()
            runCatching {
                db.insertAuditLog(
                    userId = principal?.userId,
                    subject = principal?.subject,
                    action = call.attributes.getOrNull(AuditedAction)?.name,
                    decision = if (denied) "deny" else "allow",
                    projectId = call.attributes.getOrNull(AuditedProjectId),
                    httpMethod = method,
                    path = path,
                    statusCode = status,
                    // CloudWatch Logs 上のアプリログ (MDC callId) と突合するためのリクエスト ID
                    callId = call.callId
                )
            }.onFailure { exc ->
                databaseLogger.warn("監査ログの書込みに失敗しました: {} {}", method, path, exc)
            }
        }
    }

internal fun Database.insertAuditLog(
    userId: String?,
    subject: String?,
    action: String?,
    decision: String,
    projectId: String?,
    httpMethod: String,
    path: String,
    statusCode: Int,
    callId: String?
) {
    dataSource.connection.use { connection ->
        connection.prepareStatement(
            """
            INSERT INTO app.audit_logs (
                user_id, subject, action, decision, project_id, http_method, path, status_code, call_id
            )
            VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?)
            """.trimIndent()
        ).use { stmt ->
            stmt.setString(1, userId)
            stmt.setString(2, subject)
            stmt.setString(3, action)
            stmt.setString(4, decision)
            stmt.setString(5, projectId)
            stmt.setString(6, httpMethod)
            stmt.setString(7, path)
            stmt.setInt(8, statusCode)
            stmt.setString(9, callId)
            stmt.executeUpdate()
        }
    }
}
