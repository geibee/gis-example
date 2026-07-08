// 取込・分析ジョブ系ルート (openapi.yaml tag: jobs)。
// 取込はアップロードを UploadStorage (local: uploadDir / s3: S3 バケット) へ保存して
// ジョブ登録のみ行い、変換は worker-gis が担う (S3 参照は s3:// URI として upload_path に残る)
package gis.example.routes

import gis.example.Action
import gis.example.AnalysisJobRequest
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.CheckedInHandler
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.createAnalysisJob
import gis.example.createImportJob
import gis.example.getAnalysisJob
import gis.example.getImportJob
import gis.example.requireProjectPermission
import gis.example.validateAnalysisRequest
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.request.receiveMultipart
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.utils.io.core.readAvailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

fun Route.jobRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        post(
            "/api/import-jobs",
            CheckedInHandler(Action.IMPORT_EXECUTE, "multipart を全て読まないと projectId を解決できないため、認可判定はステージング後にハンドラ内で行う")
        ) {
            Files.createDirectories(deps.uploadDir)
            var projectId: String? = null
            var format: String? = null
            var sourceSrid: Int? = null
            var layerRole: String? = null
            var filename: String? = null
            var stagingPath: Path? = null

            try {
                val multipart = call.receiveMultipart()
                multipart.forEachPart { part ->
                    when (part) {
                        is PartData.FormItem -> {
                            when (part.name) {
                                "projectId" -> projectId = optionalUuid(part.value, "projectId")
                                "format" -> format = part.value.takeIf { it.isNotBlank() }?.lowercase()
                                "sourceSrid" -> sourceSrid = part.value.takeIf { it.isNotBlank() }?.toIntOrNull()
                                "layerRole" -> layerRole = part.value.takeIf { it.isNotBlank() }?.lowercase()
                            }
                        }
                        is PartData.FileItem -> {
                            filename = sanitizeFileName(part.originalFileName ?: "upload.dat")
                            // ここではローカルへのステージングのみ行い、UploadStorage への保存は
                            // 認可・形式・実体 (マジックバイト) の検査がすべて通ってから行う
                            // (拒否したアップロードを S3 バケットへ書かない)
                            stagingPath?.let { withContext(Dispatchers.IO) { Files.deleteIfExists(it) } }
                            val staging = deps.uploadDir.resolve("staging-${UUID.randomUUID()}.part")
                            withContext(Dispatchers.IO) { writeUploadWithLimit(part, staging, deps.maxUploadBytes) }
                            stagingPath = staging
                        }
                        else -> Unit
                    }
                    part.dispose()
                }

                val actualFilename = filename ?: throw ApiException(HttpStatusCode.BadRequest, "File is required")
                val staging = stagingPath ?: throw ApiException(HttpStatusCode.BadRequest, "File upload failed")
                val resolvedProjectId = projectId ?: db.defaultProjectId()
                call.requireProjectPermission(Action.IMPORT_EXECUTE, resolvedProjectId)
                val actualFormat = format ?: inferFormat(actualFilename)
                validateImportFormat(actualFormat)
                // 宣言 format と実体の不一致 (geojson 宣言で zip 実体等) は保存前に 400 で拒否する
                val header = withContext(Dispatchers.IO) { readUploadHeader(staging) }
                validateUploadMatchesFormat(header, actualFormat)

                val uploadReference = withContext(Dispatchers.IO) {
                    deps.uploadStorage.store(staging, "${UUID.randomUUID()}-$actualFilename")
                }
                val job = try {
                    db.createImportJob(
                        projectId = resolvedProjectId,
                        filename = actualFilename,
                        format = actualFormat,
                        sourceSrid = sourceSrid,
                        uploadPath = uploadReference,
                        layerRole = layerRole ?: "generic"
                    )
                } catch (exc: Exception) {
                    // ジョブ登録に失敗した孤児アップロードを保存先に残さない
                    withContext(Dispatchers.IO) { deps.uploadStorage.delete(uploadReference) }
                    throw exc
                }
                // INSERT コミット後の起動通知 (sqs モードのみ実体あり)。送信失敗は
                // dispatcher 内で握りつぶされる — pending 行が正であり補完スキャンが回収する
                withContext(Dispatchers.IO) { deps.jobDispatcher.notifyImportJob(job.id) }
                call.respond(HttpStatusCode.Created, job)
            } finally {
                // 正常時は store() がステージングを消費済みのため no-op。拒否・失敗時の残骸だけ消す
                stagingPath?.let { withContext(Dispatchers.IO) { Files.deleteIfExists(it) } }
            }
        }

        get(
            "/api/import-jobs/{id}",
            ResourceFromPath(Action.JOB_READ, ProjectResourceType.IMPORT_JOB, uuidLabel = "Job id")
        ) {
            val id = call.authorizedResourceId()
            call.respond(db.getImportJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Import job not found"))
        }

        post(
            "/api/analysis-jobs",
            CheckedInHandler(Action.ANALYSIS_EXECUTE, "projectId 省略時に既定プロジェクトへフォールバックするためボディ解釈と認可判定が分離できない")
        ) {
            val request = call.receive<AnalysisJobRequest>()
            call.requireProjectPermission(Action.ANALYSIS_EXECUTE, request.projectId ?: db.defaultProjectId())
            validateAnalysisRequest(db, request)
            val job = db.createAnalysisJob(request)
            // INSERT コミット後の起動通知 (sqs モードのみ実体あり)。失敗しても補完スキャンが回収する
            withContext(Dispatchers.IO) { deps.jobDispatcher.notifyAnalysisJob(job.id) }
            call.respond(HttpStatusCode.Created, job)
        }

        get(
            "/api/analysis-jobs/{id}",
            ResourceFromPath(Action.JOB_READ, ProjectResourceType.ANALYSIS_JOB, uuidLabel = "Job id")
        ) {
            val id = call.authorizedResourceId()
            call.respond(db.getAnalysisJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Analysis job not found"))
        }
    }
}

