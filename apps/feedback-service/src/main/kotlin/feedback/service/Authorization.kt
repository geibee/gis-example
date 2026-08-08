package feedback.service

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.callid.callId
import kotlinx.serialization.json.JsonObject

internal val feedbackRoutePolicies: Set<RoutePolicy> = setOf(
    RoutePolicy("GET", "/applications/{}/manifest", FeedbackPermission.READ, ScopeKind.APPLICATION),
    RoutePolicy("PUT", "/applications/{}/manifest", FeedbackPermission.ADMIN, ScopeKind.APPLICATION, mutate = true),
    RoutePolicy("GET", "/review-context", FeedbackPermission.READ, ScopeKind.WORKSPACE),
    RoutePolicy("GET", "/sessions", FeedbackPermission.READ, ScopeKind.WORKSPACE),
    RoutePolicy("POST", "/sessions", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/sessions/{}", FeedbackPermission.READ, ScopeKind.SESSION),
    RoutePolicy("PATCH", "/sessions/{}", FeedbackPermission.MANAGE, ScopeKind.SESSION, mutate = true),
    RoutePolicy("GET", "/sessions/{}/threads", FeedbackPermission.READ, ScopeKind.SESSION),
    RoutePolicy("POST", "/sessions/{}/threads", FeedbackPermission.COMMENT, ScopeKind.SESSION, mutate = true),
    RoutePolicy("GET", "/threads/{}", FeedbackPermission.READ, ScopeKind.THREAD),
    RoutePolicy("POST", "/threads/{}/messages", FeedbackPermission.COMMENT, ScopeKind.THREAD, mutate = true),
    RoutePolicy("PATCH", "/messages/{}", FeedbackPermission.COMMENT, ScopeKind.MESSAGE, mutate = true),
    RoutePolicy("GET", "/messages/{}/versions", FeedbackPermission.READ, ScopeKind.MESSAGE),
    RoutePolicy("PATCH", "/threads/{}/status", FeedbackPermission.MANAGE, ScopeKind.THREAD, mutate = true),
    RoutePolicy("GET", "/threads/{}/evidence", FeedbackPermission.READ, ScopeKind.THREAD),
    RoutePolicy("POST", "/exports", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/retention-policy", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE),
    RoutePolicy("PATCH", "/retention-policy", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/notification-settings", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("PATCH", "/notification-settings", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true)
)

data class AuthorizedContext(
    val principal: FeedbackPrincipal,
    val scope: ResourceScope,
    val permissions: Set<FeedbackPermission>
)

internal fun authorize(
    db: FeedbackDatabase,
    call: ApplicationCall,
    permission: FeedbackPermission,
    scope: ResourceScope,
    applicationOnly: Boolean = false,
    hideExistence: Boolean = false
): AuthorizedContext {
    val principal = call.feedbackPrincipal()
    val databasePermissions = if (applicationOnly) {
        db.applicationPermissions(principal.userId, scope.applicationId)
    } else {
        db.workspacePermissions(principal.userId, requireNotNull(scope.workspaceId))
    }
    val tokenScopeMatches = principal.tokenScope?.matches(scope, applicationOnly) ?: true
    val permissions = databasePermissions.expanded().let { expanded ->
        principal.tokenScope?.permissions?.expanded()?.let(expanded::intersect) ?: expanded
    }
    val allowed = tokenScopeMatches && permission in permissions
    db.recordAudit(
        scope = scope,
        principalId = principal.subject,
        action = permission.wireValue,
        resourceType = if (applicationOnly) "application" else "workspace",
        resourceId = if (applicationOnly) scope.applicationId else scope.workspaceId,
        outcome = if (allowed) "allowed" else "denied",
        requestId = call.callId ?: "unknown",
        changes = null
    )
    if (!allowed) {
        if (hideExistence) notFound()
        throw FeedbackApiException(HttpStatusCode.Forbidden, "permission.denied", "必要な feedback permission がありません")
    }
    return AuthorizedContext(principal, scope, permissions)
}

internal fun auditMutation(
    db: FeedbackDatabase,
    call: ApplicationCall,
    context: AuthorizedContext,
    action: String,
    resourceType: String,
    resourceId: String,
    changes: JsonObject? = null
) {
    db.recordAudit(
        scope = context.scope,
        principalId = context.principal.subject,
        action = action,
        resourceType = resourceType,
        resourceId = resourceId,
        outcome = "succeeded",
        requestId = call.callId ?: "unknown",
        changes = changes
    )
}

internal fun Set<FeedbackPermission>.allows(required: FeedbackPermission): Boolean {
    if (FeedbackPermission.ADMIN in this) return true
    return when (required) {
        FeedbackPermission.ADMIN -> false
        FeedbackPermission.MANAGE -> FeedbackPermission.MANAGE in this
        FeedbackPermission.COMMENT -> FeedbackPermission.COMMENT in this || FeedbackPermission.MANAGE in this
        FeedbackPermission.READ -> isNotEmpty()
    }
}

internal fun Set<FeedbackPermission>.expanded(): Set<FeedbackPermission> =
    FeedbackPermission.entries.filterTo(mutableSetOf()) { allows(it) }

internal fun FeedbackTokenScope.matches(scope: ResourceScope, applicationOnly: Boolean): Boolean =
    tenantKey == scope.tenantKey &&
        applicationKey == scope.applicationKey &&
        (applicationOnly || (
            externalWorkspaceKey == scope.externalWorkspaceKey &&
                (scope.environmentKey == null || environmentKey == scope.environmentKey)
            ))

internal fun FeedbackPrincipal.restrict(memberships: List<Membership>): List<Membership> {
    val token = tokenScope ?: return memberships
    val tokenPermissions = token.permissions.expanded().map { it.wireValue }.toSet()
    return memberships.filter {
        it.applicationKey == token.applicationKey && it.externalWorkspaceKey == token.externalWorkspaceKey
    }.map { membership ->
        val databasePermissions = membership.permissions.mapNotNull { value ->
            FeedbackPermission.entries.firstOrNull { it.wireValue == value }
        }.toSet().expanded().map { it.wireValue }.toSet()
        membership.copy(permissions = (databasePermissions intersect tokenPermissions).sorted())
    }
}
