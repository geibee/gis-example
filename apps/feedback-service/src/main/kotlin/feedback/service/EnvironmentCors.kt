package feedback.service

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.request.httpMethod

fun Application.installEnvironmentCors(database: FeedbackDatabase) {
    intercept(ApplicationCallPipeline.Plugins) {
        val origin = call.request.headers[HttpHeaders.Origin] ?: return@intercept
        if (!database.isAllowedOrigin(origin)) {
            throw FeedbackApiException(HttpStatusCode.Forbidden, "cors.origin_denied", "登録されていない origin です")
        }
        call.response.header(HttpHeaders.AccessControlAllowOrigin, origin)
        call.response.header(HttpHeaders.Vary, HttpHeaders.Origin)
        call.response.header(HttpHeaders.AccessControlExposeHeaders, "ETag, X-Request-ID")
        if (call.request.httpMethod == HttpMethod.Options) {
            call.response.header(HttpHeaders.AccessControlAllowMethods, "GET, POST, PUT, PATCH, OPTIONS")
            call.response.header(
                HttpHeaders.AccessControlAllowHeaders,
                "Authorization, Content-Type, If-Match, Idempotency-Key, X-Request-ID"
            )
            call.response.header(HttpHeaders.AccessControlMaxAge, "600")
            call.respond(HttpStatusCode.NoContent)
            finish()
        }
    }
}

fun FeedbackDatabase.isAllowedOrigin(origin: String): Boolean = dataSource.connection.use { connection ->
    connection.prepareStatement(
        "SELECT 1 FROM feedback.application_environments WHERE ? = ANY(allowed_origins) LIMIT 1"
    ).use { statement ->
        statement.setString(1, origin)
        statement.executeQuery().use { it.next() }
    }
}
