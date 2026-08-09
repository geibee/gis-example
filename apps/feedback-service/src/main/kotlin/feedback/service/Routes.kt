package feedback.service

import io.ktor.http.ContentDisposition
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.AuthenticationStrategy
import io.ktor.server.plugins.callid.callId
import io.ktor.server.request.receive
import io.ktor.server.plugins.origin
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

data class FeedbackDependencies(
    val database: FeedbackDatabase,
    val evidenceStorage: EvidenceStorage,
    val evidenceMaxBytes: Long,
    val evidenceKeyPrefix: String,
    val writeRateLimitPerMinute: Int,
    val notificationCipher: NotificationCipher,
    val exportStorage: EvidenceStorage,
    val evidenceMaxCountPerWorkspace: Int = 1000,
    val writeRateLimitPerTenantPerMinute: Int = 1200,
    val writeRateLimitPerIpPerMinute: Int = 240
)

fun Route.healthRoutes(
    database: FeedbackDatabase,
    evidenceStorage: EvidenceStorage,
    evidencePrefix: String = "evidence/",
    exportStorage: EvidenceStorage,
    exportPrefix: String = "exports/",
    metrics: FeedbackServiceMetrics? = null
) {
    get("/health/live") { call.respond(mapOf("status" to "live")) }
    get("/health/ready") {
        try {
            database.ping()
            val evidence = try {
                evidenceStorage.list(evidencePrefix)
                "available"
            } catch (_: Exception) {
                "unavailable"
            }
            val export = try {
                exportStorage.list(exportPrefix)
                "available"
            } catch (_: Exception) {
                "unavailable"
            }
            val notification = database.dependencyHealth()
            val ready = evidence == "available" && export == "available"
            val response = mapOf(
                "status" to if (ready) "ready" else "unavailable",
                "database" to "available",
                "evidenceStorage" to evidence,
                "exportStorage" to export,
                "notification" to notification.notification,
                "notificationFailedDeliveries" to notification.failedDeliveries.toString(),
                "outboxLagSeconds" to notification.outboxLagSeconds.toString()
            )
            call.respond(if (ready) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable, response)
        } catch (_: Exception) {
            call.respond(
                HttpStatusCode.ServiceUnavailable,
                mapOf(
                    "status" to "unavailable",
                    "database" to "unavailable",
                    "evidenceStorage" to "unknown",
                    "exportStorage" to "unknown",
                    "notification" to "unknown"
                )
            )
        }
    }
    get("/metrics") {
        val body = metrics?.render() ?: database.let { FeedbackServiceMetrics(it).render() }
        call.respondText(body, ContentType.parse("text/plain; version=0.0.4; charset=utf-8"))
    }
}

