// アプリケーションの組み立て: プラグイン設定・依存 (AppDependencies) の構築・ルートモジュールの登録のみを行う。
// 各エンドポイントの定義は routes/ 配下の機能別ファイルを見ること
package gis.example

import gis.example.routes.AppDependencies
import gis.example.routes.TOTAL_COUNT_HEADER
import gis.example.routes.adminRoutes
import gis.example.routes.buildingRoutes
import gis.example.routes.featureRoutes
import gis.example.routes.healthRoutes
import gis.example.routes.jobRoutes
import gis.example.routes.landRoutes
import gis.example.routes.layerRoutes
import gis.example.routes.meRoutes
import gis.example.routes.partyRoutes
import gis.example.routes.projectRoutes
import gis.example.routes.tileRoutes
import gis.example.routes.zoneRoutes
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.install
import io.ktor.server.auth.authenticate
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.httpMethod
import io.ktor.server.request.uri
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.nio.file.Path

private val applicationLogger = LoggerFactory.getLogger("gis.example.Application")

private const val DEFAULT_MAX_UPLOAD_BYTES = 200L * 1024 * 1024

fun main() {
    // LOG_FORMAT の不正値は「appender が解決できず無ログで走り続ける」事故になるため先に検証する
    validateLogFormatEnv()
    val port = (System.getenv("PORT") ?: "8080").toInt()
    embeddedServer(Netty, host = "0.0.0.0", port = port) {
        module()
    }.start(wait = true)
}

// db / oidcSettings は統合テストからの差し替え用 (テストはローカル RSA 鍵の verifier を注入する)。
// 渡された Database の所有権は module が持ち、ApplicationStopped で close する
fun Application.module(
    db: Database = Database.fromEnv(),
    oidcSettings: OidcSettings = OidcSettings.fromEnv()
) {
    db.migrateSchema()
    val uploadDir = Path.of(System.getenv("UPLOAD_DIR") ?: "/tmp/web-gis-uploads")
    val deps = AppDependencies(
        db = db,
        uploadDir = uploadDir,
        // 本番 (ECS Fargate) は UPLOAD_STORAGE=s3。local 既定は dev / 単一ホスト専用
        uploadStorage = uploadStorageFromEnv(System::getenv, uploadDir),
        // ブラウザから見た API の公開 URL (TileJSON の絶対 URL 生成に使う)。
        // localhost 既定は dev 専用。本番では CloudFront 配下の HTTPS URL を必ず設定する
        apiPublicUrl = (System.getenv("API_PUBLIC_URL") ?: "http://localhost:8080").trimEnd('/'),
        maxUploadBytes = (System.getenv("UPLOAD_MAX_BYTES") ?: DEFAULT_MAX_UPLOAD_BYTES.toString()).toLong()
    )
    val webOrigin = System.getenv("WEB_ORIGIN")

    val analysisJobRunner = AnalysisJobRunner(
        db = db,
        pollIntervalMillis = ((System.getenv("ANALYSIS_POLL_INTERVAL_SECONDS") ?: "2").toDouble() * 1000).toLong(),
        staleJobMaxAgeSeconds = (System.getenv("ANALYSIS_JOB_STALE_SECONDS") ?: "1800").toLong()
    )
    analysisJobRunner.start()

    environment.monitor.subscribe(ApplicationStopped) {
        analysisJobRunner.stop()
        deps.uploadStorage.close()
        db.close()
    }

    // CloudFront/ALB 背後で scheme/client IP を X-Forwarded-* から復元する。
    // 既定 0 (無効) = dev の直接公開向け。信頼境界の詳細は ForwardedHeaders.kt と docs/reverse-proxy.md
    installForwardedHeadersSupport((System.getenv("TRUSTED_PROXY_COUNT") ?: "0").toInt())
    // callId (requestId) の採番・MDC 伝播と構造化アクセスログ (Observability.kt)
    installObservability()
    install(ContentNegotiation) {
        json(
            Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
                prettyPrint = true
            }
        )
    }
    install(CORS) {
        // WEB_ORIGIN 未設定時に anyHost に開放しない (fail-open 防止)。
        // localhost 既定は dev 専用。本番では web の公開オリジン (https://...) を必ず設定する
        val origin = webOrigin?.takeIf { it.isNotBlank() } ?: "http://localhost:5173"
        allowHost(origin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Patch)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Delete)
        allowMethod(HttpMethod.Options)
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        // 一覧 API の総件数ヘッダをブラウザの JS から読めるようにする
        exposeHeader(TOTAL_COUNT_HEADER)
    }
    installOidcAuthentication(db, oidcSettings)
    install(auditLogPlugin(db))
    install(StatusPages) {
        exception<ApiException> { call, cause ->
            call.respond(cause.status, ErrorResponse(cause.message))
        }
        exception<Throwable> { call, cause ->
            // 内部例外の詳細はログのみに残し、クライアントへは漏らさない
            applicationLogger.error("Unhandled error on {} {}", call.request.httpMethod.value, call.request.uri, cause)
            call.respond(HttpStatusCode.InternalServerError, ErrorResponse("Internal server error"))
        }
    }

    val rootRoute = routing {
        healthRoutes(
            db = db,
            readinessTimeoutMillis = (System.getenv("HEALTH_READINESS_TIMEOUT_MS") ?: "2000").toLong()
        )

        // /health 以外の全ルートは認証必須 (fail-closed)。
        // 認可は各ルートの RouteAuthz 宣言 (authorizedRoutes DSL) で強制される
        authenticate(OIDC_AUTH_NAME) {
            // 実行時の安全網: 認可判定マーカーのない 2xx 応答を 500 に置き換える
            install(authzGuardPlugin(db))
            projectRoutes(deps)
            meRoutes(deps)
            adminRoutes(deps)
            layerRoutes(deps)
            featureRoutes(deps)
            landRoutes(deps)
            buildingRoutes(deps)
            partyRoutes(deps)
            zoneRoutes(deps)
            jobRoutes(deps)
            tileRoutes(deps)
        }
    }
    // 起動時の安全網: 認可宣言のないルートが 1 つでもあれば起動に失敗する
    validateAuthorizedRoutes(rootRoute)
}
