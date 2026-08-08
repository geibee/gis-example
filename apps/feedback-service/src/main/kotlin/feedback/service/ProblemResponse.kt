package feedback.service

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respondText

private val problemContentType = ContentType.parse("application/problem+json")

suspend fun ApplicationCall.respondProblem(status: HttpStatusCode, problem: FeedbackProblem) {
    respondText(
        text = serviceJson.encodeToString(FeedbackProblem.serializer(), problem),
        contentType = problemContentType,
        status = status
    )
}
