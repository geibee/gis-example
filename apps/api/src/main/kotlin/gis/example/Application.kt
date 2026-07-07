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
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.utils.io.core.readAvailable
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.request.httpMethod
import io.ktor.server.request.uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.slf4j.LoggerFactory
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

private val applicationLogger = LoggerFactory.getLogger("gis.example.Application")

fun main() {
    val port = (System.getenv("PORT") ?: "8080").toInt()
    embeddedServer(Netty, host = "0.0.0.0", port = port) {
        module()
    }.start(wait = true)
}

fun Application.module() {
    val db = Database.fromEnv()
    db.ensureBusinessSchema()
    val uploadDir = Path.of(System.getenv("UPLOAD_DIR") ?: "/tmp/web-gis-uploads")
    val apiPublicUrl = (System.getenv("API_PUBLIC_URL") ?: "http://localhost:8080").trimEnd('/')
    val webOrigin = System.getenv("WEB_ORIGIN")
    val maxUploadBytes = (System.getenv("UPLOAD_MAX_BYTES") ?: DEFAULT_MAX_UPLOAD_BYTES.toString()).toLong()

    val analysisJobRunner = AnalysisJobRunner(
        db = db,
        pollIntervalMillis = ((System.getenv("ANALYSIS_POLL_INTERVAL_SECONDS") ?: "2").toDouble() * 1000).toLong()
    )
    analysisJobRunner.start()

    environment.monitor.subscribe(ApplicationStopped) {
        analysisJobRunner.stop()
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
        // WEB_ORIGIN 未設定時に anyHost に開放しない (fail-open 防止)。ローカル開発既定のみ許可する
        val origin = webOrigin?.takeIf { it.isNotBlank() } ?: "http://localhost:5173"
        allowHost(origin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Patch)
        allowMethod(HttpMethod.Delete)
        allowMethod(HttpMethod.Options)
        allowHeader(HttpHeaders.ContentType)
    }
    install(StatusPages) {
        exception<ApiException> { call, cause ->
            call.respond(cause.status, ErrorResponse(cause.message))
        }
        exception<Throwable> { call, cause ->
            // 内部例外の詳細はログのみに残し、クライアントへは漏らさない
            applicationLogger.error("Unhandled error on {} {}", call.request.httpMethod.value, call.request.uri, cause)
            call.respond(HttpStatusCode.InternalServerError, ErrorResponse("Internal server error"))
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
            call.respond(db.listLayers(optionalUuid(call.request.queryParameters["projectId"], "projectId")))
        }

        get("/api/layers/{id}/attribute-values") {
            val layerId = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            val field = call.request.queryParameters["field"]
                ?: throw ApiException(HttpStatusCode.BadRequest, "Attribute field is required")
            val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 80
            call.respond(db.listAttributeValues(layerId, field, limit))
        }

        delete("/api/layers/{id}") {
            val id = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            db.deleteLayer(id)
            call.respond(HttpStatusCode.NoContent)
        }

        delete("/api/result-sets/{id}") {
            val id = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Result set id is required"),
                "Result set id"
            )
            db.deleteResultSet(id)
            call.respond(HttpStatusCode.NoContent)
        }

        get("/api/layers/{id}/features/{featureId}") {
            val layerId = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            call.respond(db.getFeature(layerId, featureId))
        }

        patch("/api/layers/{id}/features/{featureId}") {
            val layerId = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            val request = call.receive<FeatureUpdateRequest>()
            call.respond(db.updateFeature(layerId, featureId, request))
        }

        get("/api/features/search") {
            val params = call.request.queryParameters
            call.respond(
                db.searchFeatures(
                    projectId = optionalUuid(params["projectId"], "projectId"),
                    layerId = optionalUuid(params["layerId"], "layerId"),
                    q = params["q"],
                    field = params["field"],
                    operator = params["operator"],
                    value = params["value"],
                    linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                    limit = params["limit"]?.toIntOrNull() ?: 50
                )
            )
        }

        post("/api/features/business-spatial-search") {
            val request = call.receive<BusinessSpatialSearchRequest>()
            call.respond(db.searchBusinessSpatialFeatures(request))
        }

        post("/api/features/condition-search") {
            val request = call.receive<ConditionQueryDto>()
            call.respond(db.conditionSearchFeatures(request))
        }

        get("/api/features/{layerId}/{featureId}/business-links") {
            val layerId = requireUuid(
                call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            val featureId = call.parameters["featureId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Feature id is required")
            call.respond(db.getBusinessLinks(layerId, featureId))
        }

        get("/api/lands") {
            val params = call.request.queryParameters
            call.respond(
                db.listLands(
                    LandListQuery(
                        projectId = optionalUuid(params["projectId"], "projectId"),
                        q = params["q"],
                        status = params["status"],
                        landUse = params["landUse"],
                        partyType = params["partyType"],
                        relationType = params["relationType"],
                        linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                        sourceLayerId = optionalUuid(params["sourceLayerId"], "sourceLayerId"),
                        bbox = params["bbox"],
                        intersectsLayerId = optionalUuid(params["intersectsLayerId"], "intersectsLayerId"),
                        intersectsFeatureId = params["intersectsFeatureId"],
                        distanceMeters = params["distanceMeters"]?.toDoubleOrNull()
                    )
                )
            )
        }

        post("/api/lands") {
            call.respond(HttpStatusCode.Created, db.createLand(call.receive<JsonObject>()))
        }

        get("/api/lands/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
            call.respond(db.getLand(id) ?: throw ApiException(HttpStatusCode.NotFound, "Land not found"))
        }

        patch("/api/lands/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
            call.respond(db.updateLand(id, call.receive<JsonObject>()))
        }

        delete("/api/lands/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Land id is required")
            db.deleteLand(id)
            call.respond(HttpStatusCode.NoContent)
        }

        get("/api/buildings") {
            val params = call.request.queryParameters
            call.respond(
                db.listBuildings(
                    BuildingListQuery(
                        projectId = optionalUuid(params["projectId"], "projectId"),
                        q = params["q"],
                        landId = params["landId"],
                        status = params["status"],
                        buildingUse = params["buildingUse"],
                        partyType = params["partyType"],
                        relationType = params["relationType"],
                        linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                        sourceLayerId = optionalUuid(params["sourceLayerId"], "sourceLayerId"),
                        bbox = params["bbox"],
                        intersectsLayerId = optionalUuid(params["intersectsLayerId"], "intersectsLayerId"),
                        intersectsFeatureId = params["intersectsFeatureId"],
                        distanceMeters = params["distanceMeters"]?.toDoubleOrNull()
                    )
                )
            )
        }

        post("/api/buildings") {
            call.respond(HttpStatusCode.Created, db.createBuilding(call.receive<JsonObject>()))
        }

        get("/api/buildings/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
            call.respond(db.getBuilding(id) ?: throw ApiException(HttpStatusCode.NotFound, "Building not found"))
        }

        patch("/api/buildings/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
            call.respond(db.updateBuilding(id, call.receive<JsonObject>()))
        }

        delete("/api/buildings/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Building id is required")
            db.deleteBuilding(id)
            call.respond(HttpStatusCode.NoContent)
        }

        get("/api/parties") {
            val params = call.request.queryParameters
            call.respond(
                db.listParties(
                    PartyListQuery(
                        projectId = optionalUuid(params["projectId"], "projectId"),
                        q = params["q"],
                        partyType = params["partyType"],
                        relationType = params["relationType"],
                        linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                        targetType = params["targetType"]
                    )
                )
            )
        }

        post("/api/parties") {
            call.respond(HttpStatusCode.Created, db.createParty(call.receive<JsonObject>()))
        }

        get("/api/parties/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
            call.respond(db.getParty(id) ?: throw ApiException(HttpStatusCode.NotFound, "Party not found"))
        }

        patch("/api/parties/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
            call.respond(db.updateParty(id, call.receive<JsonObject>()))
        }

        delete("/api/parties/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Party id is required")
            db.deleteParty(id)
            call.respond(HttpStatusCode.NoContent)
        }

        get("/api/zones") {
            val params = call.request.queryParameters
            call.respond(
                db.listZones(
                    ZoneListQuery(
                        projectId = optionalUuid(params["projectId"], "projectId"),
                        q = params["q"],
                        status = params["status"],
                        zoneType = params["zoneType"],
                        linkedOnly = params["linkedOnly"]?.equals("true", ignoreCase = true) == true,
                        zoneLayerId = optionalUuid(params["zoneLayerId"], "zoneLayerId"),
                        sourceLayerId = params["sourceLayerId"]
                    )
                )
            )
        }

        post("/api/zones") {
            call.respond(HttpStatusCode.Created, db.createZone(call.receive<JsonObject>()))
        }

        get("/api/zones/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
            call.respond(db.getZone(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
        }

        get("/api/zones/{id}/party-summary") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
            call.respond(db.getZonePartySummary(id) ?: throw ApiException(HttpStatusCode.NotFound, "Zone not found"))
        }

        patch("/api/zones/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
            call.respond(db.updateZone(id, call.receive<JsonObject>()))
        }

        delete("/api/zones/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Zone id is required")
            db.deleteZone(id)
            call.respond(HttpStatusCode.NoContent)
        }

        post("/api/zone-layers/from-import") {
            call.respond(HttpStatusCode.Created, db.createZoneLayerFromImport(call.receive<ZoneLayerFromImportRequest>()))
        }

        post("/api/party-relationships") {
            call.respond(HttpStatusCode.Created, db.createPartyRelationship(call.receive<JsonObject>()))
        }

        patch("/api/party-relationships/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Relationship id is required")
            call.respond(db.updatePartyRelationship(id, call.receive<JsonObject>()))
        }

        delete("/api/party-relationships/{id}") {
            val id = call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Relationship id is required")
            db.deletePartyRelationship(id)
            call.respond(HttpStatusCode.NoContent)
        }

        post("/api/import-jobs") {
            Files.createDirectories(uploadDir)
            var projectId: String? = null
            var format: String? = null
            var sourceSrid: Int? = null
            var layerRole: String? = null
            var filename: String? = null
            var uploadPath: String? = null

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
                        val target = uploadDir.resolve("${UUID.randomUUID()}-$original")
                        withContext(Dispatchers.IO) {
                            writeUploadWithLimit(part, target, maxUploadBytes)
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
                uploadPath = actualUploadPath,
                layerRole = layerRole ?: "generic"
            )
            call.respond(HttpStatusCode.Created, job)
        }

        get("/api/import-jobs/{id}") {
            val id = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Job id is required"),
                "Job id"
            )
            call.respond(db.getImportJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Import job not found"))
        }

        post("/api/analysis-jobs") {
            val request = call.receive<AnalysisJobRequest>()
            validateAnalysisRequest(db, request)
            call.respond(HttpStatusCode.Created, db.createAnalysisJob(request))
        }

        get("/api/analysis-jobs/{id}") {
            val id = requireUuid(
                call.parameters["id"] ?: throw ApiException(HttpStatusCode.BadRequest, "Job id is required"),
                "Job id"
            )
            call.respond(db.getAnalysisJob(id) ?: throw ApiException(HttpStatusCode.NotFound, "Analysis job not found"))
        }

        get("/api/tilejson/{layerId}") {
            val id = requireUuid(
                call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
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
            val layerId = requireUuid(
                call.parameters["layerId"] ?: throw ApiException(HttpStatusCode.BadRequest, "Layer id is required"),
                "Layer id"
            )
            val z = call.parameters["z"]?.toIntOrNull()?.takeIf { it in 0..24 }
                ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid z")
            val tileExtent = 1 shl z
            val x = call.parameters["x"]?.toIntOrNull()?.takeIf { it in 0 until tileExtent }
                ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid x")
            val y = call.parameters["y"]?.toIntOrNull()?.takeIf { it in 0 until tileExtent }
                ?: throw ApiException(HttpStatusCode.BadRequest, "Invalid y")
            call.respondBytes(
                bytes = db.getMvtTile(layerId, z, x, y),
                contentType = ContentType.parse("application/vnd.mapbox-vector-tile")
            )
        }
    }
}

private const val DEFAULT_MAX_UPLOAD_BYTES = 200L * 1024 * 1024

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

private fun requireUuid(value: String, label: String): String =
    try {
        UUID.fromString(value).toString()
    } catch (_: IllegalArgumentException) {
        throw ApiException(HttpStatusCode.BadRequest, "$label must be a valid UUID")
    }

private fun optionalUuid(value: String?, label: String): String? =
    value?.takeIf { it.isNotBlank() }?.let { requireUuid(it, label) }

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
