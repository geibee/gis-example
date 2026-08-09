package gis.example

import gis.example.routes.TOTAL_COUNT_HEADER
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.cors.routing.CORS
import java.net.URI

private const val DEFAULT_WEB_ORIGIN = "http://localhost:5173"

internal data class AllowedWebOrigin(
    val scheme: String,
    val authority: String
)

/**
 * WEB_ORIGINS (カンマ区切り) を優先し、未設定時だけ従来の WEB_ORIGIN を読む。
 * どちらも無いdev環境ではlocalhostだけを許可し、anyHostへは決して開放しない。
 */
internal fun allowedWebOriginsFromEnv(getenv: (String) -> String? = System::getenv): List<AllowedWebOrigin> =
    parseAllowedWebOrigins(
        webOrigins = getenv("WEB_ORIGINS"),
        legacyWebOrigin = getenv("WEB_ORIGIN")
    )

internal fun parseAllowedWebOrigins(
    webOrigins: String?,
    legacyWebOrigin: String?
): List<AllowedWebOrigin> {
    val multiple = webOrigins?.takeIf { it.isNotBlank() }
    val rawOrigins = when {
        multiple != null -> multiple.split(',')
        !legacyWebOrigin.isNullOrBlank() -> listOf(legacyWebOrigin)
        else -> listOf(DEFAULT_WEB_ORIGIN)
    }
    if (rawOrigins.any { it.isBlank() }) {
        error("WEB_ORIGINS に空のオリジンを指定できません")
    }
    return rawOrigins.map(::parseOrigin).distinct()
}

private fun parseOrigin(raw: String): AllowedWebOrigin {
    val value = raw.trim()
    val uri = runCatching { URI(value) }.getOrElse {
        error("CORS 許可オリジンが不正なURLです: $value")
    }
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") {
        error("CORS 許可オリジンのschemeはhttpまたはhttpsにしてください: $value")
    }
    if (uri.host.isNullOrBlank() || uri.userInfo != null || uri.query != null || uri.fragment != null) {
        error("CORS 許可オリジンにはscheme・host・任意のportだけを指定してください: $value")
    }
    if (uri.path?.isNotEmpty() == true) {
        error("CORS 許可オリジンにpathを指定できません: $value")
    }
    val host = if (uri.host.contains(':')) "[${uri.host.lowercase()}]" else uri.host.lowercase()
    val authority = if (uri.port >= 0) "$host:${uri.port}" else host
    return AllowedWebOrigin(scheme = scheme, authority = authority)
}

internal fun Application.installWebCors(origins: List<AllowedWebOrigin>) {
    require(origins.isNotEmpty()) { "CORS 許可オリジンは1件以上必要です" }
    install(CORS) {
        origins.forEach { origin ->
            allowHost(origin.authority, schemes = listOf(origin.scheme))
        }
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Patch)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Delete)
        allowMethod(HttpMethod.Options)
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        exposeHeader(TOTAL_COUNT_HEADER)
    }
}
