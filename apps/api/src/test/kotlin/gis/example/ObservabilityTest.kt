// 観測性 (Observability.kt / SystemRoutes.kt) の単体テスト (DB 不要):
// - callId: X-Request-Id / X-Amzn-Trace-Id の受入、不正値のフォールバック生成、
//   レスポンスヘッダへの反映、MDC (callId) への伝播
// - アクセスログ: 完了ログ 1 行に httpMethod/path/status/durationMs/clientIp/callId の
//   MDC が乗ること、/health 系が除外されること
// - ヘルス分離: DB へ到達できなくても /health (liveness) は 200、/health/ready (readiness) は 503
package gis.example

import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import gis.example.routes.healthRoutes
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ObservabilityTest {

    private val uuidRegex = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    // installObservability + MDC の callId を返す最小アプリ
    private fun withObservedApp(block: suspend (io.ktor.client.HttpClient) -> Unit) = testApplication {
        application {
            installObservability()
            routing {
                get("/echo-call-id") {
                    call.respondText(MDC.get(CALL_ID_MDC_KEY) ?: "missing")
                }
            }
        }
        block(client)
    }

    @Test
    fun `ヘッダなしなら UUID の callId が生成されレスポンスヘッダで返る`() = withObservedApp { client ->
        val response = client.get("/echo-call-id")
        val callId = response.headers[HttpHeaders.XRequestId]
        assertNotNull(callId, "X-Request-ID がレスポンスに付与されるはず")
        assertTrue(uuidRegex.matches(callId), "生成 callId は UUID のはず: $callId")
    }

    @Test
    fun `X-Request-Id を送るとそのまま採用される`() = withObservedApp { client ->
        val response = client.get("/echo-call-id") {
            header(HttpHeaders.XRequestId, "client-supplied-id-123")
        }
        assertEquals("client-supplied-id-123", response.headers[HttpHeaders.XRequestId])
    }

    @Test
    fun `X-Request-Id が無ければ ALB の X-Amzn-Trace-Id を採用する`() = withObservedApp { client ->
        val traceId = "Root=1-67891233-abcdef012345678912345678"
        val response = client.get("/echo-call-id") {
            header("X-Amzn-Trace-Id", traceId)
        }
        assertEquals(traceId, response.headers[HttpHeaders.XRequestId])
    }

    @Test
    fun `不正な X-Request-Id は反射せず生成 UUID にフォールバックする`() = withObservedApp { client ->
        // 空白 (ログ注入・整形崩し) と 200 文字超 (巨大ヘッダ反射) は拒否する
        val response = client.get("/echo-call-id") {
            header(HttpHeaders.XRequestId, "abc def")
        }
        val callId = response.headers[HttpHeaders.XRequestId]
        assertNotNull(callId)
        assertNotEquals("abc def", callId)
        assertTrue(uuidRegex.matches(callId))

        val tooLong = client.get("/echo-call-id") {
            header(HttpHeaders.XRequestId, "a".repeat(201))
        }
        assertTrue(uuidRegex.matches(tooLong.headers[HttpHeaders.XRequestId] ?: ""))
    }

    @Test
    fun `ハンドラ実行中の MDC に callId が乗る`() = withObservedApp { client ->
        val response = client.get("/echo-call-id") {
            header(HttpHeaders.XRequestId, "mdc-check-42")
        }
        assertEquals("mdc-check-42", response.bodyAsText(), "アプリログの MDC に callId が伝播するはず")
    }

    @Test
    fun `アクセスログに構造化フィールドの MDC が乗り health は除外される`() {
        val accessLogger = LoggerFactory.getLogger(ACCESS_LOG_LOGGER_NAME) as Logger
        val appender = ListAppender<ILoggingEvent>().apply { start() }
        accessLogger.addAppender(appender)
        try {
            testApplication {
                application {
                    installObservability()
                    routing {
                        get("/observed") { call.respondText("ok") }
                        get("/health") { call.respondText("ok") }
                    }
                }
                client.get("/observed") { header(HttpHeaders.XRequestId, "access-log-check") }
                client.get("/health")
            }
        } finally {
            accessLogger.detachAppender(appender)
        }

        val events = appender.list.filter { it.mdcPropertyMap["path"] != null }
        assertEquals(1, events.size, "/observed の完了ログ 1 行のみのはず (health は除外): $events")
        val mdc = events.single().mdcPropertyMap
        assertEquals("access-log-check", mdc["callId"])
        assertEquals("GET", mdc["httpMethod"])
        assertEquals("/observed", mdc["path"])
        assertEquals("200", mdc["status"])
        assertNotNull(mdc["durationMs"], "所要時間が MDC に乗るはず")
        assertNotNull(mdc["clientIp"], "クライアント IP が MDC に乗るはず")
    }

    // 到達不能な DB (閉じたポート) を指す Database。接続は即時に失敗する
    private fun unreachableDatabase(): Database {
        val config = HikariConfig().apply {
            jdbcUrl = "jdbc:postgresql://127.0.0.1:1/gis"
            username = "gis"
            password = "gis"
            maximumPoolSize = 1
            connectionTimeout = 250
            validationTimeout = 250
            // 起動時 (プール生成時) の接続確認を行わない: readiness が実行時に検知する
            initializationFailTimeout = -1
        }
        return Database(HikariDataSource(config))
    }

    @Test
    fun `DB 断でも liveness は 200 のまま readiness は 503 になる`() {
        unreachableDatabase().use { db ->
            testApplication {
                application {
                    // module() と同様に respond(mapOf(...)) の JSON 化に ContentNegotiation が要る
                    install(ContentNegotiation) { json() }
                    routing { healthRoutes(db, readinessTimeoutMillis = 3000) }
                }
                assertEquals(HttpStatusCode.OK, client.get("/health").status, "liveness は依存に触れないはず")
                assertEquals(HttpStatusCode.ServiceUnavailable, client.get("/health/ready").status)
            }
        }
    }

    @Test
    fun `LOG_FORMAT は text と json 以外を拒否する`() {
        validateLogFormatEnv { null }
        validateLogFormatEnv { "text" }
        validateLogFormatEnv { "json" }
        assertFailsWith<IllegalArgumentException> { validateLogFormatEnv { "yaml" } }
    }
}
