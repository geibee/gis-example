// S3 経路の実体ラウンドトリップテスト (使い捨て MinIO に対して put → get → delete)。
// CI の標準ジョブは MinIO を持たないため、環境変数で明示的に有効化されたときだけ実行する
// (未設定時は skipped として報告される。silent pass にはしない):
//
//   docker run -d --rm --name minio-test -p 9000:9000 \
//     -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio-secret \
//     quay.io/minio/minio server /data
//   UPLOAD_S3_TEST_ENDPOINT=http://localhost:9000 \
//   AWS_ACCESS_KEY_ID=minio AWS_SECRET_ACCESS_KEY=minio-secret \
//   gradle test --tests 'gis.example.S3UploadStorageMinioTest'
package gis.example

import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.junit.jupiter.api.io.TempDir
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@EnabledIfEnvironmentVariable(named = "UPLOAD_S3_TEST_ENDPOINT", matches = ".+")
class S3UploadStorageMinioTest {

    @TempDir
    lateinit var tempDir: Path

    private fun newClient(): S3Client = S3Client.builder()
        .region(Region.of(System.getenv("UPLOAD_S3_TEST_REGION") ?: "us-east-1"))
        .endpointOverride(URI.create(System.getenv("UPLOAD_S3_TEST_ENDPOINT")))
        .forcePathStyle(true)
        .build()

    @Test
    fun `s3 storage round trip against minio`() {
        val bucket = System.getenv("UPLOAD_S3_TEST_BUCKET") ?: "gis-uploads-test"
        newClient().use { client ->
            try {
                client.createBucket { it.bucket(bucket) }
            } catch (_: BucketAlreadyOwnedByYouException) {
                // 再実行時はバケットが残っていてよい
            }
            val storage = S3UploadStorage(client, bucket, "uploads/")

            val staging = tempDir.resolve("staging.part")
            Files.writeString(staging, "s3-roundtrip-body")

            // put: ステージングを消費して s3:// 参照を返す
            val reference = storage.store(staging, "test-parcels.geojson")
            assertFalse(Files.exists(staging), "store はステージングファイルを消費する")
            assertTrue(reference.startsWith("s3://$bucket/uploads/"), "参照は s3:// URI: $reference")

            // 存在確認 + get: worker-gis がダウンロードで読むのと同じ経路
            assertTrue(storage.exists(reference))
            assertEquals("s3-roundtrip-body", storage.open(reference).use { String(it.readAllBytes()) })

            // delete
            storage.delete(reference)
            assertFalse(storage.exists(reference))
        }
    }
}
