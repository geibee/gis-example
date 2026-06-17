package gis.example

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.ContentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receive
import io.ktor.server.request.receiveMultipart
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.utils.io.core.readBytes
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID

fun main() {
    val port = (System.getenv("PORT") ?: "8080").toInt()
    embeddedServer(Netty, host = "0.0.0.0", port = port) {
        module()
    }.start(wait = true)
}

fun Application.module() {
    val db = Database.fromEnv()
    val uploadDir = Path.of(System.getenv("UPLOAD_DIR") ?: "/tmp/web-gis-uploads")
    val apiPublicUrl = (System.getenv("API_PUBLIC_URL") ?: "http://localhost:8080").trimEnd('/')
    val webOrigin = System.getenv("WEB_ORIGIN")

    environment.monitor.subscribe(ApplicationStopped) {
        db.close()
    }

    install(CallLogging)
    install(ContentNegotiation) {
        json(
            Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
                prettyPrint = true
            }
        )
    }
    install(CORS) {
        if (webOrigin.isNullOrBlank()) {
            anyHost()
        } else {
            allowHost(webOrigin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
        }
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Patch)
        allowMethod(HttpMethod.Options)
        allowHeader(HttpHeaders.ContentType)
    }
    install(StatusPages) {
        exception<ApiException> { call, cause ->
            call.respond(cause.status, ErrorResponse(cause.message))
        }
        exception<Throwable> { call, cause ->
            call.respond(HttpStatusCode.InternalServerError, ErrorResponse(cause.message ?: "Unexpected server error"))
        }
    }

    routing {
        get("/health") {
            call.respond(mapOf("status" to "ok"))
        }

        get("/api/projects") {
            call.respond(db.listProjects())
        }

        get("/api/layers") {
            call.respond(db.listLayers(call.request.queryParameters["projectId"]))
        }

        get("/api/layers/{id}/features/{featureId}") {
            val layerId = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required")
            val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            call.respond(db.getFeature(layerId, featureId))
        }

        patch("/api/layers/{id}/features/{featureId}") {
            val layerId = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required")
            val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            val request = call.receive<FeatureUpdateRequest>()
            call.respond(db.updateFeature(layerId, featureId, request))
        }

        post("/api/import-jobs") {
            Files.createDirectories(uploadDir)
            var projectId: String? = null
            var format: String? = null
            var sourceSrid: Int? = null
            var filename: String? = null
            var uploadPath: String? = null

            val multipart = call.receiveMultipart()
            multipart.forEachPart { part ->
                when (part) {
                    is PartData.FormItem -> {
                        when (part.name) {
                            "projectId" -> projectId = part.value.takeIf { it.isNotBlank() }
                            "format" -> format = part.value.takeIf { it.isNotBlank() }?.lowercase()
                            "sourceSrid" -> sourceSrid = part.value.takeIf { it.isNotBlank() }?.toIntOrNull()
                        }
                    }
                    is PartData.FileItem -> {
                        val original = sanitizeFileName(part.originalFileName ?: "upload.dat")
                        filename = original
                        val target = uploadDir.resolve("${UUID.randomUUID()}-$original")
                        withContext(Dispatchers.IO) {
                            Files.write(target, part.provider().readBytes())
                        }
                        uploadPath = target.toString()
                    }
                    else -> Unit
                }
                part.dispose()
            }

            val actualFilename = filename ?: throw ApiException(HttpStatusCode.BadRequest, "File is required")
            val actualUploadPath = uploadPath ?: throw ApiException(HttpStatusCode.BadRequest, "File upload failed")
            val actualFormat = format ?: inferFormat(actualFilename)
            validateImportFormat(actualFormat)

            val job = db.createImportJob(
                projectId = projectId,
                filename = actualFilename,
                format = actualFormat,
                sourceSrid = sourceSrid,
                uploadPath = actualUploadPath
            )
            call.respond(HttpStatusCode.Created, job)
        }

        get("/api/import-jobs/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Job id is required")
            call.respond(db.getImportJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Import job not found"))
        }

        post("/api/analysis-jobs") {
            val request = call.receive<AnalysisJobRequest>()
            validateAnalysisRequest(db, request)
            call.respond(HttpStatusCode.Created, db.createAnalysisJob(request))
        }

        get("/api/analysis-jobs/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Job id is required")
            call.respond(db.getAnalysisJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Analysis job not found"))
        }

        get("/api/tilejson/{layerId}") {
            val id = call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required")
            val layer = db.getLayer(id) ?: throw ApiException(HttpStatusCode.NotFound, "Layer not found")
            call.respond(
                TileJsonDto(
                    name = layer.name,
                    tiles = listOf("$apiPublicUrl/api/tiles/${layer.id}/{z}/{x}/{y}"),
                    vectorLayers = listOf(
                        VectorLayerDto(
                            id = layer.tileSourceId,
                            fields = layer.attributes.associate { it.name to it.dataType }
                        )
                    ),
                    bounds = layer.bbox4326
                )
            )
        }

        get("/api/tiles/{layerId}/{z}/{x}/{y}") {
            val layerId = call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required")
            val z = call.parameters["z"]?.toIntOrNull() ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid z")
            val x = call.parameters["x"]?.toIntOrNull() ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid x")
            val y = call.parameters["y"]?.toIntOrNull() ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid y")
            call.respondBytes(
                bytes = db.getMvtTile(layerId, z, x, y),
                contentType = ContentType.parse("application/vnd.mapbox-vector-tile")
            )
        }
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
