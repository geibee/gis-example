// maplibre-gl に依存する地図ヘルパー。
// メインチャンクに maplibre を含めないため、純粋ヘルパー (utils.ts) から分離している。
// このモジュールは地図チャンク (components/MapPane.tsx) からのみ import すること。
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import type { FeatureSearchResult, Layer } from "./contracts";
import { extendBounds, geoJsonGeometryBounds, type GeometryBounds } from "./utils";

export function addMapLayers(map: MapLibreMap, layer: Layer, color: string): string[] {
  const sourceLayer = layer.tileSourceId;
  const source = layer.id;
  const geometryType = layer.geometryType.toUpperCase();
  const isZone = layer.layerRole === "zone";
  const ids: string[] = [];

  if (geometryType.includes("POLYGON") || geometryType === "GEOMETRY") {
    const fillId = `${layer.id}-fill`;
    const outlineId = `${layer.id}-outline`;
    map.addLayer({
      id: fillId,
      type: "fill",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": isZone ? "#38bdf8" : color, "fill-opacity": isZone ? 0.18 : 0.32 }
    } as maplibregl.FillLayerSpecification);
    map.addLayer({
      id: outlineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "line-color": isZone ? "#0369a1" : color, "line-width": isZone ? 2.2 : 1.2 }
    } as maplibregl.LineLayerSpecification);
    ids.push(fillId, outlineId);
  }

  if (geometryType.includes("LINE") || geometryType === "GEOMETRY") {
    const lineId = `${layer.id}-line`;
    map.addLayer({
      id: lineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "LineString"],
      paint: { "line-color": color, "line-width": 2.2 }
    } as maplibregl.LineLayerSpecification);
    ids.push(lineId);
  }

  if (geometryType.includes("POINT") || geometryType === "GEOMETRY") {
    const pointId = `${layer.id}-point`;
    map.addLayer({
      id: pointId,
      type: "circle",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5
      }
    } as maplibregl.CircleLayerSpecification);
    ids.push(pointId);
  }

  return ids;
}

export function syncConditionSearchHighlight(map: MapLibreMap, results: FeatureSearchResult[]) {
  const sourceId = "condition-search-highlight";
  const emptyCollection = { type: "FeatureCollection", features: [] } as any;
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "geojson",
      data: emptyCollection
    });
  }
  if (!map.getLayer(`${sourceId}-fill`)) {
    map.addLayer({
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": "#facc15", "fill-opacity": 0.5 }
    } as maplibregl.FillLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-line-halo`)) {
    map.addLayer({
      id: `${sourceId}-line-halo`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.95,
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 7, 12, 9, 16, 12]
      }
    } as maplibregl.LineLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-line`)) {
    map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#e11d48",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 6, 16, 8]
      }
    } as maplibregl.LineLayerSpecification);
  }
  if (!map.getLayer(`${sourceId}-point`)) {
    map.addLayer({
      id: `${sourceId}-point`,
      type: "circle",
      source: sourceId,
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-color": "#e11d48",
        "circle-radius": 7,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2
      }
    } as maplibregl.CircleLayerSpecification);
  }

  const features = results
    .filter((result) => result.geometry)
    .map((result) => ({
      type: "Feature",
      geometry: result.geometry,
      properties: {
        layerId: result.layerId,
        featureId: result.featureId
      }
    }));
  const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  source?.setData({ type: "FeatureCollection", features } as any);
  [
    `${sourceId}-fill`,
    `${sourceId}-line-halo`,
    `${sourceId}-line`,
    `${sourceId}-point`
  ].forEach((layerId) => {
    if (map.getLayer(layerId)) map.moveLayer(layerId);
  });
}

export function syncMapLayerOrder(
  map: MapLibreMap,
  layers: Layer[],
  styleLayerIdsByLayerId: Record<string, string[]>
) {
  for (const layer of [...layers].reverse()) {
    for (const styleLayerId of styleLayerIdsByLayerId[layer.id] ?? []) {
      if (map.getLayer(styleLayerId)) {
        map.moveLayer(styleLayerId);
      }
    }
  }
}

export function focusGeometry(map: MapLibreMap | null, geometry: unknown) {
  if (!map) return;
  const bounds = geoJsonGeometryBounds(geometry);
  if (!bounds) return;
  const southWest: [number, number] = [bounds.minLng, bounds.minLat];
  const northEast: [number, number] = [bounds.maxLng, bounds.maxLat];
  if (bounds.minLng === bounds.maxLng && bounds.minLat === bounds.maxLat) {
    map.flyTo({ center: southWest, zoom: Math.max(map.getZoom(), 16), duration: 500 });
    return;
  }
  map.fitBounds([southWest, northEast], { padding: 72, duration: 500, maxZoom: 17 });
}

export function focusFeatureResults(map: MapLibreMap | null, results: FeatureSearchResult[]) {
  if (!map) return;
  const bounds: GeometryBounds = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY
  };
  for (const result of results) {
    const geometryBounds = geoJsonGeometryBounds(result.geometry);
    if (!geometryBounds) continue;
    extendBounds(bounds, geometryBounds.minLng, geometryBounds.minLat);
    extendBounds(bounds, geometryBounds.maxLng, geometryBounds.maxLat);
  }
  if (!Number.isFinite(bounds.minLng) || !Number.isFinite(bounds.minLat)) return;
  const southWest: [number, number] = [bounds.minLng, bounds.minLat];
  const northEast: [number, number] = [bounds.maxLng, bounds.maxLat];
  if (bounds.minLng === bounds.maxLng && bounds.minLat === bounds.maxLat) {
    map.flyTo({ center: southWest, zoom: Math.max(map.getZoom(), 16), duration: 500 });
    return;
  }
  map.fitBounds([southWest, northEast], { padding: 72, duration: 500, maxZoom: 17 });
}
