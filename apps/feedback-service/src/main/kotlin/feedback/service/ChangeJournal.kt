package feedback.service

import java.sql.Connection
import kotlinx.serialization.json.JsonObject

internal fun appendFeedbackChange(
    connection: Connection,
    scope: ResourceScope,
    eventType: String,
    resourceType: String,
    resourceId: String,
    payload: JsonObject = JsonObject(emptyMap())
) {
    connection.prepareStatement(
        """
        INSERT INTO feedback.feedback_change_journal (
            tenant_id, application_id, environment_id, workspace_id,
            event_type, resource_type, resource_id, payload
        ) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?::jsonb)
        """.trimIndent()
    ).use { statement ->
        statement.setString(1, scope.tenantId)
        statement.setString(2, scope.applicationId)
        statement.setString(3, scope.environmentId)
        statement.setString(4, scope.workspaceId)
        statement.setString(5, eventType)
        statement.setString(6, resourceType)
        statement.setString(7, resourceId)
        statement.setString(8, payload.toString())
        statement.executeUpdate()
    }
}