fun Route.feedbackRoutes(dependencies: FeedbackDependencies) {
    val database = dependencies.database
    route("/feedback/v1") {
        get("/capabilities") {
            try {
                database.ping()
                call.respond(
                    FeedbackCapabilities(
                        evidence = CapabilitiesEvidencePolicy(
                            maxBytes = dependencies.evidenceMaxBytes,
                            maxCountPerWorkspace = dependencies.evidenceMaxCountPerWorkspace
                        ),
                        features = listOf(
                            "application-manifest",
                            "idempotency",
                            "etag",
                            "message-history",
                            "private-evidence",
                            "rate-limit",
                            "notification-outbox"
                        )
                    )
                )
            } catch (_: Exception) {
                throw FeedbackApiException(HttpStatusCode.ServiceUnavailable, "database.unavailable", "database を利用できません")
            }
        }
        authenticate(
            FEEDBACK_AUTH_NAME,
            FEEDBACK_EXCHANGE_AUTH_NAME,
            strategy = AuthenticationStrategy.FirstSuccessful
        ) {
            get("/me") {
                val principal = call.feedbackPrincipal()
                call.respond(FeedbackMe(principal.participant(), principal.restrict(database.listMemberships(principal.userId))))
            }

            route("/applications/{applicationKey}/manifest") {
                get {
                    val principal = call.feedbackPrincipal()
                    val applicationKey = validateApplicationKey(call.parameters["applicationKey"] ?: badRequest("applicationKey がありません"))
                    val scope = database.resolveApplicationScope(principal.userId, applicationKey)
                    authorize(database, call, FeedbackPermission.READ, scope, applicationOnly = true, hideExistence = true)
                    val (manifest, _) = database.getManifest(scope)
                    call.respond(manifest)
                }
                put {
                    val principal = call.feedbackPrincipal()
                    val applicationKey = validateApplicationKey(call.parameters["applicationKey"] ?: badRequest("applicationKey がありません"))
                    val scope = database.resolveApplicationScope(principal.userId, applicationKey)
                    val context = authorize(
                        database,
                        call,
                        FeedbackPermission.ADMIN,
                        scope,
                        applicationOnly = true,
                        hideExistence = true
                    )
                    val manifest = validateManifest(applicationKey, call.receive<JsonObject>())
                    val expectedVersion = call.request.headers[HttpHeaders.IfMatch]?.let(::parseEtag)
                    val (saved, version) = database.putManifest(scope, principal, manifest, expectedVersion)
                    call.response.header(HttpHeaders.ETag, etag(version))
                    auditMutation(database, call, context, "manifest.put", "application-manifest", applicationKey)
                    call.respond(saved)
                }
            }

            get("/review-context") {
                val principal = call.feedbackPrincipal()
                val query = call.request.queryParameters
                val applicationKey = validateApplicationKey(query.required("applicationKey"))
                val environmentKey = validateKey(query.required("environmentKey"), "environmentKey", 100)
                val externalWorkspaceKey = validateKey(query.required("externalWorkspaceKey"), "externalWorkspaceKey", 200)
                validateKey(query.required("release"), "release", 100)
                query["locale"]?.let { validateKey(it, "locale", 35) }
                val pageKey = validateKey(query.required("pageKey"), "pageKey", 100)
                val routeTemplate = validateKey(query.required("routeTemplate"), "routeTemplate", 500)
                val pathParameters = parseJsonObject(query.required("pathParameters"), "pathParameters")
                val queryParameters = query["queryParameters"]?.let { parseJsonObject(it, "queryParameters") }
                val scope = database.resolveWorkspaceScope(
                    principal.userId,
                    applicationKey,
                    externalWorkspaceKey,
                    environmentKey
                )
                val context = authorize(database, call, FeedbackPermission.READ, scope)
                val (manifest, _) = database.getManifest(scope)
                sanitizeLocation(
                    JsonObject(buildMap {
                        put("schemaVersion", JsonPrimitive("1"))
                        put("pageKey", JsonPrimitive(pageKey))
                        put("routeTemplate", JsonPrimitive(routeTemplate))
                        put("pathParameters", pathParameters)
                        if (queryParameters != null) put("queryParameters", queryParameters)
                    }),
                    manifest
                )
                call.respond(
                    database.reviewContext(
                        scope,
                        pageKey,
                        routeTemplate,
                        context.permissions,
                        dependencies.evidenceMaxBytes
                    )
                )
            }

            route("/sessions") {
                get {
                    val principal = call.feedbackPrincipal()
                    val query = call.request.queryParameters
                    val scope = database.resolveWorkspaceScope(
                        principal.userId,
                        validateApplicationKey(query.required("applicationKey")),
                        validateKey(query.required("externalWorkspaceKey"), "externalWorkspaceKey", 200),
                        validateKey(query.required("environmentKey"), "environmentKey", 100)
                    )
                    authorize(database, call, FeedbackPermission.READ, scope)
                    val status = query["status"]?.also { validateSessionStatus(it) }
                    val limit = parseLimit(query["limit"])
                    call.respond(database.listSessions(scope, status, limit, decodeCursor(query["cursor"])))
                }
                post {
                    val principal = call.feedbackPrincipal()
                    val requestElement = call.receive<JsonElement>()
                    val request = decode(requestElement, FeedbackSessionCreateRequest.serializer())
                    val scope = database.resolveWorkspaceScope(
                        principal.userId,
                        validateApplicationKey(request.applicationKey),
                        validateKey(request.externalWorkspaceKey, "externalWorkspaceKey", 200),
                        validateKey(request.environmentKey, "environmentKey", 100)
                    )
                    val context = authorize(database, call, FeedbackPermission.MANAGE, scope)
                    val session = database.createSession(
                        scope,
                        principal,
                        request,
                        validateIdempotencyKey(call.request.headers["Idempotency-Key"]),
                        requestHash(requestElement)
                    )
                    call.response.header(HttpHeaders.ETag, etag(session.version))
                    auditMutation(database, call, context, "session.create", "session", session.id)
                    call.respond(HttpStatusCode.Created, session)
                }
            }

            route("/sessions/{sessionId}") {
                get {
                    val sessionId = validateUuid(call.parameters["sessionId"], "sessionId")
                    val principal = call.feedbackPrincipal()
                    val scope = database.resolveResourceScope(principal.userId, ScopeKind.SESSION, sessionId)
                    authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                    val session = database.getSession(sessionId)
                    call.response.header(HttpHeaders.ETag, etag(session.version))
                    call.respond(session)
                }
                patch {
                    val sessionId = validateUuid(call.parameters["sessionId"], "sessionId")
                    val principal = call.feedbackPrincipal()
                    val scope = database.resolveResourceScope(principal.userId, ScopeKind.SESSION, sessionId)
                    val context = authorize(database, call, FeedbackPermission.MANAGE, scope, hideExistence = true)
                    val patch = call.receive<JsonObject>()
                    val session = database.patchSession(sessionId, parseEtag(call.request.headers[HttpHeaders.IfMatch]), patch)
                    call.response.header(HttpHeaders.ETag, etag(session.version))
                    auditMutation(database, call, context, "session.patch", "session", session.id)
                    call.respond(session)
                }
            }

            route("/sessions/{sessionId}/threads") {
                get {
                    val sessionId = validateUuid(call.parameters["sessionId"], "sessionId")
                    val principal = call.feedbackPrincipal()
                    val scope = database.resolveResourceScope(principal.userId, ScopeKind.SESSION, sessionId)
                    authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                    val status = call.request.queryParameters["status"]?.also { validateThreadStatus(it) }
                    call.respond(
                        database.listThreads(
                            sessionId,
                            status,
                            parseLimit(call.request.queryParameters["limit"]),
                            decodeCursor(call.request.queryParameters["cursor"])
                        )
                    )
                }
                post {
                    val sessionId = validateUuid(call.parameters["sessionId"], "sessionId")
                    val principal = call.feedbackPrincipal()
                    val scope = database.resolveResourceScope(principal.userId, ScopeKind.SESSION, sessionId)
                    val context = authorize(database, call, FeedbackPermission.COMMENT, scope, hideExistence = true)
                    enforceWriteRateLimit(database, dependencies, call, scope, principal)
                    val requestElement = call.receive<JsonElement>()
                    val request = decode(requestElement, FeedbackThreadCreateRequest.serializer())
                    val thread = database.createThread(
                        scope,
                        sessionId,
                        principal,
                        request,
                        validateIdempotencyKey(call.request.headers["Idempotency-Key"]),
                        requestHash(requestElement),
                        dependencies.evidenceStorage,
                        dependencies.evidenceKeyPrefix,
                        dependencies.evidenceMaxBytes,
                        dependencies.evidenceMaxCountPerWorkspace,
                        call.callId ?: "unknown"
                    )
                    call.response.header(HttpHeaders.ETag, etag(thread.version))
                    auditMutation(database, call, context, "thread.create", "thread", thread.id)
                    call.respond(HttpStatusCode.Created, thread)
                }
            }

            get("/threads/{threadId}") {
                val threadId = validateUuid(call.parameters["threadId"], "threadId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.THREAD, threadId)
                authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                val thread = database.getThread(threadId)
                call.response.header(HttpHeaders.ETag, etag(thread.version))
                call.respond(thread)
            }

            get("/threads/{threadId}/deep-link") {
                val threadId = validateUuid(call.parameters["threadId"], "threadId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.THREAD, threadId)
                authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                call.respond(database.getThreadDeepLink(threadId))
            }

            post("/threads/{threadId}/messages") {
                val threadId = validateUuid(call.parameters["threadId"], "threadId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.THREAD, threadId)
                val context = authorize(database, call, FeedbackPermission.COMMENT, scope, hideExistence = true)
                enforceWriteRateLimit(database, dependencies, call, scope, principal)
                val requestElement = call.receive<JsonElement>()
                val request = decode(requestElement, FeedbackMessageCreateRequest.serializer())
                val message = database.createMessage(
                    scope,
                    threadId,
                    principal,
                    request,
                    validateIdempotencyKey(call.request.headers["Idempotency-Key"]),
                    requestHash(requestElement),
                    call.callId ?: "unknown"
                )
                call.response.header(HttpHeaders.ETag, etag(message.version))
                auditMutation(database, call, context, "message.create", "message", message.id)
                call.respond(HttpStatusCode.Created, message)
            }

            patch("/messages/{messageId}") {
                val messageId = validateUuid(call.parameters["messageId"], "messageId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.MESSAGE, messageId)
                val context = authorize(database, call, FeedbackPermission.COMMENT, scope, hideExistence = true)
                val request = call.receive<FeedbackMessagePatchRequest>()
                val message = database.patchMessage(
                    messageId,
                    principal,
                    parseEtag(call.request.headers[HttpHeaders.IfMatch]),
                    request
                )
                call.response.header(HttpHeaders.ETag, etag(message.version))
                auditMutation(database, call, context, "message.patch", "message", message.id)
                call.respond(message)
            }

            get("/messages/{messageId}/versions") {
                val messageId = validateUuid(call.parameters["messageId"], "messageId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.MESSAGE, messageId)
                authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                call.respond(database.listMessageVersions(messageId))
            }

            patch("/threads/{threadId}/status") {
                val threadId = validateUuid(call.parameters["threadId"], "threadId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.THREAD, threadId)
                val context = authorize(database, call, FeedbackPermission.MANAGE, scope, hideExistence = true)
                val request = call.receive<ThreadStatusPatchRequest>()
                val thread = database.patchThreadStatus(
                    scope,
                    threadId,
                    principal,
                    parseEtag(call.request.headers[HttpHeaders.IfMatch]),
                    request.status,
                    call.callId ?: "unknown"
                )
                call.response.header(HttpHeaders.ETag, etag(thread.version))
                auditMutation(database, call, context, "thread.status.patch", "thread", thread.id)
                call.respond(thread)
            }

            get("/threads/{threadId}/evidence") {
                val threadId = validateUuid(call.parameters["threadId"], "threadId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.THREAD, threadId)
                val context = authorize(database, call, FeedbackPermission.READ, scope, hideExistence = true)
                val evidence = database.getEvidence(threadId, dependencies.evidenceStorage)
                auditMutation(database, call, context, "evidence.read", "thread", threadId)
                call.response.header(HttpHeaders.AcceptRanges, "bytes")
                call.response.header(
                    HttpHeaders.ContentDisposition,
                    ContentDisposition.Attachment.withParameter(ContentDisposition.Parameters.FileName, "feedback-evidence").toString()
                )
                val requestedRange = call.request.headers[HttpHeaders.Range]
                if (requestedRange == null) {
                    call.respondBytes(evidence.bytes, ContentType.parse(evidence.contentType))
                } else {
                    val range = parseByteRange(requestedRange, evidence.bytes.size)
                    call.response.header(
                        HttpHeaders.ContentRange,
                        "bytes ${range.first}-${range.last}/${evidence.bytes.size}"
                    )
                    call.respondBytes(
                        evidence.bytes.copyOfRange(range.first, range.last + 1),
                        ContentType.parse(evidence.contentType),
                        HttpStatusCode.PartialContent
                    )
                }
            }

            post("/exports") {
                val principal = call.feedbackPrincipal()
                val requestElement = call.receive<JsonElement>()
                val request = decode(requestElement, FeedbackExportRequest.serializer())
                val scope = database.resolveWorkspaceScope(
                    principal.userId,
                    validateApplicationKey(request.applicationKey),
                    validateKey(request.externalWorkspaceKey, "externalWorkspaceKey", 200),
                    validateKey(request.environmentKey, "environmentKey", 100)
                )
                val context = authorize(database, call, FeedbackPermission.MANAGE, scope)
                enforceWriteRateLimit(database, dependencies, call, scope, principal)
                val job = database.createExport(
                    scope,
                    principal,
                    request,
                    validateIdempotencyKey(call.request.headers["Idempotency-Key"]),
                    requestHash(requestElement)
                )
                auditMutation(database, call, context, "export.create", "export", job.id)
                call.respond(HttpStatusCode.Accepted, job)
            }

            get("/exports/{exportId}") {
                val exportId = validateUuid(call.parameters["exportId"], "exportId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.EXPORT, exportId)
                authorize(database, call, FeedbackPermission.MANAGE, scope, hideExistence = true)
                call.respond(database.getExportJob(exportId))
            }

            get("/exports/{exportId}/download") {
                val exportId = validateUuid(call.parameters["exportId"], "exportId")
                val principal = call.feedbackPrincipal()
                val scope = database.resolveResourceScope(principal.userId, ScopeKind.EXPORT, exportId)
                val context = authorize(database, call, FeedbackPermission.MANAGE, scope, hideExistence = true)
                val export = database.getStoredExport(exportId, dependencies.exportStorage)
                auditMutation(database, call, context, "export.read", "export", exportId)
                call.response.header(
                    HttpHeaders.ContentDisposition,
                    ContentDisposition.Attachment
                        .withParameter(ContentDisposition.Parameters.FileName, export.fileName)
                        .toString()
                )
                call.respondBytes(export.bytes, ContentType.parse(export.contentType))
            }

            route("/retention-policy") {
                get { respondRetentionPolicy(database, call, patch = false) }
                patch { respondRetentionPolicy(database, call, patch = true) }
            }

            route("/notification-settings") {
                get { respondNotificationSettings(database, dependencies.notificationCipher, call, patch = false) }
                patch { respondNotificationSettings(database, dependencies.notificationCipher, call, patch = true) }
            }

            route("/memberships") {
                get {
                    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                    call.respond(database.listWorkspaceMembers(context.scope))
                }
                post {
                    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                    val requestElement = call.receive<JsonElement>()
                    val request = decode(requestElement, FeedbackMembershipCreateRequest.serializer())
                    val member = database.createWorkspaceMember(
                        context.scope,
                        context.principal,
                        request,
                        validateIdempotencyKey(call.request.headers["Idempotency-Key"]),
                        requestHash(requestElement)
                    )
                    auditMutation(database, call, context, "membership.create", "membership", member.userId)
                    call.response.header(HttpHeaders.ETag, etag(member.version))
                    call.respond(HttpStatusCode.Created, member)
                }
            }

            route("/memberships/{userId}") {
                patch {
                    val userId = validateUuid(call.parameters["userId"], "userId")
                    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                    val member = database.patchWorkspaceMember(
                        context.scope,
                        userId,
                        parseEtag(call.request.headers[HttpHeaders.IfMatch]),
                        call.receive()
                    )
                    auditMutation(database, call, context, "membership.patch", "membership", member.userId)
                    call.response.header(HttpHeaders.ETag, etag(member.version))
                    call.respond(member)
                }
                delete {
                    val userId = validateUuid(call.parameters["userId"], "userId")
                    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                    database.deleteWorkspaceMember(
                        context.scope,
                        userId,
                        parseEtag(call.request.headers[HttpHeaders.IfMatch])
                    )
                    auditMutation(database, call, context, "membership.delete", "membership", userId)
                    call.respond(HttpStatusCode.NoContent)
                }
            }

            get("/notification-deliveries") {
                val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                call.respond(
                    database.listNotificationDeliveries(
                        context.scope,
                        call.request.queryParameters["status"],
                        parseLimit(call.request.queryParameters["limit"])
                    )
                )
            }

            post("/notification-deliveries/{deliveryId}/retry") {
                val deliveryId = validateUuid(call.parameters["deliveryId"], "deliveryId")
                val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
                val delivery = database.retryNotificationDelivery(context.scope, deliveryId)
                auditMutation(database, call, context, "notification.retry", "notification-delivery", deliveryId)
                call.respond(delivery)
            }
        }
    }
}

private fun enforceWriteRateLimit(
    database: FeedbackDatabase,
    dependencies: FeedbackDependencies,
    call: ApplicationCall,
    scope: ResourceScope,
    principal: FeedbackPrincipal
) {
    database.enforceWriteRateLimit(
        scope = scope,
        principal = principal,
        remoteAddress = call.request.origin.remoteHost,
        principalLimitPerMinute = dependencies.writeRateLimitPerMinute,
        tenantLimitPerMinute = dependencies.writeRateLimitPerTenantPerMinute,
        ipLimitPerMinute = dependencies.writeRateLimitPerIpPerMinute,
        requestId = call.callId ?: "unknown"
    )
}

private suspend fun respondRetentionPolicy(database: FeedbackDatabase, call: ApplicationCall, patch: Boolean) {
    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.MANAGE)
    val (policy, version) = if (patch) {
        database.patchRetentionPolicy(context.scope, parseEtag(call.request.headers[HttpHeaders.IfMatch]), call.receive())
    } else {
        database.getRetentionPolicy(context.scope)
    }
    call.response.header(HttpHeaders.ETag, etag(version))
    if (patch) auditMutation(database, call, context, "retention.patch", "retention-policy", requireNotNull(context.scope.workspaceId))
    call.respond(policy)
}

private suspend fun respondNotificationSettings(
    database: FeedbackDatabase,
    cipher: NotificationCipher,
    call: ApplicationCall,
    patch: Boolean
) {
    val context = workspaceQueryAuthorization(database, call, FeedbackPermission.ADMIN)
    val (settings, version) = if (patch) {
        database.patchNotificationSettings(
            context.scope,
            parseEtag(call.request.headers[HttpHeaders.IfMatch]),
            call.receive(),
            cipher
        )
    } else {
        database.getNotificationSettings(context.scope, cipher)
    }
    call.response.header(HttpHeaders.ETag, etag(version))
    if (patch) auditMutation(
        database,
        call,
        context,
        "notification-settings.patch",
        "notification-settings",
        requireNotNull(context.scope.workspaceId)
    )
    call.respond(settings)
}

private fun workspaceQueryAuthorization(
    database: FeedbackDatabase,
    call: ApplicationCall,
    permission: FeedbackPermission
): AuthorizedContext {
    val principal = call.feedbackPrincipal()
    val query = call.request.queryParameters
    val scope = database.resolveWorkspaceScope(
        principal.userId,
        validateApplicationKey(query.required("applicationKey")),
        validateKey(query.required("externalWorkspaceKey"), "externalWorkspaceKey", 200)
    )
    return authorize(database, call, permission, scope)
}

private fun io.ktor.http.Parameters.required(name: String): String =
    this[name] ?: badRequest("query parameter $name が必要です")

private fun parseLimit(raw: String?): Int = raw?.toIntOrNull()?.takeIf { it in 1..200 } ?: if (raw == null) 50 else
    badRequest("limit は 1 以上 200 以下で指定してください")

private fun validateSessionStatus(value: String) {
    if (value !in setOf("draft", "open", "closed")) badRequest("session status が不正です")
}

private fun validateThreadStatus(value: String) {
    if (value !in setOf("open", "resolved")) badRequest("thread status が不正です")
}

private fun parseJsonObject(raw: String, name: String): JsonObject = try {
    serviceJson.parseToJsonElement(raw).jsonObject
} catch (_: IllegalArgumentException) {
    badRequest("$name は JSON object として指定してください")
}

private fun <T> decode(element: JsonElement, serializer: KSerializer<T>): T = try {
    serviceJson.decodeFromJsonElement(serializer, element)
} catch (exception: kotlinx.serialization.SerializationException) {
    badRequest(exception.message ?: "request body が不正です")
}
