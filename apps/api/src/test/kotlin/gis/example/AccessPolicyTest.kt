package gis.example

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// PDP (AccessPolicy.allows) の網羅テスト。
// ロール × 全アクション × リソース種別の全組合せを期待表と突き合わせる
class AccessPolicyTest {

    private val projectA = "aaaaaaaa-0000-0000-0000-000000000000"
    private val projectB = "bbbbbbbb-0000-0000-0000-000000000000"

    private fun principal(
        systemRole: SystemRole = SystemRole.USER,
        memberships: Map<String, ProjectRole> = emptyMap()
    ) = AppPrincipal(
        userId = "u-1",
        subject = "sub-1",
        email = null,
        displayName = null,
        systemRole = systemRole,
        memberships = memberships
    )

    private val readActions = setOf(
        Action.PROJECT_READ,
        Action.LAYER_READ,
        Action.FEATURE_READ,
        Action.BUSINESS_READ,
        Action.JOB_READ,
        Action.TILE_READ
    )
    private val writeActions = setOf(
        Action.LAYER_WRITE,
        Action.FEATURE_WRITE,
        Action.BUSINESS_WRITE,
        Action.IMPORT_EXECUTE,
        Action.ANALYSIS_EXECUTE
    )
    private val systemActions = setOf(Action.USER_ADMIN, Action.MEMBER_ADMIN)

    @Test
    fun `アクション全体が期待表と一致する (新アクションの追加漏れ検知)`() {
        assertEquals(readActions + writeActions + systemActions, Action.entries.toSet())
    }

    @Test
    fun `admin は全アクションを全リソースで許可される`() {
        val admin = principal(systemRole = SystemRole.ADMIN)
        for (action in Action.entries) {
            assertTrue(AccessPolicy.allows(admin, action, AuthzResource.Project(projectA)), "admin $action project")
            assertTrue(AccessPolicy.allows(admin, action, AuthzResource.System), "admin $action system")
        }
    }

    @Test
    fun `viewer はメンバープロジェクトの read 系のみ許可される`() {
        val viewer = principal(memberships = mapOf(projectA to ProjectRole.VIEWER))
        for (action in Action.entries) {
            assertEquals(
                action in readActions,
                AccessPolicy.allows(viewer, action, AuthzResource.Project(projectA)),
                "viewer $action"
            )
        }
    }

    @Test
    fun `editor はメンバープロジェクトの read と write を許可されシステム操作は拒否される`() {
        val editor = principal(memberships = mapOf(projectA to ProjectRole.EDITOR))
        for (action in Action.entries) {
            assertEquals(
                action in readActions + writeActions,
                AccessPolicy.allows(editor, action, AuthzResource.Project(projectA)),
                "editor $action"
            )
        }
    }

    @Test
    fun `メンバーでないプロジェクトは editor でも全アクション拒否される`() {
        val editor = principal(memberships = mapOf(projectA to ProjectRole.EDITOR))
        for (action in Action.entries) {
            assertFalse(AccessPolicy.allows(editor, action, AuthzResource.Project(projectB)), "non-member $action")
        }
    }

    @Test
    fun `システムリソースは admin 以外に一切許可されない`() {
        val editor = principal(memberships = mapOf(projectA to ProjectRole.EDITOR))
        val nobody = principal()
        for (action in Action.entries) {
            assertFalse(AccessPolicy.allows(editor, action, AuthzResource.System), "editor system $action")
            assertFalse(AccessPolicy.allows(nobody, action, AuthzResource.System), "no-member system $action")
        }
    }

    @Test
    fun `メンバーシップゼロのユーザーは何も許可されない (JIT 直後の既定)`() {
        val nobody = principal()
        for (action in Action.entries) {
            assertFalse(AccessPolicy.allows(nobody, action, AuthzResource.Project(projectA)), "zero-membership $action")
        }
    }
}
