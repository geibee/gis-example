package feedback.service

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.callid.callId
import io.ktor.util.AttributeKey
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
    RoutePolicy("GET", "/threads/{}/deep-link", FeedbackPermission.READ, ScopeKind.THREAD),
    RoutePolicy("POST", "/threads/{}/messages", FeedbackPermission.COMMENT, ScopeKind.THREAD, mutate = true),
    RoutePolicy("PATCH", "/messages/{}", FeedbackPermission.COMMENT, ScopeKind.MESSAGE, mutate = true),
    RoutePolicy("GET", "/messages/{}/versions", FeedbackPermission.READ, ScopeKind.MESSAGE),
    RoutePolicy("PATCH", "/threads/{}/status", FeedbackPermission.MANAGE, ScopeKind.THREAD, mutate = true),
    RoutePolicy("GET", "/threads/{}/evidence", FeedbackPermission.READ, ScopeKind.THREAD),
    RoutePolicy("POST", "/exports", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/exports/{}", FeedbackPermission.MANAGE, ScopeKind.EXPORT),
    RoutePolicy("GET", "/exports/{}/download", FeedbackPermission.MANAGE, ScopeKind.EXPORT),
    RoutePolicy("GET", "/backup-policy", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("PATCH", "/backup-policy", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/backups", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE),
    RoutePolicy("GET", "/backups/{}", FeedbackPermission.MANAGE, ScopeKind.BACKUP),
    RoutePolicy("GET", "/backups/{}/download", FeedbackPermission.MANAGE, ScopeKind.BACKUP),
    RoutePolicy("POST", "/backups/{}/retry", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/retention-policy", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE),
    RoutePolicy("PATCH", "/retention-policy", FeedbackPermission.MANAGE, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/notification-settings", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("PATCH", "/notification-settings", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/memberships", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("POST", "/memberships", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("PATCH", "/memberships/{}", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("DELETE", "/memberships/{}", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/notification-deliveries", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("POST", "/notification-deliveries/{}/retry", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("GET", "/connector-types", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("GET", "/notification-connectors", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE),
    RoutePolicy("POST", "/notification-connectors", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("PATCH", "/notification-connectors/{}", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true),
    RoutePolicy("DELETE", "/notification-connectors/{}", FeedbackPermission.ADMIN, ScopeKind.WORKSPACE, mutate = true)
)

data class AuthorizedContext(
    val principal: FeedbackPrincipal,
    val scope: ResourceScope,
    val permissions: Set<FeedbackPermission>
)

internal val auditTenantKey = AttributeKey<String>("feedback.tenant")
internal val auditApplicationKey = AttributeKey<String>("feedback.application")
internal val auditEnvironmentKey = AttributeKey<String>("feedback.environment")
internal val auditWorkspaceKey = AttributeKey<String>("feedback.workspace")

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
    val issuerAllowed = db.isIssuerAllowed(scope, principal.issuer, applicationOnly)
    val permissions = databasePermissions.expanded().let { expanded ->
        principal.tokenScope?.permissions?.expanded()?.let(expanded::intersect) ?: expanded
    }
    val allowed = issuerAllowed && tokenScopeMatches && permission in permissions
    call.attributes.put(auditTenantKey, scope.tenantKey)
    call.attributes.put(auditApplicationKey, scope.applicationKey)
    scope.environmentKey?.let { call.attributes.put(auditEnvironmentKey, it) }
    scope.externalWorkspaceKey?.let { call.attributes.put(auditWorkspaceKey, it) }
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
