// 認可の構造的強制: ルート登録時に認可宣言 (RouteAuthz) を必須にし、
// 「認可チェックを呼び忘れたエンドポイントはリクエストが通らない」fail-closed 構造を作る。
//
// 3 層の防御 (routes ファイルが増えても目視レビューに頼らない):
// 1. 登録 DSL (authorizedRoutes): 認可宣言なしにハンドラを書けない。宣言に基づき
//    ハンドラ実行前に PEP (AuthorizationEnforcement) を呼ぶ
// 2. 起動時検証 (validateAuthorizedRoutes): 宣言なしで登録されたルート (生の get/post 等)
//    が 1 つでもあればアプリを起動させない
// 3. 実行時ガード (authzGuardPlugin): 認可判定マーカーのない 2xx 応答を 500 に置き換える
//    (CheckedInHandler ルートで PEP を呼び忘れた場合の最終安全網)
//
// 認可の実質判定 (PDP) と HTTP 挙動 (403/404 の使い分け・監査ログ) は
// Authorization.kt / AuthorizationEnforcement.kt のまま変えない。
package gis.example

import gis.example.routes.requireUuid
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.withCharset
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.RouteScopedPlugin
import io.ktor.server.application.call
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.hooks.ResponseBodyReadyForSend
import io.ktor.server.auth.principal
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.request.receive
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.Route
import io.ktor.server.routing.route
import io.ktor.util.AttributeKey
import io.ktor.util.pipeline.PipelineContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.slf4j.LoggerFactory

private val authzLogger = LoggerFactory.getLogger("gis.example.AuthzGuard")

// ルートが宣言する認可方法。エンドポイント追加時は必ずいずれかを選ぶ
sealed interface RouteAuthz {

    /** クエリパラメータの projectId で判定する (一覧系)。欠落・不正 UUID は 400、拒否は 403 */
    data class ProjectFromQuery(val action: Action, val param: String = "projectId") : RouteAuthz

    /**
     * JsonObject ボディの必須 UUID フィールドで判定する (作成系)。拒否は 403。
     * 受信済みボディはハンドラから call.authorizedJsonBody() で取り出す
     */
    data class ProjectFromBodyField(val action: Action, val field: String = "projectId") : RouteAuthz

    /**
     * パスパラメータのリソース ID から project を導出して判定する。
     * 非メンバーには 404 で存在を秘匿する (AuthorizationEnforcement の規約どおり)。
     * uuidLabel を指定すると判定前に requireUuid で 400 検証する (レイヤ・ジョブ等の UUID 主キー用)。
     * 解決済み ID はハンドラから call.authorizedResourceId() で取り出す
     */
    data class ResourceFromPath(
        val action: Action,
        val type: ProjectResourceType,
        val param: String = "id",
        val uuidLabel: String? = null
    ) : RouteAuthz

    /** プロジェクトに属さないシステム操作 (system admin 専用)。拒否は 403 */
    data class SystemAction(val action: Action) : RouteAuthz

    /** 認証のみでよいルート (対象リソースがない)。理由の明記を必須にする */
    data class AuthenticatedOnly(val justification: String) : RouteAuthz {
        init {
            require(justification.isNotBlank()) { "AuthenticatedOnly には理由の明記が必要です" }
        }
    }

    /**
     * ボディの解釈と認可が分離できないルート用の逃げ道 (multipart や既定プロジェクトへの
     * フォールバック等)。ハンドラ自身が call.require* を呼ぶ責務を負い、呼び忘れは
     * authzGuardPlugin が 2xx 応答を 500 に置き換えて fail-closed にする
     */
    data class CheckedInHandler(val action: Action, val justification: String) : RouteAuthz {
        init {
            require(justification.isNotBlank()) { "CheckedInHandler には理由の明記が必要です" }
        }
    }
}

// 起動時検証・実行時ガードが参照するマーカー類
internal val RouteAuthzKey = AttributeKey<RouteAuthz>("authz.declaration")
internal val PublicRouteKey = AttributeKey<String>("authz.publicJustification")

// PEP が認可判定を実施した (許可・拒否を問わず) ことを示すマーカー。
// authzGuardPlugin が 2xx 応答時に存在を検査する
internal val AuthzEnforcedKey = AttributeKey<Unit>("authz.enforced")

