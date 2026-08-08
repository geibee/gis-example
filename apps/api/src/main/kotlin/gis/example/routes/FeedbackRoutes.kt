// フィードバックスレッド (投稿・返信・状態管理・証跡) のルート (openapi.yaml tag: review)。
// 設計は docs/prototype-review.md Phase 2〜4。
//
// 投稿は multipart/form-data で「メタデータ JSON + スクリーンショット PNG」を同時に送る。
// 証跡は公開ストレージに置かず、取得も必ずこの API の認可を通す。
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.FeedbackThreadInput
import gis.example.FeedbackThreadListQuery
import gis.example.FeedbackThreadSearchQuery
import gis.example.ProjectResourceType
import gis.example.ReviewEvidenceInput
import gis.example.RouteAuthz.ProjectFromQuery
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.appPrincipal
import gis.example.auditSuccessfulRead
import gis.example.auditTrail
import gis.example.authorizedResourceId
import gis.example.authorizedProjectId
import gis.example.authorizedRoutes
import gis.example.createFeedbackThread
import gis.example.createFeedbackMessage
import gis.example.databaseJson
import gis.example.feedbackTargetTypes
import gis.example.getEvidenceReference
import gis.example.getFeedbackThread
import gis.example.getFeedbackMessageHistory
import gis.example.listFeedbackThreads
import gis.example.searchFeedbackThreads
import gis.example.readOptionalDouble
import gis.example.readOptionalInt
import gis.example.readOptionalText
import gis.example.readOptionalTimestamp
import gis.example.readRequiredText
import gis.example.requirePostableSession
import gis.example.summarizeFeedbackThreads
import gis.example.updateFeedbackThreadStatus
import gis.example.updateFeedbackMessage
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.request.receive
import io.ktor.server.request.receiveMultipart
import io.ktor.server.routing.Route
import io.ktor.utils.io.core.readAvailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.time.OffsetDateTime
import java.util.UUID

/** 証跡 1 枚の上限。1440x900 の PNG は実測 70KB 前後なので、既定 10MB は十分に余裕がある */
private const val DEFAULT_EVIDENCE_MAX_BYTES = 10L * 1024 * 1024

