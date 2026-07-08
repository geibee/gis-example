package gis.example

import kotlin.test.Test
import kotlin.test.assertEquals

// Permission モデルのゴールデンテスト。期待値はすべて文字列リテラルの表で固定し、
// ポリシー定義 (ロール → Permission 集合、Action → Permission 写像) のあらゆる変更を
// このファイルとの差分として顕在化させる。意図した権限変更のときだけ、この表を同時に更新する。
// (AccessPolicyTest が allows() の振る舞いを、本テストが宣言そのものを固定する)
class PermissionMatrixTest {

    // ---------------------------------------------------------------- Action → Permission 写像

    // ゴールデン表: 全 Action の必要 Permission (キー表記)
    private val goldenActionPermissions = mapOf(
        "PROJECT_READ" to "projects.view",
        "LAYER_READ" to "layers.view",
        "LAYER_WRITE" to "layers.manage",
        "FEATURE_READ" to "map.view",
        "FEATURE_WRITE" to "features.edit",
        "BUSINESS_READ" to "business-data.view",
        "BUSINESS_WRITE" to "business-data.edit",
        "IMPORT_EXECUTE" to "import.run",
        "ANALYSIS_EXECUTE" to "analysis.run",
        "JOB_READ" to "jobs.view",
        "TILE_READ" to "map.view",
        "USER_ADMIN" to "admin.users.manage",
        "MEMBER_ADMIN" to "admin.members.manage"
    )

    @Test
    fun `全 Action が Permission へ漏れなく割り当てられゴールデン表と一致する`() {
        assertEquals(
            goldenActionPermissions,
            Action.entries.associate { it.name to it.requiredPermission.key },
            "Action → Permission 写像が変わりました。意図した変更ならゴールデン表を更新してください"
        )
    }

    @Test
    fun `全 Permission がいずれかの Action から参照される (使われない権限キーを作らない)`() {
        assertEquals(
            Permission.entries.toSet(),
            Action.entries.map { it.requiredPermission }.toSet(),
            "どの Action からも参照されない Permission があります (死んだ権限キーは UI 出し分けの誤解を生む)"
        )
    }

    @Test
    fun `Permission の外部キーは一意である`() {
        val keys = Permission.entries.map { it.key }
        assertEquals(keys.size, keys.toSet().size, "Permission.key が重複しています: $keys")
    }

    // ---------------------------------------------------------------- ロール → Permission 集合

    // ゴールデン表: 組込みロールの Permission 集合 (キー表記)
    private val goldenRolePermissions = mapOf(
        "VIEWER" to setOf(
            "projects.view",
            "layers.view",
            "map.view",
            "business-data.view",
            "jobs.view"
        ),
        "EDITOR" to setOf(
            "projects.view",
            "layers.view",
            "layers.manage",
            "map.view",
            "features.edit",
            "business-data.view",
            "business-data.edit",
            "import.run",
            "analysis.run",
            "jobs.view"
        )
    )

    @Test
    fun `組込みロールの Permission 集合がゴールデン表と一致する`() {
        assertEquals(
            goldenRolePermissions,
            ProjectRole.entries.associate { role ->
                role.name to AccessPolicy.permissionsOf(role).map { it.key }.toSet()
            },
            "ロール定義が変わりました。意図した変更ならゴールデン表を更新してください"
        )
    }

    // ---------------------------------------------------------------- ロール × Action の実効マトリクス

    // ゴールデン表: PDP の最終出力 (ロールごとの許可 Action)。
    // Permission 経由の導出結果がここからずれたら、既存ロールの実効権限が変わったことを意味する
    private val goldenAllowedActions = mapOf(
        "VIEWER" to setOf(
            "PROJECT_READ",
            "LAYER_READ",
            "FEATURE_READ",
            "BUSINESS_READ",
            "JOB_READ",
            "TILE_READ"
        ),
        "EDITOR" to setOf(
            "PROJECT_READ",
            "LAYER_READ",
            "LAYER_WRITE",
            "FEATURE_READ",
            "FEATURE_WRITE",
            "BUSINESS_READ",
            "BUSINESS_WRITE",
            "IMPORT_EXECUTE",
            "ANALYSIS_EXECUTE",
            "JOB_READ",
            "TILE_READ"
        )
    )

    @Test
    fun `ロール × Action の実効マトリクスがゴールデン表と一致する (意図しない権限変化の検出)`() {
        assertEquals(
            goldenAllowedActions,
            ProjectRole.entries.associate { role ->
                role.name to AccessPolicy.rolePermissions.getValue(role).map { it.name }.toSet()
            },
            "既存ロールの実効権限が変わりました。意図した変更ならゴールデン表を更新してください"
        )
    }

    @Test
    fun `実効マトリクスは allows() の判定と一致する (導出と判定の乖離防止)`() {
        val project = "aaaaaaaa-0000-0000-0000-000000000000"
        for (role in ProjectRole.entries) {
            val principal = AppPrincipal(
                userId = "u-1",
                subject = "sub-1",
                email = null,
                displayName = null,
                systemRole = SystemRole.USER,
                memberships = mapOf(project to role)
            )
            for (action in Action.entries) {
                assertEquals(
                    action.name in goldenAllowedActions.getValue(role.name),
                    AccessPolicy.allows(principal, action, AuthzResource.Project(project)),
                    "$role × $action"
                )
            }
        }
    }
}
