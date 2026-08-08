package feedback.service

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respondText
import kotlinx.serialization.json.Json

private val problemContentType = ContentType.parse("application/problem+json")
private val problemJson = Json {
    encodeDefaults = true
    explicitNulls = false
}

suspend fun ApplicationCall.respondProblem(status: HttpStatusCode, problem: FeedbackProblem) {
    respondText(
        text = problemJson.encodeToString(FeedbackProblem.serializer(), problem),
        contentType = problemContentType,
        status = status
    )
}
