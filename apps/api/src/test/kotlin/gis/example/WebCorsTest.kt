package gis.example

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class WebCorsTest {
    @Test
    fun `WEB_ORIGINの単一値を許可する`() = testApplication {
        application {
            installWebCors(parseAllowedWebOrigins(null, "https://app.example.test"))
            routing { get("/probe") { call.respondText("ok") } }
        }

        val response = client.get("/probe") {
            header(HttpHeaders.Origin, "https://app.example.test")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("https://app.example.test", response.headers[HttpHeaders.AccessControlAllowOrigin])
    }

    @Test
    fun `WEB_ORIGINSの複数値をschemeとportを含めて許可する`() = testApplication {
        application {
            installWebCors(
                parseAllowedWebOrigins(
                    "https://one.example.test,http://localhost:4173",
                    "https://legacy.example.test"
                )
            )
            routing { get("/probe") { call.respondText("ok") } }
        }

        val first = client.get("/probe") { header(HttpHeaders.Origin, "https://one.example.test") }
        val second = client.get("/probe") { header(HttpHeaders.Origin, "http://localhost:4173") }

        assertEquals("https://one.example.test", first.headers[HttpHeaders.AccessControlAllowOrigin])
        assertEquals("http://localhost:4173", second.headers[HttpHeaders.AccessControlAllowOrigin])
    }

    @Test
    fun `未許可OriginへCORSヘッダを返さない`() = testApplication {
        application {
            installWebCors(parseAllowedWebOrigins("https://allowed.example.test", null))
            routing { get("/probe") { call.respondText("ok") } }
        }

        val response = client.get("/probe") {
            header(HttpHeaders.Origin, "https://evil.example.test")
        }

        assertNull(response.headers[HttpHeaders.AccessControlAllowOrigin])
    }

    @Test
    fun `不正URLとoriginではないURLを起動前に拒否する`() {
        listOf(
            "not-a-url",
            "ftp://files.example.test",
            "https://app.example.test/path",
            "https://user@app.example.test",
            "https://app.example.test,"
        ).forEach { value ->
            assertFailsWith<IllegalStateException>(message = value) {
                parseAllowedWebOrigins(value, null)
            }
        }
    }
}
