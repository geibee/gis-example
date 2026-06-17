package gis.example

import io.ktor.http.HttpStatusCode

class ApiException(
    val status: HttpStatusCode,
    override val message: String
) : RuntimeException(message)
