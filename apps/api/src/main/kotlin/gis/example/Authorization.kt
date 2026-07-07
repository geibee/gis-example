// 認可の PDP (Policy Decision Point)。
//
// 設計原則:「可変データ (誰がどのプロジェクトのメンバーか) は DB に、
// ポリシー (ロールが何をできるか) はコードに」。判定は I/O を持たない純粋関数で、
// Cedar と同型の (principal, action, resource) モデルを取る。ポリシーが複雑化して
// 外部エンジン (Cedar / OPA) が必要になったら、AccessPolicy.allows の呼び出し面を
// 保ったまま実装だけを差し替える。
package gis.example

enum class ProjectRole { EDITOR, VIEWER }

// エンドポイントを集約した権限アクション。エンドポイント追加時は必ずいずれかへ割り当てる
enum class Action {
    PROJECT_READ,
    LAYER_READ,
    LAYER_WRITE,
    FEATURE_READ,
    FEATURE_WRITE,
    BUSINESS_READ,
    BUSINESS_WRITE,
    IMPORT_EXECUTE,
    ANALYSIS_EXECUTE,
    JOB_READ,
    TILE_READ,
    USER_ADMIN,
    MEMBER_ADMIN
}

sealed interface AuthzResource {
    // プロジェクトに属さないシステム操作 (ユーザー・メンバー管理)。system admin 専用
    data object System : AuthzResource

    data class Project(val projectId: String) : AuthzResource
}

object AccessPolicy {
    private val viewerActions = setOf(
        Action.PROJECT_READ,
        Action.LAYER_READ,
        Action.FEATURE_READ,
        Action.BUSINESS_READ,
        Action.JOB_READ,
        Action.TILE_READ
    )
    private val editorActions = viewerActions + setOf(
        Action.LAYER_WRITE,
        Action.FEATURE_WRITE,
        Action.BUSINESS_WRITE,
        Action.IMPORT_EXECUTE,
        Action.ANALYSIS_EXECUTE
    )

    // ロール × アクションの宣言的マトリクス (AccessPolicyTest が全組合せを検査する)
    val rolePermissions: Map<ProjectRole, Set<Action>> = mapOf(
        ProjectRole.VIEWER to viewerActions,
        ProjectRole.EDITOR to editorActions
    )

    fun allows(principal: AppPrincipal, action: Action, resource: AuthzResource): Boolean {
        if (principal.systemRole == SystemRole.ADMIN) return true
        return when (resource) {
            is AuthzResource.System -> false
            is AuthzResource.Project -> {
                val role = principal.memberships[resource.projectId]
                role != null && action in rolePermissions.getValue(role)
            }
        }
    }
}
