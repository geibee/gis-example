// openapi.yaml (契約の SSoT) とサーバ実装 (Ktor ルーティング) のパス/メソッド突合 (issue #22)。
//
// 手書きの spec と手書きのルートが独立に進化するとドリフトが不可避になるため、
// 実装の登録ツリー (Application.kt の healthRoutes + authenticatedApiRoutes) を走査した
// 実ルート一覧と openapi.yaml の paths を両方向で突合し、単体テスト (gradle test) として
// CI ゲートに乗せる:
// - (a) 実装にあるが契約に無いルート → 失敗 (契約へ追記するか contractExemptRoutes に理由付きで載せる)
// - (b) 契約にあるが実装に無いパス → 失敗 (実装するか契約から削除する)
// - 許可リストの陳腐化 (実装から消えた / 契約に追記された) も失敗させる (fail-closed)
//
// ルーティングツリーの走査は起動時検証 validateAuthorizedRoutes (issue #14) と同じ方式。
// DB 接続は不要 (接続しない限り HikariDataSource は繋ぎにいかない)
package gis.example

import com.zaxxer.hikari.HikariDataSource
import gis.example.routes.AppDependencies
import gis.example.routes.healthRoutes
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.PathSegmentConstantRouteSelector
import io.ktor.server.routing.PathSegmentOptionalParameterRouteSelector
import io.ktor.server.routing.PathSegmentParameterRouteSelector
import io.ktor.server.routing.RootRouteSelector
import io.ktor.server.routing.Route
import io.ktor.server.routing.TrailingSlashRouteSelector
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertTrue

class OpenApiContractSyncTest {

    /**
     * 契約 (openapi.yaml) の対象外とする実装ルートの明示的な許可リスト。
     * 暗黙除外はしない: 載せる場合は必ず理由を書く。キーは正規化形 "METHOD /path"
     * (パスパラメータは "{}") で書く。エントリが実装から消えた場合・契約に追記された
     * 場合はテストが失敗するので、このリストから削除すること
     */
    private val contractExemptRoutes: Map<String, String> = mapOf(
        "GET /health/ready" to
            "ALB ヘルスチェック専用の readiness (issue #18)。web クライアントは呼ばないが、" +
            "openapi.yaml への path 追記は生成型 (generated.ts) の再生成を要するため、" +
            "web チェーンのマージ後に契約へ追記してこのエントリを削除する"
    )

    // ---------------------------------------------------------------- 実装側の一覧取得

    /**
     * Application.module と同じ登録 (healthRoutes + authenticatedApiRoutes) でルーティング
     * ツリーを組み立て、登録済みの全操作を正規化形 "METHOD /path" で返す。
     * authenticate ブロックはツリー形状 (パス) に影響しないため省いている
     */
    private fun implementedOperations(): Set<String> {
        lateinit var operations: Set<String>
        testApplication {
            application {
                val dummyDir = Path.of(System.getProperty("java.io.tmpdir"), "contract-sync-test")
                val deps = AppDependencies(
                    db = Database(HikariDataSource()), // 接続しない限り DB には繋がらないダミー
                    uploadDir = dummyDir,
                    uploadStorage = LocalUploadStorage(dummyDir),
                    apiPublicUrl = "http://localhost:8080",
                    maxUploadBytes = 1
                )
                val root = routing {
                    healthRoutes(db = deps.db, readinessTimeoutMillis = 1000)
                    authenticatedApiRoutes(deps)
                }
                operations = collectOperations(root)
            }
            startApplication()
        }
        return operations
    }

    private fun collectOperations(root: Route): Set<String> {
        val operations = mutableSetOf<String>()
        fun visit(route: Route) {
            val selector = route.selector
            if (selector is HttpMethodRouteSelector) {
                operations += "${selector.method.value.uppercase()} ${pathOf(route)}"
            }
            route.children.forEach(::visit)
        }
        visit(root)
        return operations
    }

    /**
     * ルートから親をたどってパスを再構成する。パスパラメータはパラメータ名の差異が
     * 偽陽性ドリフトにならないよう "{}" へ正規化する (契約側も OpenApiSpecSupport.normalizePath
     * が同じ形に正規化する)。未知のセレクタは黙って読み飛ばさず失敗させる (fail-closed)
     */
    private fun pathOf(route: Route): String {
        val segments = mutableListOf<String>()
        var current: Route? = route
        while (current != null) {
            when (val selector = current.selector) {
                is PathSegmentConstantRouteSelector -> segments += selector.value
                is PathSegmentParameterRouteSelector -> segments += "{}"
                is PathSegmentOptionalParameterRouteSelector -> segments += "{}"
                is HttpMethodRouteSelector -> Unit
                is RootRouteSelector -> Unit
                is TrailingSlashRouteSelector -> Unit
                else -> error("契約突合テストが解釈できない RouteSelector です: $selector (pathOf を拡張すること)")
            }
            current = current.parent
        }
        return "/" + segments.asReversed().joinToString("/")
    }

    // ---------------------------------------------------------------- 両方向の突合

    @Test
    fun `実装の全ルートは openapi に定義されているか許可リストに理由付きで載っている`() {
        val implemented = implementedOperations()
        val documented = OpenApiSpecSupport.operations()
        val undocumented = implemented - documented - contractExemptRoutes.keys
        assertTrue(
            undocumented.isEmpty(),
            "契約 (openapi.yaml) に無い実装ルートがあります。openapi.yaml の paths へ追記して " +
                "generate:contracts を再実行するか、契約対象外なら contractExemptRoutes に理由付きで載せてください: " +
                undocumented.sorted()
        )
    }

    @Test
    fun `openapi の全操作は実装に存在する`() {
        val implemented = implementedOperations()
        val documented = OpenApiSpecSupport.operations()
        val unimplemented = documented - implemented
        assertTrue(
            unimplemented.isEmpty(),
            "実装に無い契約 (openapi.yaml) の操作があります。実装するか openapi.yaml から削除してください: " +
                unimplemented.sorted()
        )
    }

    @Test
    fun `許可リストは実在して契約に載っていないルートだけを含む`() {
        val implemented = implementedOperations()
        val documented = OpenApiSpecSupport.operations()
        val stale = contractExemptRoutes.keys.filter { it !in implemented || it in documented }
        assertTrue(
            stale.isEmpty(),
            "contractExemptRoutes に陳腐化したエントリがあります (実装から消えたか、契約に追記済み)。" +
                "リストから削除してください: ${stale.sorted()}"
        )
    }
}