// アップロードをストリーミングで書き出し、上限超過時は部分ファイルを消して 413 を返す
// (全量をメモリへ読まない)
private fun writeUploadWithLimit(part: PartData.FileItem, target: Path, maxBytes: Long) {
    try {
        val input = part.provider()
        Files.newOutputStream(target).use { output ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val read = input.readAvailable(buffer, 0, buffer.size)
                if (read <= 0) break
                total += read
                if (total > maxBytes) {
                    throw ApiException(HttpStatusCode.PayloadTooLarge, "Upload exceeds limit of $maxBytes bytes")
                }
                output.write(buffer, 0, read)
            }
        }
    } catch (exc: Exception) {
        Files.deleteIfExists(target)
        throw exc
    }
}

private fun sanitizeFileName(value: String): String {
    val cleaned = value.substringAfterLast('/').substringAfterLast('\\')
        .replace(Regex("[^A-Za-z0-9._-]"), "_")
    return cleaned.ifBlank { "upload.dat" }
}

private fun inferFormat(filename: String): String {
    val lower = filename.lowercase()
    return when {
        lower.endsWith(".zip") -> "shapefile"
        lower.endsWith(".geojson") || lower.endsWith(".json") -> "geojson"
        lower.endsWith(".gml") -> "gml"
        lower.endsWith(".kml") -> "kml"
        lower.endsWith(".gpx") -> "gpx"
        else -> throw ApiException(HttpStatusCode.BadRequest, "Cannot infer import format")
    }
}

private fun validateImportFormat(format: String) {
    if (format !in setOf("shapefile", "geojson", "gml", "kml", "gpx")) {
        throw ApiException(HttpStatusCode.BadRequest, "Unsupported import format: $format")
    }
}

// ------------------------------------------------------------------ 実体検査 (issue #19)
// 宣言 format と実体 (マジックバイト) の照合。UploadStorage への保存前に呼び、
// 不一致は 400 で拒否する。worker 側の GDAL ドライバ allowlist (-if) と対の多層防御

/** 実体判定に読む先頭バイト数 (BOM + 空白の読み飛ばしに十分な長さ) */
internal const val UPLOAD_HEADER_PROBE_BYTES = 512

internal fun readUploadHeader(path: Path): ByteArray =
    Files.newInputStream(path).use { it.readNBytes(UPLOAD_HEADER_PROBE_BYTES) }

internal fun validateUploadMatchesFormat(header: ByteArray, format: String) {
    val matches = when (format) {
        // shapefile は zip アーカイブ (PK\x03\x04) のみ。空 zip (PK\x05\x06) も実体なしとして拒否する
        "shapefile" -> hasZipMagic(header)
        // GeoJSON は JSON テキスト: UTF-8 BOM・空白を除いた先頭が '{' または '['
        "geojson" -> firstContentChar(header) in setOf('{', '[')
        // XML 系はタグ開始 '<' (zip 実体等はここで弾かれる)
        "gml", "kml", "gpx" -> firstContentChar(header) == '<'
        else -> true
    }
    if (!matches) {
        throw ApiException(HttpStatusCode.BadRequest, "Uploaded file content does not match declared format: $format")
    }
}

private fun hasZipMagic(header: ByteArray): Boolean =
    header.size >= 4 &&
        header[0] == 0x50.toByte() && header[1] == 0x4B.toByte() &&
        header[2] == 0x03.toByte() && header[3] == 0x04.toByte()

private fun firstContentChar(header: ByteArray): Char? {
    val hasBom = header.size >= 3 &&
        header[0] == 0xEF.toByte() && header[1] == 0xBB.toByte() && header[2] == 0xBF.toByte()
    var index = if (hasBom) 3 else 0
    while (index < header.size) {
        val char = header[index].toInt().toChar()
        if (!char.isWhitespace()) return char
        index++
    }
    return null
}