fun Route.feedbackRoutes(deps: AppDependencies) {
    val db = deps.db
    val evidenceMaxBytes =
        (System.getenv("REVIEW_EVIDENCE_MAX_BYTES") ?: DEFAULT_EVIDENCE_MAX_BYTES.toString()).toLong()

    authorizedRoutes(db) {
        // レビュー対象者 (viewer) が投稿できることが本機能の前提なので REVIEW_COMMENT。
        // 対象セッションはパスにあるため、multipart を読む前に認可を判定できる
        post(
            "/api/review-sessions/{id}/threads",
            ResourceFromPath(Action.REVIEW_COMMENT, ProjectResourceType.REVIEW_SESSION, uuidLabel = "id")
        ) {
            val reviewSessionId = call.authorizedResourceId()
            val form = call.receiveFeedbackForm(evidenceMaxBytes)

            val metadata = form.metadata
                ?: throw ApiException(HttpStatusCode.BadRequest, "metadata part is required")
            val perspectiveCode = readRequiredText(metadata, "perspectiveCode")
            val body = readRequiredText(metadata, "body")
            val targetType = readRequiredText(metadata, "targetType")
            if (targetType !in feedbackTargetTypes) {
                throw ApiException(
                    HttpStatusCode.BadRequest,
                    "targetType must be one of ${feedbackTargetTypes.sorted()}"
                )
            }
            val targetMetadata = metadata["target"]?.let { element ->
                runCatching { element.jsonObject }.getOrElse {
                    throw ApiException(HttpStatusCode.BadRequest, "target must be an object")
                }
            } ?: throw ApiException(HttpStatusCode.BadRequest, "target is required")

            // 「今回選べない観点では投稿できない」ことは UI の親切ではなく基盤の約束なので
            // サーバ側でも強制する (受付期間・セッション状態も同時に検査する)
            db.requirePostableSession(reviewSessionId, perspectiveCode)

            val evidence = form.screenshot?.let { screenshot ->
                val reference = withContext(Dispatchers.IO) {
                    val staging = Files.createTempFile(deps.uploadDir.also { Files.createDirectories(it) }, "evidence-", ".png")
                    Files.write(staging, screenshot)
                    deps.uploadStorage.store(staging, "review-evidence/${UUID.randomUUID()}.png")
                }
                ReviewEvidenceInput(
                    screenshotPath = reference,
                    contentType = ContentType.Image.PNG.toString(),
                    byteSize = screenshot.size.toLong(),
                    viewportWidth = requirePositiveInt(metadata, "viewportWidth"),
                    viewportHeight = requirePositiveInt(metadata, "viewportHeight"),
                    scrollX = readOptionalInt(metadata, "scrollX") ?: 0,
                    scrollY = readOptionalInt(metadata, "scrollY") ?: 0,
                    pixelRatio = readOptionalDouble(metadata, "pixelRatio") ?: 1.0,
                    frontendVersion = readOptionalText(metadata, "frontendVersion") ?: "unknown",
                    route = readRequiredText(metadata, "route"),
                    // 端末時計のずれで未来日時が入り得るが、証跡は「クライアントが記録した時刻」を
                    // そのまま残す (サーバ時刻は audit_logs.occurred_at 側が持つ)
                    capturedAt = readOptionalTimestamp(metadata, "capturedAt") ?: OffsetDateTime.now().toString()
                )
            }

            val thread = try {
                db.createFeedbackThread(
                    FeedbackThreadInput(
                        reviewSessionId = reviewSessionId,
                        perspectiveCode = perspectiveCode,
                        targetType = targetType,
                        targetMetadata = targetMetadata,
                        pageId = readOptionalText(metadata, "pageId"),
                        pageRoute = readOptionalText(metadata, "route"),
                        body = body,
                        evidence = evidence
                    ),
                    createdBy = call.appPrincipal().userId,
                    audit = call.auditTrail()
                )
            } catch (exc: Exception) {
                // スレッド登録に失敗した孤児の証跡を保存先に残さない
                evidence?.let { withContext(Dispatchers.IO) { deps.uploadStorage.delete(it.screenshotPath) } }
                throw exc
            }
            call.respond(HttpStatusCode.Created, thread)
        }

        get(
            "/api/review-sessions/{id}/threads",
            ResourceFromPath(Action.REVIEW_READ, ProjectResourceType.REVIEW_SESSION, uuidLabel = "id")
        ) {
            val params = call.request.queryParameters
            val result = db.listFeedbackThreads(
                FeedbackThreadListQuery(
                    reviewSessionId = call.authorizedResourceId(),
                    status = params["status"],
                    limit = parseListLimit(params["limit"]),
                    offset = parseListOffset(params["offset"])
                )
            )
            call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
            call.respond(result.items)
        }

        // 管理画面はセッションをまたいで状態・観点・証跡有無・本文を検索する
        get("/api/threads", ProjectFromQuery(Action.REVIEW_READ)) {
            val params = call.request.queryParameters
            val result = db.searchFeedbackThreads(
                FeedbackThreadSearchQuery(
                    projectId = call.authorizedProjectId(),
                    reviewSessionId = optionalUuid(params["reviewSessionId"], "reviewSessionId"),
                    status = params["status"],
                    perspectiveCode = params["perspectiveCode"],
                    hasEvidence = parseOptionalBoolean(params["hasEvidence"], "hasEvidence"),
                    query = params["q"],
                    limit = parseListLimit(params["limit"]),
                    offset = parseListOffset(params["offset"])
                )
            )
            call.response.header(TOTAL_COUNT_HEADER, result.totalCount.toString())
            call.respond(result.items)
        }

        // 一覧とは分離し、ページングに左右されないプロジェクト全体の集計を返す
        get("/api/threads/summary", ProjectFromQuery(Action.REVIEW_READ)) {
            call.respond(db.summarizeFeedbackThreads(call.authorizedProjectId()))
        }

        get(
            "/api/threads/{threadId}",
            ResourceFromPath(
                Action.REVIEW_READ,
                ProjectResourceType.FEEDBACK_THREAD,
                param = "threadId",
                uuidLabel = "threadId"
            )
        ) {
            val id = call.authorizedResourceId()
            call.respond(
                db.getFeedbackThread(id) ?: throw ApiException(HttpStatusCode.NotFound, "Feedback thread not found")
            )
        }

        // viewer も会話へ参加できる。解決済みスレッドへの返信はクエリ層が fail-closed で拒否する
        post(
            "/api/threads/{threadId}/messages",
            ResourceFromPath(
                Action.REVIEW_COMMENT,
                ProjectResourceType.FEEDBACK_THREAD,
                param = "threadId",
                uuidLabel = "threadId"
            )
        ) {
            val request = call.receive<JsonObject>()
            call.respond(
                HttpStatusCode.Created,
                db.createFeedbackMessage(
                    threadId = call.authorizedResourceId(),
                    body = readRequiredText(request, "body"),
                    authorId = call.appPrincipal().userId,
                    audit = call.auditTrail()
                )
            )
        }

        patch(
            "/api/messages/{messageId}",
            ResourceFromPath(
                Action.REVIEW_COMMENT,
                ProjectResourceType.FEEDBACK_MESSAGE,
                param = "messageId",
                uuidLabel = "messageId"
            )
        ) {
            val request = call.receive<JsonObject>()
            call.respond(
                db.updateFeedbackMessage(
                    id = call.authorizedResourceId(),
                    body = readRequiredText(request, "body"),
                    editorId = call.appPrincipal().userId,
                    audit = call.auditTrail()
                )
            )
        }

        get(
            "/api/messages/{messageId}/history",
            ResourceFromPath(
                Action.REVIEW_READ,
                ProjectResourceType.FEEDBACK_MESSAGE,
                param = "messageId",
                uuidLabel = "messageId"
            )
        ) {
            call.respond(db.getFeedbackMessageHistory(call.authorizedResourceId()))
        }

        // Resolve / Reopen はレビュー管理者相当 (現行ロールでは editor) のみ
        patch(
            "/api/threads/{threadId}/status",
            ResourceFromPath(
                Action.REVIEW_MANAGE,
                ProjectResourceType.FEEDBACK_THREAD,
                param = "threadId",
                uuidLabel = "threadId"
            )
        ) {
            val request = call.receive<JsonObject>()
            call.respond(
                db.updateFeedbackThreadStatus(
                    id = call.authorizedResourceId(),
                    status = readRequiredText(request, "status"),
                    audit = call.auditTrail(),
                    actorId = call.appPrincipal().userId
                )
            )
        }

        // 証跡画像は公開せず、必ずこの経路 (プロジェクトのメンバーであることの検査つき) で配る
        get(
            "/api/threads/{threadId}/evidence",
            ResourceFromPath(
                Action.REVIEW_READ,
                ProjectResourceType.FEEDBACK_THREAD,
                param = "threadId",
                uuidLabel = "threadId"
            )
        ) {
            val id = call.authorizedResourceId()
            val (reference, contentType) = db.getEvidenceReference(id)
                ?: throw ApiException(HttpStatusCode.NotFound, "Evidence not found")
            val bytes = withContext(Dispatchers.IO) {
                runCatching { deps.uploadStorage.open(reference).use { it.readBytes() } }
                    .getOrElse { throw ApiException(HttpStatusCode.NotFound, "Evidence not found") }
            }
            // 証跡には個人情報・業務情報が写り得るため共有キャッシュに残さない
            call.response.header(HttpHeaders.CacheControl, "private, no-store")
            call.auditSuccessfulRead()
            call.respondBytes(bytes, ContentType.parse(contentType), HttpStatusCode.OK)
        }
    }
}

