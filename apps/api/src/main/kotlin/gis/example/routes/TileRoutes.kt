// ベクトルタイル配信ルート (openapi.yaml tag: tiles)
package gis.example.routes

import gis.example.Action
import gis.example.ApiException
import gis.example.ProjectResourceType
import gis.example.RouteAuthz.ResourceFromPath
import gis.example.TileJsonDto
import gis.example.VectorLayerDto
import gis.example.authorizedResourceId
import gis.example.authorizedRoutes
import gis.example.getLayer
import gis.example.getMvtTile
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route

fun Route.tileRoutes(deps: AppDependencies) {
    val db = deps.db

    authorizedRoutes(db) {
        get(
            "/api/tilejson/{layerId}",
            ResourceFromPath(Action.TILE_READ, ProjectResourceType.LAYER, param = "layerId", uuidLabel = "Layer id")
        ) {
            val id = call.authorizedResourceId()
            val layer = db.getLayer(id) ?: throw ApiException(HttpStatusCode.NotFound, "Layer not found")
            call.respond(
                TileJsonDto(
                    name = layer.name,
                    tiles = listOf("${deps.apiPublicUrl}/api/tiles/${layer.id}/{z}/{x}/{y}"),
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

        get(
            "/api/tiles/{layerId}/{z}/{x}/{y}",
            ResourceFromPath(Action.TILE_READ, ProjectResourceType.LAYER, param = "layerId", uuidLabel = "Layer id")
        ) {
            val layerId = call.authorizedResourceId()
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
