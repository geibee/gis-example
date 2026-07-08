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
import io.ktor.server.plugins.callloging.CallLogging
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
    val deps = AppDependencies(
        db = db,
        uploadDir = Path.of(System.getenv("UPLOAD_DIR") ?: "/tmp/web-gis-uploads"),
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
        db.close()
    }

    install(CallLogging)
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
        // WEB_ORIGIN 未設定時に anyHost に開放しない (fail-open 防止)。ローカル開発既定のみ許可する
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

    routing {
        healthRoutes()

        // /health 以外の全ルートは認証必須 (fail-closed)。認可は各ルート内で判定する
        authenticate(OIDC_AUTH_NAME) {
            projectRoutes(deps)
            meRoutes()
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
}
