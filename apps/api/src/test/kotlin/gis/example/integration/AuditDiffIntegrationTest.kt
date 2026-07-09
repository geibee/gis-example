// 監査ログへの変更内容 (diff) 記録 (issue #23) の統合テスト:
// - create は after 全体 / delete は before 全体 / update は変更フィールドのみが detail に残る
// - 変更なしの update も fields 空のエントリで対象 (entityType/entityId) を特定できる
// - 巨大な geometry (GeoJSON) は全文ではなく要約形 (truncated/sizeChars/sha256) になる
// - メンバーのロール変更が before/after で追跡できる
// call_id (X-Request-Id) でリクエストと audit_logs 行を突合する
package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuditDiffIntegrationTest {

    private val defaultProject = "00000000-0000-0000-0000-000000000000"
    private val parcelsLayerId = "11111111-1111-1111-1111-111111111111"
    private val viewerUserId = "d0000000-0000-4000-8000-000000000003"

    private val adminBearer = "Bearer ${OidcTestSupport.token("audit-admin")}"
    private val editorBearer = "Bearer ${OidcTestSupport.token("audit-editor")}"

    private fun rawConnection(): Connection =
        DriverManager.getConnection(IntegrationDb.url, IntegrationDb.user, IntegrationDb.password)

    private fun repoFile(relative: String): String {
        var dir = Path.of("").toAbsolutePath()
        while (!Files.exists(dir.resolve(".git"))) {
            dir = dir.parent ?: fail("リポジトリルートが見つかりません")
        }
        return Files.readString(dir.resolve(relative))
    }

    @BeforeAll
    fun setUpSchema() {
        rawConnection().use { connection ->
            connection.createStatement().use { stmt ->
                stmt.execute("DROP SCHEMA IF EXISTS app CASCADE")
                stmt.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
            }
            connection.createStatement().use { stmt ->
                stmt.execute(repoFile("infra/postgres/init.sql"))
            }
            IntegrationDb.migrate()
            val fixture = this::class.java.getResource("/integration-fixture.sql")
                ?: fail("integration-fixture.sql がテストリソースにありません")
            connection.createStatement().use { stmt ->
                stmt.execute(fixture.readText())
            }
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.users (id, subject, email, system_role)
                    VALUES
                      ('d0000000-0000-4000-8000-000000000001', 'audit-admin', 'audit-admin@gis.example', 'admin'),
                      ('d0000000-0000-4000-8000-000000000002', 'audit-editor', 'audit-editor@gis.example', 'user'),
                      ('$viewerUserId', 'audit-viewer', 'audit-viewer@gis.example', 'user');

                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES
                      ('d0000000-0000-4000-8000-000000000002', '$defaultProject', 'editor'),
                      ('$viewerUserId', '$defaultProject', 'viewer');
                    """.trimIndent()
                )
            }
        }
    }

    private fun withApp(block: suspend (HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    /** call_id で監査ログ行を特定し detail を取り出す */
    private fun detailFor(callId: String): JsonObject {
        val text = rawConnection().use { connection ->
            connection.prepareStatement("SELECT detail::text FROM app.audit_logs WHERE call_id = ?").use { stmt ->
                stmt.setString(1, callId)
                stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
            }
        }
        assertNotNull(text, "監査ログの detail が記録されるはず (call_id=$callId)")
        return Json.parseToJsonElement(text).jsonObject
    }

    private fun singleChange(callId: String): JsonObject {
        val changes = detailFor(callId)["changes"]!!.jsonArray
        assertEquals(1, changes.size, "1 操作 1 エントリのはず")
        return changes[0].jsonObject
    }

    @Test
    fun `create は after 全体、update は変更フィールドのみ、delete は before 全体が detail に残る`() = withApp { client ->
        val landId = "L-AUDIT-1"
        val createCallId = "audit-create-${System.nanoTime()}"
        val response = client.post("/api/lands") {
            header(HttpHeaders.Authorization, editorBearer)
            header(HttpHeaders.XRequestId, createCallId)
            contentType(ContentType.Application.Json)
            setBody("""{"id": "$landId", "projectId": "$defaultProject", "lotNumber": "audit-1", "address": "監査テスト町1", "landUse": "宅地"}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val created = singleChange(createCallId)
        assertEquals("land", created["entityType"]!!.jsonPrimitive.content)
        assertEquals(landId, created["entityId"]!!.jsonPrimitive.content)
        assertEquals("create", created["operation"]!!.jsonPrimitive.content)
        val createdFields = created["fields"]!!.jsonObject
        assertEquals("audit-1", createdFields["lotNumber"]!!.jsonObject["after"]!!.jsonPrimitive.content)
        assertEquals("調査中", createdFields["status"]!!.jsonObject["after"]!!.jsonPrimitive.content, "既定値も after 全体に含む")
        assertFalse("before" in createdFields["lotNumber"]!!.jsonObject, "create に before は無い")
        assertFalse("memo" in createdFields, "null のフィールドは create に載せない")

        val updateCallId = "audit-update-${System.nanoTime()}"
        assertEquals(
            HttpStatusCode.OK,
            client.patch("/api/lands/$landId") {
                header(HttpHeaders.Authorization, editorBearer)
                header(HttpHeaders.XRequestId, updateCallId)
                contentType(ContentType.Application.Json)
                setBody("""{"status": "完了", "memo": "diff 検証"}""")
            }.status
        )
        val updated = singleChange(updateCallId)
        assertEquals("update", updated["operation"]!!.jsonPrimitive.content)
        assertEquals(landId, updated["entityId"]!!.jsonPrimitive.content)
        val updatedFields = updated["fields"]!!.jsonObject
        assertEquals(setOf("memo", "status"), updatedFields.keys, "変更のあったフィールドのみが記録される")
        assertEquals("調査中", updatedFields["status"]!!.jsonObject["before"]!!.jsonPrimitive.content)
        assertEquals("完了", updatedFields["status"]!!.jsonObject["after"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, updatedFields["memo"]!!.jsonObject["before"])
        assertEquals("diff 検証", updatedFields["memo"]!!.jsonObject["after"]!!.jsonPrimitive.content)

        val deleteCallId = "audit-delete-${System.nanoTime()}"
        assertEquals(
            HttpStatusCode.NoContent,
            client.delete("/api/lands/$landId") {
                header(HttpHeaders.Authorization, editorBearer)
                header(HttpHeaders.XRequestId, deleteCallId)
            }.status
        )
        val deleted = singleChange(deleteCallId)
        assertEquals("delete", deleted["operation"]!!.jsonPrimitive.content)
        val deletedFields = deleted["fields"]!!.jsonObject
        assertEquals("audit-1", deletedFields["lotNumber"]!!.jsonObject["before"]!!.jsonPrimitive.content)
        assertEquals("完了", deletedFields["status"]!!.jsonObject["before"]!!.jsonPrimitive.content)
        assertFalse("after" in deletedFields["lotNumber"]!!.jsonObject, "delete に after は無い")
    }

    @Test
    fun `変更なしの update も fields 空のエントリで対象を特定できる`() = withApp { client ->
        val callId = "audit-noop-${System.nanoTime()}"
        assertEquals(
            HttpStatusCode.OK,
            client.patch("/api/lands/L-IT-1") {
                header(HttpHeaders.Authorization, editorBearer)
                header(HttpHeaders.XRequestId, callId)
                contentType(ContentType.Application.Json)
                setBody("{}")
            }.status
        )
        val change = singleChange(callId)
        assertEquals("land", change["entityType"]!!.jsonPrimitive.content)
        assertEquals("L-IT-1", change["entityId"]!!.jsonPrimitive.content)
        assertEquals("update", change["operation"]!!.jsonPrimitive.content)
        assertTrue(change["fields"]!!.jsonObject.isEmpty(), "空 diff でもエントリ自体は記録する")
    }

    @Test
    fun `巨大な geometry の変更は全文ではなく要約形で記録される`() = withApp { client ->
        // 1000 文字 (AUDIT_MAX_VALUE_CHARS) を確実に超える頂点数のポリゴン (4326)
        val ring = (0 until 180).joinToString(",") { index ->
            val angle = 2.0 * Math.PI * index / 180
            "[${0.001 + 0.0005 * Math.cos(angle)},${0.001 + 0.0005 * Math.sin(angle)}]"
        }
        val geometry = """{"type":"Polygon","coordinates":[[$ring,[${0.001 + 0.0005},0.001]]]}"""
        val callId = "audit-geom-${System.nanoTime()}"
        assertEquals(
            HttpStatusCode.OK,
            client.patch("/api/layers/$parcelsLayerId/features/1") {
                header(HttpHeaders.Authorization, editorBearer)
                header(HttpHeaders.XRequestId, callId)
                contentType(ContentType.Application.Json)
                setBody("""{"geometry": $geometry}""")
            }.status
        )
        val change = singleChange(callId)
        assertEquals("feature", change["entityType"]!!.jsonPrimitive.content)
        assertEquals("$parcelsLayerId/1", change["entityId"]!!.jsonPrimitive.content)
        val fields = change["fields"]!!.jsonObject
        assertEquals(setOf("geometry"), fields.keys, "属性は変えていないので geometry のみ")
        val after = fields["geometry"]!!.jsonObject["after"]!!.jsonObject
        assertTrue(after["truncated"]!!.jsonPrimitive.boolean, "巨大な GeoJSON は要約形になる")
        assertTrue(after["sizeChars"]!!.jsonPrimitive.int > 1000)
        assertEquals(16, after["sha256"]!!.jsonPrimitive.content.length)
        // 変更前の小さな矩形はそのまま GeoJSON として残る
        val before = fields["geometry"]!!.jsonObject["before"]!!.jsonObject
        assertEquals("MultiPolygon", before["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `メンバーのロール変更は before-after で追跡できる`() = withApp { client ->
        val callId = "audit-member-${System.nanoTime()}"
        assertEquals(
            HttpStatusCode.OK,
            client.put("/api/projects/$defaultProject/members/$viewerUserId") {
                header(HttpHeaders.Authorization, adminBearer)
                header(HttpHeaders.XRequestId, callId)
                contentType(ContentType.Application.Json)
                setBody("""{"role": "editor"}""")
            }.status
        )
        val change = singleChange(callId)
        assertEquals("projectMember", change["entityType"]!!.jsonPrimitive.content)
        assertEquals("$defaultProject/$viewerUserId", change["entityId"]!!.jsonPrimitive.content)
        assertEquals("update", change["operation"]!!.jsonPrimitive.content)
        val role = change["fields"]!!.jsonObject["role"]!!.jsonObject
        assertEquals("viewer", role["before"]!!.jsonPrimitive.content)
        assertEquals("editor", role["after"]!!.jsonPrimitive.content)

        // 戻しておく (他テストへ影響させない)
        assertEquals(
            HttpStatusCode.OK,
            client.put("/api/projects/$defaultProject/members/$viewerUserId") {
                header(HttpHeaders.Authorization, adminBearer)
                contentType(ContentType.Application.Json)
                setBody("""{"role": "viewer"}""")
            }.status
        )
    }
}
