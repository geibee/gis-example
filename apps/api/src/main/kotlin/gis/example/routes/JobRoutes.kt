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
            CheckedInHandler(Action.IMPORT_EXECUTE, "multipart を保存しないと projectId を解決できず、拒否時は保存済みファイルの削除が必要")
        ) {
            Files.createDirectories(deps.uploadDir)
            var projectId: String? = null
            var format: String? = null
            var sourceSrid: Int? = null
            var layerRole: String? = null
            var filename: String? = null
            var uploadReference: String? = null

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
                        val original = sanitizeFileName(part.originalFileName ?: "upload.dat")
                        filename = original
                        // いったんローカルへステージングしてサイズ上限を検査してから保存先へ渡す
                        // (S3 でも上限超過分をバケットへ書かない)
                        val staging = deps.uploadDir.resolve("staging-${UUID.randomUUID()}.part")
                        uploadReference = withContext(Dispatchers.IO) {
                            writeUploadWithLimit(part, staging, deps.maxUploadBytes)
                            try {
                                deps.uploadStorage.store(staging, "${UUID.randomUUID()}-$original")
                            } finally {
                                Files.deleteIfExists(staging)
                            }
                        }
                    }
                    else -> Unit
                }
                part.dispose()
            }

            val actualFilename = filename ?: throw ApiException(HttpStatusCode.BadRequest, "File is required")
            val actualUploadReference = uploadReference
                ?: throw ApiException(HttpStatusCode.BadRequest, "File upload failed")
            val resolvedProjectId = projectId ?: db.defaultProjectId()
            try {
                call.requireProjectPermission(Action.IMPORT_EXECUTE, resolvedProjectId)
            } catch (exc: Exception) {
                withContext(Dispatchers.IO) { deps.uploadStorage.delete(actualUploadReference) }
                throw exc
            }
            val actualFormat = format ?: inferFormat(actualFilename)
            validateImportFormat(actualFormat)

            val job = db.createImportJob(
                projectId = resolvedProjectId,
                filename = actualFilename,
                format = actualFormat,
                sourceSrid = sourceSrid,
                uploadPath = actualUploadReference,
                layerRole = layerRole ?: "generic"
            )
            call.respond(HttpStatusCode.Created, job)
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
            call.respond(HttpStatusCode.Created, db.createAnalysisJob(request))
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
