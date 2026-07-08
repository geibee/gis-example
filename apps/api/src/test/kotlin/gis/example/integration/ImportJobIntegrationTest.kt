package gis.example.integration

import gis.example.Database
import gis.example.module
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.TestInstance
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

// 取込アップロードの実体検査 (マジックバイト、issue #19) を HTTP 層で検証する:
// - 宣言 format と実体の不一致 (geojson 宣言で zip 実体等) は 400 で拒否され、ジョブは作られない
// - 一致するアップロードは従来どおり 201 でジョブが登録される
@Tag("integration")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ImportJobIntegrationTest {

    private val editorBearer = "Bearer ${OidcTestSupport.token("import-editor")}"
    private val geojsonBody = """{"type": "FeatureCollection", "features": []}"""

    private fun rawConnection(): Connection {
        val url = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
        val user = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
        val password = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"
        return DriverManager.getConnection(url, user, password)
    }

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
            // init.sql は拡張・スキーマ作成のみ。テーブル定義 + 既定プロジェクトは Flyway が適用する
            IntegrationDb.migrate()
            connection.createStatement().use { stmt ->
                stmt.execute(
                    """
                    INSERT INTO app.users (id, subject, email, system_role)
                    VALUES ('d0000000-0000-4000-8000-000000000001', 'import-editor', 'import-editor@gis.example', 'user');
                    INSERT INTO app.project_members (user_id, project_id, role)
                    VALUES ('d0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'editor');
                    """.trimIndent()
                )
            }
        }
    }

    private fun withApp(block: suspend (HttpClient) -> Unit) = testApplication {
        application { module(db = Database.fromEnv(), oidcSettings = OidcTestSupport.settings()) }
        block(client)
    }

    private fun zipBytes(entryName: String = "a.shp"): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry(entryName))
            zip.write(ByteArray(16))
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    private suspend fun postImport(
        client: HttpClient,
        filename: String,
        declaredFormat: String?,
        content: ByteArray
    ): HttpResponse = client.post("/api/import-jobs") {
        header(HttpHeaders.Authorization, editorBearer)
        setBody(
            MultiPartFormDataContent(
                formData {
                    if (declaredFormat != null) append("format", declaredFormat)
                    append(
                        "file",
                        content,
                        Headers.build { append(HttpHeaders.ContentDisposition, "filename=\"$filename\"") }
                    )
                }
            )
        )
    }

    private fun importJobCount(filename: String): Int = rawConnection().use { connection ->
        connection.prepareStatement("SELECT count(*) FROM app.import_jobs WHERE filename = ?").use { stmt ->
            stmt.setString(1, filename)
            stmt.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    @Test
    fun `geojson 宣言で zip 実体のアップロードは 400 でジョブも作られない`() = withApp { client ->
        val response = postImport(client, "disguised.geojson", "geojson", zipBytes())
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(
            response.bodyAsText().contains("does not match declared format"),
            "実体不一致の理由を返すはず: ${response.bodyAsText()}"
        )
        assertEquals(0, importJobCount("disguised.geojson"), "拒否時にジョブ行を残さない")
    }

    @Test
    fun `shapefile 宣言で JSON 実体のアップロードは 400 になる`() = withApp { client ->
        val response = postImport(client, "fake.zip", "shapefile", geojsonBody.toByteArray())
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, importJobCount("fake.zip"))
    }

    @Test
    fun `format 省略時も拡張子からの推定形式で実体検査される`() = withApp { client ->
        // .zip → shapefile と推定されるが実体は JSON
        val response = postImport(client, "inferred.zip", null, geojsonBody.toByteArray())
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, importJobCount("inferred.zip"))
    }

    @Test
    fun `宣言と実体が一致する geojson は 201 でジョブが登録される`() = withApp { client ->
        val response = postImport(client, "ok.geojson", "geojson", geojsonBody.toByteArray())
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        val job = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("geojson", job.getValue("format").jsonPrimitive.content)
        assertEquals("pending", job.getValue("status").jsonPrimitive.content)
        assertEquals(1, importJobCount("ok.geojson"))
    }

    @Test
    fun `宣言と実体が一致する shapefile zip は 201 でジョブが登録される`() = withApp { client ->
        val response = postImport(client, "ok.zip", "shapefile", zipBytes())
        assertEquals(HttpStatusCode.Created, response.status, response.bodyAsText())
        assertEquals(1, importJobCount("ok.zip"))
    }
}