private val AuthorizedProjectIdKey = AttributeKey<String>("authz.projectId")
private val AuthorizedResourceIdKey = AttributeKey<String>("authz.resourceId")
private val AuthorizedJsonBodyKey = AttributeKey<JsonObject>("authz.jsonBody")

typealias AuthorizedHandler = suspend PipelineContext<Unit, ApplicationCall>.() -> Unit

/** 認可宣言を必須にするルート登録スコープ。routes ファイルはこの中でのみエンドポイントを定義する */
class AuthorizedRoutes internal constructor(
    private val parent: Route,
    private val db: Database
) {
    fun get(path: String, authz: RouteAuthz, body: AuthorizedHandler): Route =
        register(HttpMethod.Get, path, authz, body)

    fun post(path: String, authz: RouteAuthz, body: AuthorizedHandler): Route =
        register(HttpMethod.Post, path, authz, body)

    fun put(path: String, authz: RouteAuthz, body: AuthorizedHandler): Route =
        register(HttpMethod.Put, path, authz, body)

    fun patch(path: String, authz: RouteAuthz, body: AuthorizedHandler): Route =
        register(HttpMethod.Patch, path, authz, body)

    fun delete(path: String, authz: RouteAuthz, body: AuthorizedHandler): Route =
        register(HttpMethod.Delete, path, authz, body)

    private fun register(method: HttpMethod, path: String, authz: RouteAuthz, body: AuthorizedHandler): Route {
        val terminal = parent.route(path, method) {
            handle {
                // 宣言された認可をハンドラ本体より先に強制する (拒否時は本体を実行しない)
                call.enforceRouteAuthz(authz, db)
                body()
            }
        }
        terminal.attributes.put(RouteAuthzKey, authz)
        return terminal
    }
}

fun Route.authorizedRoutes(db: Database, build: AuthorizedRoutes.() -> Unit) {
    AuthorizedRoutes(this, db).build()
}

/**
 * 認証境界 (authenticate ブロック) の外に置くルートの明示的な許可リスト。
 * 理由の明記を必須にし、起動時検証はこのマーカーを持つルートのみ認可宣言なしを許す
 */
fun Route.unauthenticatedGet(path: String, justification: String, body: AuthorizedHandler): Route {
    require(justification.isNotBlank()) { "unauthenticatedGet には理由の明記が必要です" }
    val terminal = route(path, HttpMethod.Get) {
        handle { body() }
    }
    terminal.attributes.put(PublicRouteKey, justification)
    return terminal
}

// ---------------------------------------------------------------- 宣言の実行 (PEP 呼び出し)

private suspend fun ApplicationCall.enforceRouteAuthz(authz: RouteAuthz, db: Database) {
    when (authz) {
        is RouteAuthz.ProjectFromQuery -> {
            val projectId = requireUuid(
                request.queryParameters[authz.param]
                    ?: throw ApiException(HttpStatusCode.BadRequest, "${authz.param} is required"),
                authz.param
            )
            attributes.put(AuthorizedProjectIdKey, projectId)
            requireProjectPermission(authz.action, projectId)
        }
        is RouteAuthz.ProjectFromBodyField -> {
            val body = receive<JsonObject>()
            attributes.put(AuthorizedJsonBodyKey, body)
            val projectId = readRequiredUuid(body, authz.field)
            attributes.put(AuthorizedProjectIdKey, projectId)
            requireProjectPermission(authz.action, projectId)
        }
        is RouteAuthz.ResourceFromPath -> {
            val raw = parameters[authz.param]
                ?: throw ApiException(HttpStatusCode.BadRequest, "${authz.param} is required")
            val id = if (authz.uuidLabel != null) requireUuid(raw, authz.uuidLabel) else raw
            attributes.put(AuthorizedResourceIdKey, id)
            attributes.put(AuthorizedProjectIdKey, requireResourcePermission(db, authz.action, authz.type, id))
        }
        is RouteAuthz.SystemAction -> requireSystemPermission(authz.action)
        is RouteAuthz.AuthenticatedOnly -> {
            appPrincipal()
            attributes.put(AuthzEnforcedKey, Unit)
        }
        // ハンドラ内の call.require* 呼び出しを authzGuardPlugin が検査する
        is RouteAuthz.CheckedInHandler -> Unit
    }
}

