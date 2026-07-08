// XForwardedHeaders (ForwardedHeaders.kt) の信頼境界の検証:
// - TRUSTED_PROXY_COUNT=0 (既定・直接公開): クライアントが詐称した X-Forwarded-* を一切信頼しない
// - 1 (ALB のみ): 最後段のプロキシが記録した接続元とスキームを採用する
// - 2 (CloudFront + ALB): 末尾 1 つを読み飛ばし、末尾から 2 番目をクライアントとして採用する
package gis.example

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.server.application.call
import io.ktor.server.plugins.origin
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ForwardedHeadersTest {

    // scheme と remoteHost を "scheme remoteHost" 形式で返す最小アプリ
    private fun withEchoApp(trustedProxyCount: Int, block: suspend (io.ktor.client.HttpClient) -> Unit) =
        testApplication {
            application {
                installForwardedHeadersSupport(trustedProxyCount)
                routing {
                    get("/echo-origin") {
                        val origin = call.request.origin
                        call.respondText("${origin.scheme} ${origin.remoteHost}")
                    }
                }
            }
            block(client)
        }

    @Test
    fun `無効 (0) ならクライアントが付けた X-Forwarded ヘッダを信頼しない`() = withEchoApp(0) { client ->
        val body = client.get("/echo-origin") {
            header("X-Forwarded-Proto", "https")
            header("X-Forwarded-For", "203.0.113.7")
        }.bodyAsText()
        val (scheme, remoteHost) = body.split(" ")
        assertEquals("http", scheme, "直接公開時に詐称された X-Forwarded-Proto を反映してはならない")
        assertNotEquals("203.0.113.7", remoteHost, "直接公開時に詐称された X-Forwarded-For を反映してはならない")
    }

    @Test
    fun `プロキシ 1 段なら最後段が付けた scheme と接続元を採用する`() = withEchoApp(1) { client ->
        val body = client.get("/echo-origin") {
            header("X-Forwarded-Proto", "https")
            // 先頭はクライアントが詐称した可能性のある値。1 段構成では末尾だけを信頼する
            header("X-Forwarded-For", "198.51.100.99, 203.0.113.7")
        }.bodyAsText()
        assertEquals("https 203.0.113.7", body)
    }

    @Test
    fun `プロキシ 2 段 (CloudFront+ALB) なら末尾から 2 番目をクライアントとして採用する`() = withEchoApp(2) { client ->
        val body = client.get("/echo-origin") {
            // 末尾 (203.0.113.7) は ALB が記録した CloudFront のアドレス、
            // その手前 (198.51.100.10) が CloudFront の記録した実クライアント
            header("X-Forwarded-Proto", "https")
            header("X-Forwarded-For", "198.51.100.10, 203.0.113.7")
        }.bodyAsText()
        assertEquals("https 198.51.100.10", body)
    }

    @Test
    fun `ヘッダなしのリクエストは有効時もそのまま通る`() = withEchoApp(1) { client ->
        val (scheme, _) = client.get("/echo-origin").bodyAsText().split(" ")
        assertEquals("http", scheme)
    }
}
