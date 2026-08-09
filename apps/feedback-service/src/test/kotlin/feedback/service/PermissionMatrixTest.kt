package feedback.service

import kotlin.test.Test
import kotlin.test.assertEquals

class PermissionMatrixTest {
    @Test
    fun `permission の包含関係は固定語彙だけで決まる`() {
        val expected = mapOf(
            emptySet<FeedbackPermission>() to emptySet(),
            setOf(FeedbackPermission.READ) to setOf(FeedbackPermission.READ),
            setOf(FeedbackPermission.COMMENT) to setOf(FeedbackPermission.READ, FeedbackPermission.COMMENT),
            setOf(FeedbackPermission.MANAGE) to
                setOf(FeedbackPermission.READ, FeedbackPermission.COMMENT, FeedbackPermission.MANAGE),
            setOf(FeedbackPermission.ADMIN) to FeedbackPermission.entries.toSet()
        )
        expected.forEach { (granted, allowed) ->
            assertEquals(allowed, FeedbackPermission.entries.filter { granted.allows(it) }.toSet())
        }
    }

    @Test
    fun `exchange token は DB permission と resource scope を必ず狭める`() {
        val token = FeedbackTokenScope(
            tenantKey = "tenant-a",
            applicationKey = "app-a",
            environmentKey = "prod",
            externalWorkspaceKey = "workspace-a",
            permissions = setOf(FeedbackPermission.COMMENT)
        )
        val matching = ResourceScope(
            tenantId = "tenant-id-a",
            tenantKey = "tenant-a",
            applicationId = "app-id-a",
            environmentId = "env-id-a",
            workspaceId = "workspace-id-a",
            applicationKey = "app-a",
            environmentKey = "prod",
            externalWorkspaceKey = "workspace-a"
        )
        assertEquals(true, token.matches(matching, applicationOnly = false))
        assertEquals(
            setOf(FeedbackPermission.READ, FeedbackPermission.COMMENT),
            setOf(FeedbackPermission.ADMIN).expanded().intersect(token.permissions.expanded())
        )
        assertEquals(false, token.matches(matching.copy(externalWorkspaceKey = "workspace-b"), applicationOnly = false))
        assertEquals(false, token.matches(matching.copy(environmentKey = "staging"), applicationOnly = false))
    }
}
