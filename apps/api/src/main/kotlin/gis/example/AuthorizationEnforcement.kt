// 認可の PEP (Policy Enforcement Point)。ルート層から呼ばれ、
// リソース ID → project_id の DB 導出と AccessPolicy への問い合わせを行う。
//
// ステータスの使い分け:
// - リクエストが projectId を明示する操作の拒否は 403
// - リソース ID しか受けない操作は、非メンバーに対して 404 を返し
//   ID の存在自体を漏らさない (メンバーだがロール不足の場合のみ 403)
package gis.example

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.auth.principal
import java.util.UUID

// リソース種別 → project_id の導出先。テーブル名を SQL へ直接埋めるため許可リストで固定する
enum class ProjectResourceType(
    val table: String,
    val idIsUuid: Boolean,
    val notFoundMessage: String
) {
    LAYER("app.layers", true, "Layer not found"),
    RESULT_SET("app.result_sets", true, "Result set not found"),
    IMPORT_JOB("app.import_jobs", true, "Import job not found"),
    ANALYSIS_JOB("app.analysis_jobs", true, "Analysis job not found"),
    LAND("app.lands", false, "Land not found"),
    BUILDING("app.buildings", false, "Building not found"),
    PARTY("app.parties", false, "Party not found"),
    ZONE("app.zones", false, "Zone not found"),
    PARTY_RELATIONSHIP("app.party_relationships", true, "Relationship not found")
}

fun ApplicationCall.appPrincipal(): AppPrincipal =
    principal<AppPrincipal>()
        ?: throw ApiException(HttpStatusCode.Unauthorized, "Authentication required")

// projectId をリクエストが明示する操作用。拒否は 403
fun ApplicationCall.requireProjectPermission(action: Action, projectId: String) {
    attributes.put(AuthzEnforcedKey, Unit)
    attributes.put(AuditedAction, action)
    attributes.put(AuditedProjectId, projectId)
    if (!AccessPolicy.allows(appPrincipal(), action, AuthzResource.Project(projectId))) {
        throw ApiException(HttpStatusCode.Forbidden, "Permission denied")
    }
}

// ユーザー・メンバー管理などのシステム操作用。拒否は 403
fun ApplicationCall.requireSystemPermission(action: Action) {
    attributes.put(AuthzEnforcedKey, Unit)
    attributes.put(AuditedAction, action)
    if (!AccessPolicy.allows(appPrincipal(), action, AuthzResource.System)) {
        throw ApiException(HttpStatusCode.Forbidden, "Permission denied")
    }
}

// リソース ID しか受けない操作用。project_id を導出して判定し、所属プロジェクトを返す
fun ApplicationCall.requireResourcePermission(
    db: Database,
    action: Action,
    type: ProjectResourceType,
    id: String
): String {
    attributes.put(AuthzEnforcedKey, Unit)
    attributes.put(AuditedAction, action)
    val notFound = ApiException(HttpStatusCode.NotFound, type.notFoundMessage)
    val projectId = db.projectIdOf(type, id) ?: throw notFound
    attributes.put(AuditedProjectId, projectId)
    val principal = appPrincipal()
    if (AccessPolicy.allows(principal, action, AuthzResource.Project(projectId))) return projectId
    if (projectId !in principal.memberships) throw notFound
    throw ApiException(HttpStatusCode.Forbidden, "Permission denied")
}

internal fun Database.projectIdOf(type: ProjectResourceType, id: String): String? {
    // uuid 列への不正な文字列は SQL エラーではなく「存在しない」として扱う
    if (type.idIsUuid && runCatching { UUID.fromString(id) }.isFailure) return null
    val idExpr = if (type.idIsUuid) "?::uuid" else "?"
    return dataSource.connection.use { connection ->
        connection.prepareStatement(
            "SELECT project_id::text FROM ${type.table} WHERE id = $idExpr"
        ).use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
    }
}
