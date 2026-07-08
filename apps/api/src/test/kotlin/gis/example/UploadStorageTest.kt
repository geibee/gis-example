// UploadStorage の単体テスト (DB / AWS 不要)。
// LocalUploadStorage のラウンドトリップと、参照形式・env 選択の仕様を固定する。
// S3 実体 (MinIO) に対するラウンドトリップは S3UploadStorageMinioTest (env ゲート付き) を参照
package gis.example

import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class UploadStorageTest {

    @TempDir
    lateinit var tempDir: Path

    private fun staged(content: String): Path {
        val staging = tempDir.resolve("staging-${System.nanoTime()}.part")
        Files.writeString(staging, content)
        return staging
    }

    @Test
    fun `local storage round trip - store consumes staging and open reads back`() {
        val uploadDir = tempDir.resolve("uploads")
        val storage = LocalUploadStorage(uploadDir)
        val staging = staged("geojson-body")

        val reference = storage.store(staging, "abc-parcels.geojson")

        assertFalse(Files.exists(staging), "store はステージングファイルを消費する")
        assertEquals(uploadDir.resolve("abc-parcels.geojson").toAbsolutePath().toString(), reference)
        assertFalse(isS3Reference(reference))
        assertTrue(storage.exists(reference))
        assertEquals("geojson-body", storage.open(reference).use { String(it.readAllBytes()) })

        storage.delete(reference)
        assertFalse(storage.exists(reference))
        // 冪等: 既に無い参照の delete はエラーにしない (認可拒否時の後始末で二重呼び出しがあり得る)
        storage.delete(reference)
    }

    @Test
    fun `local storage rejects object names escaping the upload dir`() {
        val storage = LocalUploadStorage(tempDir.resolve("uploads"))
        val staging = staged("x")
        assertFailsWith<IllegalArgumentException> {
            storage.store(staging, "../escape.dat")
        }
    }

    @Test
    fun `s3 reference format is parsed into bucket and key`() {
        val (bucket, key) = S3UploadStorage.parseS3Reference("s3://gis-uploads/uploads/abc-a.zip")
        assertEquals("gis-uploads", bucket)
        assertEquals("uploads/abc-a.zip", key)

        assertTrue(isS3Reference("s3://gis-uploads/uploads/abc-a.zip"))
        assertFalse(isS3Reference("/data/uploads/abc-a.zip"))

        assertFailsWith<IllegalArgumentException> { S3UploadStorage.parseS3Reference("/data/uploads/a.zip") }
        assertFailsWith<IllegalArgumentException> { S3UploadStorage.parseS3Reference("s3://bucket-only") }
    }

    @Test
    fun `env factory defaults to local storage`() {
        val storage = uploadStorageFromEnv({ null }, tempDir)
        assertIs<LocalUploadStorage>(storage)
    }

    @Test
    fun `env factory treats blank values as unset`() {
        // compose は未設定の変数を空文字で渡すため、空白は「未設定」と同義に扱う
        val storage = uploadStorageFromEnv({ name -> if (name == "UPLOAD_STORAGE") "" else null }, tempDir)
        assertIs<LocalUploadStorage>(storage)
    }

    @Test
    fun `env factory requires a bucket for s3 mode`() {
        val env = mapOf("UPLOAD_STORAGE" to "s3")
        assertFailsWith<IllegalStateException> { uploadStorageFromEnv(env::get, tempDir) }
    }

    @Test
    fun `env factory rejects unknown storage mode`() {
        val env = mapOf("UPLOAD_STORAGE" to "efs")
        assertFailsWith<IllegalStateException> { uploadStorageFromEnv(env::get, tempDir) }
    }

    @Test
    fun `env factory builds s3 storage with endpoint override`() {
        val env = mapOf(
            "UPLOAD_STORAGE" to "s3",
            "S3_BUCKET" to "gis-uploads",
            "S3_REGION" to "ap-northeast-1",
            "S3_ENDPOINT_URL" to "http://localhost:9000"
        )
        uploadStorageFromEnv(env::get, tempDir).use { storage ->
            assertIs<S3UploadStorage>(storage)
        }
    }
}
