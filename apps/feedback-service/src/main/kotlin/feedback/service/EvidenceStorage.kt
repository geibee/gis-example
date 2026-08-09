package feedback.service

import software.amazon.awssdk.core.ResponseInputStream
import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.GetObjectResponse
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request

data class EvidenceObjectRef(val objectKey: String, val lastModified: Instant)

interface EvidenceStorage : AutoCloseable {
    fun put(objectKey: String, contentType: String, bytes: ByteArray)
    fun get(objectKey: String): ByteArray
    fun delete(objectKey: String)
    fun list(prefix: String): List<EvidenceObjectRef>
    override fun close() = Unit
}

class LocalEvidenceStorage(private val root: Path) : EvidenceStorage {
    init {
        Files.createDirectories(root)
    }

    private fun resolve(objectKey: String): Path {
        val resolved = root.resolve(objectKey).normalize()
        require(resolved.startsWith(root.normalize())) { "不正な evidence object key です" }
        return resolved
    }

    override fun put(objectKey: String, contentType: String, bytes: ByteArray) {
        val target = resolve(objectKey)
        Files.createDirectories(target.parent)
        Files.write(target, bytes, StandardOpenOption.CREATE_NEW)
    }

    override fun get(objectKey: String): ByteArray = Files.readAllBytes(resolve(objectKey))

    override fun delete(objectKey: String) {
        Files.deleteIfExists(resolve(objectKey))
    }

    override fun list(prefix: String): List<EvidenceObjectRef> {
        val start = resolve(prefix)
        if (!Files.exists(start)) return emptyList()
        return Files.walk(start).use { paths ->
            paths.filter(Files::isRegularFile).map { path ->
                EvidenceObjectRef(
                    objectKey = root.normalize().relativize(path.normalize()).toString().replace('\\', '/'),
                    lastModified = Files.getLastModifiedTime(path).toInstant()
                )
            }.toList()
        }
    }
}

class S3EvidenceStorage(
    private val client: S3Client,
    private val bucket: String
) : EvidenceStorage {
    override fun put(objectKey: String, contentType: String, bytes: ByteArray) {
        client.putObject(
            { it.bucket(bucket).key(objectKey).contentType(contentType).contentLength(bytes.size.toLong()) },
            RequestBody.fromBytes(bytes)
        )
    }

    override fun get(objectKey: String): ByteArray {
        val response: ResponseInputStream<GetObjectResponse> =
            client.getObject { it.bucket(bucket).key(objectKey) }
        return response.use { it.readAllBytes() }
    }

    override fun delete(objectKey: String) {
        client.deleteObject { it.bucket(bucket).key(objectKey) }
    }

    override fun list(prefix: String): List<EvidenceObjectRef> =
        client.listObjectsV2Paginator(ListObjectsV2Request.builder().bucket(bucket).prefix(prefix).build())
            .contents()
            .map { EvidenceObjectRef(it.key(), it.lastModified()) }
            .toList()

    override fun close() = client.close()
}

fun createEvidenceStorage(settings: EvidenceStorageSettings): EvidenceStorage = createObjectStorage(
    mode = settings.mode,
    localDirectory = settings.localDirectory,
    bucket = settings.bucket,
    region = settings.region,
    endpointUrl = settings.endpointUrl,
    label = "evidence"
)

fun createExportStorage(settings: ExportStorageSettings): EvidenceStorage = createObjectStorage(
    mode = settings.mode,
    localDirectory = settings.localDirectory,
    bucket = settings.bucket,
    region = settings.region,
    endpointUrl = settings.endpointUrl,
    label = "export"
)

private fun createObjectStorage(
    mode: String,
    localDirectory: Path,
    bucket: String?,
    region: String?,
    endpointUrl: String?,
    label: String
): EvidenceStorage = when (mode) {
    "local" -> LocalEvidenceStorage(localDirectory)
    "s3" -> {
        val builder = S3Client.builder().forcePathStyle(endpointUrl != null)
        region?.let { builder.region(Region.of(it)) }
        endpointUrl?.let { builder.endpointOverride(URI(it)) }
        S3EvidenceStorage(builder.build(), requireNotNull(bucket))
    }
    else -> error("未対応の $label storage: $mode")
}