// ---------------------------------------------------------------- multipart 読み取り

private class FeedbackForm(val metadata: JsonObject?, val screenshot: ByteArray?)

private suspend fun ApplicationCall.receiveFeedbackForm(maxBytes: Long): FeedbackForm {
    var metadata: JsonObject? = null
    var screenshot: ByteArray? = null
    receiveMultipart().forEachPart { part ->
        when (part) {
            is PartData.FormItem -> if (part.name == "metadata") {
                metadata = runCatching { databaseJson.parseToJsonElement(part.value).jsonObject }
                    .getOrElse { throw ApiException(HttpStatusCode.BadRequest, "metadata must be a JSON object") }
            }
            is PartData.FileItem -> if (part.name == "screenshot") {
                screenshot = readPartWithLimit(part, maxBytes)
            }
            else -> Unit
        }
        part.dispose()
    }
    return FeedbackForm(metadata, screenshot)
}

private fun readPartWithLimit(part: PartData.FileItem, maxBytes: Long): ByteArray {
    val input = part.provider()
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val read = input.readAvailable(buffer, 0, buffer.size)
        if (read <= 0) break
        total += read
        if (total > maxBytes) {
            throw ApiException(HttpStatusCode.PayloadTooLarge, "Evidence exceeds limit of $maxBytes bytes")
        }
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}

private fun requirePositiveInt(metadata: JsonObject, key: String): Int {
    val value = readOptionalInt(metadata, key)
        ?: throw ApiException(HttpStatusCode.BadRequest, "$key is required when a screenshot is attached")
    if (value <= 0) throw ApiException(HttpStatusCode.BadRequest, "$key must be positive")
    return value
}