/** ProjectFromQuery / ProjectFromBodyField / ResourceFromPath 宣言のルートで、認可済み projectId を取り出す */
fun ApplicationCall.authorizedProjectId(): String =
    attributes.getOrNull(AuthorizedProjectIdKey)
        ?: error("authorizedProjectId は projectId を解決する RouteAuthz 宣言のルートでのみ使用できます")

/** ResourceFromPath 宣言のルートで、認可済みリソース ID (uuidLabel 指定時は正規化済み) を取り出す */
fun ApplicationCall.authorizedResourceId(): String =
    attributes.getOrNull(AuthorizedResourceIdKey)
        ?: error("authorizedResourceId は ResourceFromPath 宣言のルートでのみ使用できます")

/** ProjectFromBodyField 宣言のルートで、認可時に受信済みのボディを取り出す */
fun ApplicationCall.authorizedJsonBody(): JsonObject =
    attributes.getOrNull(AuthorizedJsonBodyKey)
        ?: error("authorizedJsonBody は ProjectFromBodyField 宣言のルートでのみ使用できます")

// ---------------------------------------------------------------- 実行時ガード (最終安全網)

/**
 * 認可判定マーカー (AuthzEnforcedKey) のない 2xx 応答を検出し、500 に置き換えて
 * 監査ログへ記録する。authenticate ブロック直下に install し、認証配下の全ルートへ適用する。
 * 400 以上の応答 (401 チャレンジ・バリデーション 400・PEP の 403/404 等) は対象外
 */
fun authzGuardPlugin(db: Database?): RouteScopedPlugin<Unit> =
    createRouteScopedPlugin("AuthzGuard") {
        on(ResponseBodyReadyForSend) { call, content ->
            val status = content.status ?: call.response.status() ?: HttpStatusCode.OK
            if (status.value >= 400) return@on
            if (call.attributes.contains(AuthzEnforcedKey)) return@on

            val method = call.request.httpMethod.value
            val path = call.request.path()
            authzLogger.error(
                "認可判定なしの成功応答を検出したため 500 に置き換えます (認可チェックの呼び忘れ): {} {}",
                method,
                path
            )
            if (db != null) {
                val principal = call.principal<AppPrincipal>()
                runCatching {
                    db.insertAuditLog(
                        userId = principal?.userId,
                        subject = principal?.subject,
                        action = null,
                        decision = "deny",
                        projectId = null,
                        httpMethod = method,
                        path = path,
                        statusCode = HttpStatusCode.InternalServerError.value
                    )
                }.onFailure { exc ->
                    authzLogger.warn("認可ガードの監査ログ書込みに失敗しました: {} {}", method, path, exc)
                }
            }
            transformBodyTo(
                TextContent(
                    Json.encodeToString(ErrorResponse.serializer(), ErrorResponse("Internal server error")),
                    ContentType.Application.Json.withCharset(Charsets.UTF_8),
                    HttpStatusCode.InternalServerError
                )
            )
        }
    }

// ---------------------------------------------------------------- 起動時検証

/**
 * ルーティングツリーを走査し、認可宣言 (RouteAuthz) も公開許可 (unauthenticatedGet) も
 * 持たないエンドポイントがあれば起動を失敗させる。生の get/post 等での登録漏れを CI と
 * 起動時に検出する
 */
fun validateAuthorizedRoutes(root: Route) {
    val undeclared = mutableListOf<String>()
    fun visit(route: Route) {
        if (route.selector is HttpMethodRouteSelector &&
            !route.attributes.contains(RouteAuthzKey) &&
            !route.attributes.contains(PublicRouteKey)
        ) {
            undeclared += route.toString()
        }
        route.children.forEach { visit(it) }
    }
    visit(root)
    check(undeclared.isEmpty()) {
        "認可宣言のないルートが登録されています。authorizedRoutes { } (または認証外なら unauthenticatedGet) で登録してください: $undeclared"
    }
}
