// 認可の PDP (Policy Decision Point)。
//
// 設計原則:「可変データ (誰がどのプロジェクトのメンバーか) は DB に、
// ポリシー (ロールが何をできるか) はコードに」。判定は I/O を持たない純粋関数で、
// Cedar と同型の (principal, action, resource) モデルを取る。ポリシーが複雑化して
// 外部エンジン (Cedar / OPA) が必要になったら、AccessPolicy.allows の呼び出し面を
// 保ったまま実装だけを差し替える。
//
// 語彙は 3 層 (詳細は docs/authorization.md):
//   Action     — エンドポイント単位の操作。ルート宣言 (RouteAuthz) が参照する PDP 内部語彙
//   Permission — 画面・機能単位の権限キー。ロール定義と UI 出し分けの語彙で、
//                Action → Permission は全域写像 (PermissionMatrixTest が網羅を強制)
//   ロール      — Permission 集合への名前付け。ロールの追加・変更はこのファイルの
//                宣言変更のみで完結する (ゴールデンマトリクステストが差分を検出する)
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

/**
 * 画面・機能単位の権限キー。ロールが持つのは Action の羅列ではなくこの Permission 集合で、
 * 数百画面規模でも「画面 = 必要 Permission」の対応が語彙として安定する。
 * key は API レスポンス・DB 行・フロントの出し分け宣言など外部へ出すときの安定識別子
 * (enum 名のリネームに引きずられない)
 */
enum class Permission(val key: String) {
    PROJECTS_VIEW("projects.view"),
    LAYERS_VIEW("layers.view"),
    LAYERS_MANAGE("layers.manage"),
    MAP_VIEW("map.view"),
    FEATURES_EDIT("features.edit"),
    BUSINESS_DATA_VIEW("business-data.view"),
    BUSINESS_DATA_EDIT("business-data.edit"),
    IMPORT_RUN("import.run"),
    ANALYSIS_RUN("analysis.run"),
    JOBS_VIEW("jobs.view"),
    ADMIN_USERS_MANAGE("admin.users.manage"),
    ADMIN_MEMBERS_MANAGE("admin.members.manage")
}

/**
 * Action → 必要 Permission の全域写像。when の網羅性でコンパイル時に、
 * PermissionMatrixTest でテスト時に「割り当て漏れの Action がない」ことを強制する
 */
val Action.requiredPermission: Permission
    get() = when (this) {
        Action.PROJECT_READ -> Permission.PROJECTS_VIEW
        Action.LAYER_READ -> Permission.LAYERS_VIEW
        Action.LAYER_WRITE -> Permission.LAYERS_MANAGE
        Action.FEATURE_READ -> Permission.MAP_VIEW
        Action.FEATURE_WRITE -> Permission.FEATURES_EDIT
        Action.BUSINESS_READ -> Permission.BUSINESS_DATA_VIEW
        Action.BUSINESS_WRITE -> Permission.BUSINESS_DATA_EDIT
        Action.IMPORT_EXECUTE -> Permission.IMPORT_RUN
        Action.ANALYSIS_EXECUTE -> Permission.ANALYSIS_RUN
        Action.JOB_READ -> Permission.JOBS_VIEW
        Action.TILE_READ -> Permission.MAP_VIEW
        Action.USER_ADMIN -> Permission.ADMIN_USERS_MANAGE
        Action.MEMBER_ADMIN -> Permission.ADMIN_MEMBERS_MANAGE
    }

/**
 * ロール名 → Permission 集合の解決。今はコード宣言 (BuiltinRoleDefinitions) のみだが、
 * カスタムロールを DB 管理へ移す際はこのインタフェースの実装差し替えで済ませる
 * (AccessPolicy.allows の呼び出し面は変えない)。設計は docs/authorization.md を参照
 */
fun interface RolePermissionResolver {
    fun permissionsOf(role: ProjectRole): Set<Permission>
}

/** 組込みプロジェクトロールの定義。ロールの追加・権限変更はここの宣言変更のみで完結する */
object BuiltinRoleDefinitions : RolePermissionResolver {
    private val viewerPermissions = setOf(
        Permission.PROJECTS_VIEW,
        Permission.LAYERS_VIEW,
        Permission.MAP_VIEW,
        Permission.BUSINESS_DATA_VIEW,
        Permission.JOBS_VIEW
    )
    private val editorPermissions = viewerPermissions + setOf(
        Permission.LAYERS_MANAGE,
        Permission.FEATURES_EDIT,
        Permission.BUSINESS_DATA_EDIT,
        Permission.IMPORT_RUN,
        Permission.ANALYSIS_RUN
    )

    override fun permissionsOf(role: ProjectRole): Set<Permission> = when (role) {
        ProjectRole.VIEWER -> viewerPermissions
        ProjectRole.EDITOR -> editorPermissions
    }
}

sealed interface AuthzResource {
    // プロジェクトに属さないシステム操作 (ユーザー・メンバー管理)。system admin 専用
    data object System : AuthzResource

    data class Project(val projectId: String) : AuthzResource
}

object AccessPolicy {
    private val resolver: RolePermissionResolver = BuiltinRoleDefinitions

    /** ロールの実効 Permission 集合。/api/me への実効権限公開 (フロントの出し分け) はこれを使う */
    fun permissionsOf(role: ProjectRole): Set<Permission> = resolver.permissionsOf(role)

    // ロール × アクションの宣言的マトリクス。ロール定義 (Permission 集合) と
    // Action → Permission 写像から導出する (AccessPolicyTest が全組合せを検査する)
    val rolePermissions: Map<ProjectRole, Set<Action>> =
        ProjectRole.entries.associateWith { role ->
            val granted = resolver.permissionsOf(role)
            Action.entries.filterTo(linkedSetOf()) { it.requiredPermission in granted }
        }

    fun allows(principal: AppPrincipal, action: Action, resource: AuthzResource): Boolean {
        // system admin は全 Permission を持つ (組込みの破壊不能ルール。委譲はしない)
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
