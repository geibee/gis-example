// 観測性 (issue #18): ログ収集・保管・検索は CloudWatch Logs (インフラ責務) に委譲するが、
// 「stdout に出したログが調査に使える形か」はアプリ側の責務として残る。ここでは
// - requestId (callId): X-Request-Id / X-Amzn-Trace-Id を尊重し、無ければ UUID を生成。
//   レスポンスヘッダ X-Request-Id で返し、MDC (callId) として全ログ行へ伝播する
// - アクセスログ (CallLogging): method / path / status / durationMs / clientIp / callId を
//   MDC に載せた完了ログを 1 リクエスト 1 行出す。/health 系は監視ノイズなので除外する
// を担う。JSON への切替 (LOG_FORMAT) は logback.xml、全体像は docs/observability.md を参照
package gis.example

import io.ktor.http.HttpHeaders
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.callid.CallId
import io.ktor.server.plugins.callid.callIdMdc
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.callloging.processingTimeMillis
import io.ktor.server.plugins.origin
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import org.slf4j.LoggerFactory
import java.util.UUID

// MDC キー。logback.xml (text の %X{callId}) と docs/observability.md が参照する
const val CALL_ID_MDC_KEY = "callId"

// アクセスログ専用ロガー。アプリログと logger_name で区別できるようにする
internal const val ACCESS_LOG_LOGGER_NAME = "gis.example.AccessLog"

/**
 * LOG_FORMAT は logback.xml が appender 名の解決に使う。不正値だと appender が見つからず
 * 「無ログで起動し続ける」事故になるため、本番エントリポイント (main) で先に検証して
 * 起動を失敗させる (fail fast)
 */
fun validateLogFormatEnv(getenv: (String) -> String? = System::getenv) {
    val format = getenv("LOG_FORMAT") ?: "text"
    require(format == "text" || format == "json") {
        "LOG_FORMAT は text | json のいずれかを指定してください: $format"
    }
}

fun Application.installObservability() {
    install(CallId) {
        // 採用順: X-Request-Id (呼び出し側が明示した相関 ID) → X-Amzn-Trace-Id (ALB が必ず付与
        // する trace ID。ALB アクセスログと突合できる) → 自前生成 (直接アクセスや dev)。
        // クライアント由来の値をログとレスポンスヘッダに反射するため、印字可能 ASCII のみ・
        // 長さ上限で検証する (ログ注入・巨大ヘッダ反射の防止)。検証は retrieve 側で行う:
        // verify で落とすと callId なしのリクエストになるが、retrieve で null を返せば
        // generate へフォールバックし、全リクエストが必ず callId を持つ
        retrieve { call -> call.request.headers[HttpHeaders.XRequestId]?.takeIf(::isValidCallId) }
        retrieve { call -> call.request.headers[AMZN_TRACE_ID_HEADER]?.takeIf(::isValidCallId) }
        generate { UUID.randomUUID().toString() }
        verify(::isValidCallId)
        replyToHeader(HttpHeaders.XRequestId)
    }
    install(CallLogging) {
        logger = LoggerFactory.getLogger(ACCESS_LOG_LOGGER_NAME)
        // /health・/health/ready は ALB/ECS が定期的に叩く監視ノイズなので出さない
        filter { call -> !call.request.path().startsWith("/health") }
        // callId はアクセスログだけでなく、リクエスト処理中の全ログ行の MDC に乗る
        callIdMdc(CALL_ID_MDC_KEY)
        // LOG_FORMAT=json では以下が JSON フィールドになり、Logs Insights で直接フィルタできる。
        // MDC 値は最初に非 null を返した時点の値がコールごとにキャッシュされるため、
        // status / durationMs は「応答が確定するまで null を返す」ことで完了ログ行にのみ
        // 最終値を乗せる (処理途中の中途半端な経過時間を凍結させない)
        mdc("httpMethod") { it.request.httpMethod.value }
        mdc("path") { it.request.path() }
        // XForwardedHeaders (TRUSTED_PROXY_COUNT) 解決済みのクライアント IP
        mdc("clientIp") { it.request.origin.remoteHost }
        mdc("status") { it.response.status()?.value?.toString() }
        mdc("durationMs") { call -> call.response.status()?.let { call.processingTimeMillis().toString() } }
        // text 形式向けの完了ログ本文 (json では上記 MDC が正)
        format { call ->
            val status = call.response.status()?.value?.toString() ?: "unhandled"
            "${call.request.httpMethod.value} ${call.request.path()} -> " +
                "$status (${call.processingTimeMillis()}ms) from ${call.request.origin.remoteHost}"
        }
    }
}

// ALB が付与する trace ヘッダ。形式は "Root=1-xxxxxxxx-xxxx..." (= や ; を含む)
private const val AMZN_TRACE_ID_HEADER = "X-Amzn-Trace-Id"

private const val MAX_CALL_ID_LENGTH = 200

private fun isValidCallId(id: String): Boolean =
    id.isNotEmpty() && id.length <= MAX_CALL_ID_LENGTH && id.all { it.code in 33..126 }
