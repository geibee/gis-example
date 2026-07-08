// 取込アップロードの保存先抽象。ECS Fargate ではタスクのローカル FS が揮発するため、
// 本番は S3、ローカル開発は従来どおりのローカルディレクトリ (または MinIO) を使う。
//
// ジョブ行 (app.import_jobs.upload_path) に記録する「参照」は自己記述的な文字列 1 本で表す:
//   - ローカル: 絶対パス (例: /data/uploads/xxx-a.zip)
//   - S3:       s3://<bucket>/<key>
// worker-gis はこの参照のプレフィックスで読み方を切り替えるため、スキーマ変更は不要。
package gis.example

import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.io.InputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/** S3 参照 (s3://bucket/key) かどうか。worker-gis 側 (worker.py の is_s3_uri) と対で保つ */
fun isS3Reference(reference: String): Boolean = reference.startsWith("s3://")

interface UploadStorage : AutoCloseable {
    /**
     * ステージング済みのローカルファイル [source] を [objectName] として保存し、
     * ジョブ行へ記録する参照を返す。呼び出しが成功すると [source] は消費される (残らない)
     */
    fun store(source: Path, objectName: String): String

    /** 参照が指すアップロードを読み出す (呼び出し側が close する) */
    fun open(reference: String): InputStream

    fun exists(reference: String): Boolean

    /** 参照が指すアップロードを削除する (存在しなくてもエラーにしない) */
    fun delete(reference: String)

    override fun close() {}
}

/** 従来動作: uploadDir 配下へ保存し、絶対パスを参照として返す (dev / 単一ホスト向け) */
class LocalUploadStorage(private val uploadDir: Path) : UploadStorage {
    override fun store(source: Path, objectName: String): String {
        Files.createDirectories(uploadDir)
        val target = uploadDir.resolve(objectName)
        require(target.normalize().startsWith(uploadDir.normalize())) { "objectName escapes uploadDir: $objectName" }
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING)
        }
        return target.toAbsolutePath().toString()
    }

    override fun open(reference: String): InputStream = Files.newInputStream(Path.of(reference))

    override fun exists(reference: String): Boolean = Files.exists(Path.of(reference))

    override fun delete(reference: String) {
        Files.deleteIfExists(Path.of(reference))
    }
}

/**
 * S3 (または MinIO 等の S3 互換エンドポイント) へ保存する。
 * 認証は AWS SDK の既定チェーン (本番: ECS タスクロール / dev: AWS_ACCESS_KEY_ID 等の環境変数)
 */
class S3UploadStorage(
    private val client: S3Client,
    private val bucket: String,
    private val keyPrefix: String
) : UploadStorage {
    override fun store(source: Path, objectName: String): String {
        val key = "$keyPrefix$objectName"
        client.putObject({ it.bucket(bucket).key(key) }, RequestBody.fromFile(source))
        Files.deleteIfExists(source)
        return "s3://$bucket/$key"
    }

    override fun open(reference: String): InputStream {
        val (refBucket, key) = parseS3Reference(reference)
        return client.getObject { it.bucket(refBucket).key(key) }
    }

    override fun exists(reference: String): Boolean {
        val (refBucket, key) = parseS3Reference(reference)
        return try {
            client.headObject { it.bucket(refBucket).key(key) }
            true
        } catch (_: NoSuchKeyException) {
            false
        }
    }

    override fun delete(reference: String) {
        val (refBucket, key) = parseS3Reference(reference)
        client.deleteObject { it.bucket(refBucket).key(key) }
    }

    override fun close() {
        client.close()
    }

    companion object {
        /** `s3://bucket/key` を (bucket, key) に分解する */
        fun parseS3Reference(reference: String): Pair<String, String> {
            require(isS3Reference(reference)) { "Not an s3:// reference: $reference" }
            val withoutScheme = reference.removePrefix("s3://")
            val bucket = withoutScheme.substringBefore('/')
            val key = withoutScheme.substringAfter('/', missingDelimiterValue = "")
            require(bucket.isNotBlank() && key.isNotBlank()) { "Malformed s3:// reference: $reference" }
            return bucket to key
        }
    }
}

/**
 * 環境変数からストレージ実装を選択する。
 *   UPLOAD_STORAGE   local (既定) | s3
 *   S3_BUCKET        s3 選択時は必須
 *   S3_REGION        任意 (未設定時は SDK 既定チェーン: AWS_REGION / タスクメタデータ)
 *   S3_ENDPOINT_URL  任意 (MinIO 等の dev 用。指定時は path-style アクセスに切替)
 *   S3_KEY_PREFIX    任意 (既定 uploads/)
 * [env] を注入可能にしてあるのは単体テストのため (System.getenv を直接読まない)
 */
fun uploadStorageFromEnv(env: (String) -> String?, uploadDir: Path): UploadStorage {
    fun value(name: String): String? = env(name)?.takeIf { it.isNotBlank() }
    return when (val mode = value("UPLOAD_STORAGE")?.lowercase() ?: "local") {
        "local" -> LocalUploadStorage(uploadDir)
        "s3" -> {
            val bucket = value("S3_BUCKET")
                ?: error("UPLOAD_STORAGE=s3 には S3_BUCKET が必要です (fail-closed: 保存先不明のまま起動しない)")
            val builder = S3Client.builder()
            value("S3_REGION")?.let { builder.region(Region.of(it)) }
            value("S3_ENDPOINT_URL")?.let {
                // MinIO 等はバケット名のサブドメイン解決ができないため path-style を強制する
                builder.endpointOverride(URI.create(it)).forcePathStyle(true)
            }
            val prefix = (value("S3_KEY_PREFIX") ?: "uploads/").let { if (it.endsWith('/')) it else "$it/" }
            S3UploadStorage(builder.build(), bucket, prefix)
        }
        else -> error("不明な UPLOAD_STORAGE: $mode (local | s3)")
    }
}
