import { type ComponentProps, type MutableRefObject, useEffect, useRef, useState } from "react";
import maplibregl, { type MapLayerMouseEvent, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getAccessToken } from "../auth";
import { baseStyle, defaultMapZoom, imperialPalaceCenter, layerColors } from "../constants";
import {
  addMapLayers,
  focusFeatureResults,
  focusGeometry,
  syncConditionSearchHighlight,
  syncMapLayerOrder
} from "../mapUtils";
import type { FeatureSearchResult, Layer } from "../types";
import type { MapPaneApi } from "../appTypes";
import { MapSupportPane } from "./MapSupportPane";

type SupportPaneProps = Omit<ComponentProps<typeof MapSupportPane>, "mapContainerRef">;

// maplibre-gl (と地図ヘルパー mapUtils) に依存するコードはすべてこのコンポーネントに閉じる。
// App からは React.lazy で遅延ロードされ、地図の操作は MapPaneApi (apiRef) 経由で受け付ける。
type MapPaneProps = SupportPaneProps & {
  apiRef: MutableRefObject<MapPaneApi | null>;
  onReadyChange: (ready: boolean) => void;
  layers: Layer[];
  mapHighlightResults: FeatureSearchResult[];
  layerById: Map<string, Layer>;
  onPickFeature: (layer: Layer, featureId: string) => void;
  onNotice: (message: string) => void;
};

export default function MapPane({
  apiRef,
  onReadyChange,
  layers,
  mapHighlightResults,
  layerById,
  onPickFeature,
  onNotice,
  ...supportPaneProps
}: MapPaneProps) {
  const { open, baseMapVisible, visibleLayerIds } = supportPaneProps;
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLayersByLayerId = useRef<Record<string, string[]>>({});
  const appLayerByStyleLayer = useRef<Record<string, string>>({});
  const initializedLayerBounds = useRef(false);
  const seenLayerIds = useRef<Set<string>>(new Set());
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    apiRef.current = {
      resize: () => mapRef.current?.resize(),
      focusGeometry: (geometry) => focusGeometry(mapRef.current, geometry),
      focusFeatureResults: (results) => focusFeatureResults(mapRef.current, results),
      getBoundsBbox: () => {
        const bounds = mapRef.current?.getBounds();
        if (!bounds) return null;
        return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
          .map((value) => value.toFixed(6))
          .join(",");
      },
      reloadLayerSource: (layerId) => {
        const source = mapRef.current?.getSource(layerId) as { reload?: () => void } | undefined;
        source?.reload?.();
      }
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    onReadyChange(mapReady);
  }, [mapReady, onReadyChange]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as maplibregl.StyleSpecification,
      center: imperialPalaceCenter,
      zoom: defaultMapZoom,
      attributionControl: { compact: true },
      // tilejson とタイル (/api/tiles) は MapLibre が直接取得するため、
      // ここでアクセストークンを付与する (API の認証必須化に対応)
      transformRequest: (url) => {
        if (url.includes("/api/")) {
          const token = getAccessToken();
          if (token) {
            return { url, headers: { Authorization: `Bearer ${token}` } };
          }
        }
        return { url };
      }
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.on("load", () => setMapReady(true));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      styleLayersByLayerId.current = {};
      appLayerByStyleLayer.current = {};
      initializedLayerBounds.current = false;
      seenLayerIds.current = new Set();
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    if (map.getLayer("osm")) {
      map.setLayoutProperty("osm", "visibility", baseMapVisible ? "visible" : "none");
    }
  }, [baseMapVisible, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const activeLayerIds = new Set(layers.map((layer) => layer.id));
    for (const [layerId, styleLayerIds] of Object.entries(styleLayersByLayerId.current)) {
      if (activeLayerIds.has(layerId)) continue;
      for (const styleLayerId of styleLayerIds) {
        if (map.getLayer(styleLayerId)) {
          map.removeLayer(styleLayerId);
        }
        delete appLayerByStyleLayer.current[styleLayerId];
      }
      if (map.getSource(layerId)) {
        map.removeSource(layerId);
      }
      delete styleLayersByLayerId.current[layerId];
      seenLayerIds.current.delete(layerId);
    }

    layers.forEach((layer, index) => {
      if (!map.getSource(layer.id)) {
        map.addSource(layer.id, {
          type: "vector",
          url: `/api/tilejson/${layer.id}`
        });
      }
      if (!styleLayersByLayerId.current[layer.id]) {
        const styleLayerIds = addMapLayers(map, layer, layerColors[index % layerColors.length]);
        styleLayersByLayerId.current[layer.id] = styleLayerIds;
        for (const styleLayerId of styleLayerIds) {
          appLayerByStyleLayer.current[styleLayerId] = layer.id;
        }
      }
      const visibility = visibleLayerIds.has(layer.id) ? "visible" : "none";
      for (const styleLayerId of styleLayersByLayerId.current[layer.id] ?? []) {
        if (map.getLayer(styleLayerId)) {
          map.setLayoutProperty(styleLayerId, "visibility", visibility);
        }
      }
    });
    syncMapLayerOrder(map, layers, styleLayersByLayerId.current);
    syncConditionSearchHighlight(map, mapHighlightResults);
  }, [layers, mapHighlightResults, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    syncConditionSearchHighlight(map, mapHighlightResults);
  }, [mapHighlightResults, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const visibleLayersWithBounds = layers.filter((layer) => visibleLayerIds.has(layer.id) && layer.bbox4326);
    if (!visibleLayersWithBounds.length) return;

    if (!initializedLayerBounds.current) {
      for (const layer of layers) {
        seenLayerIds.current.add(layer.id);
      }
      initializedLayerBounds.current = true;
      return;
    }

    const layerToFit = visibleLayersWithBounds.find((layer) => !seenLayerIds.current.has(layer.id));

    if (layerToFit?.bbox4326) {
      map.fitBounds(
        [
          [layerToFit.bbox4326[0], layerToFit.bbox4326[1]],
          [layerToFit.bbox4326[2], layerToFit.bbox4326[3]]
        ],
        { padding: 48, duration: 600, maxZoom: 16 }
      );
    }

    for (const layer of layers) {
      seenLayerIds.current.add(layer.id);
    }
  }, [layers, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const handleClick = (event: MapLayerMouseEvent) => {
      const queryLayerIds = Object.values(styleLayersByLayerId.current)
        .flat()
        .filter((id) => map.getLayer(id));
      if (!queryLayerIds.length) return;

      const features = map.queryRenderedFeatures(event.point, { layers: queryLayerIds });
      const rendered = features[0];
      if (!rendered) return;

      const layerId = appLayerByStyleLayer.current[rendered.layer.id];
      const layer = layerById.get(layerId);
      const featureId = rendered.properties?.[layer?.featureIdColumn ?? "fid"] ?? rendered.id;
      if (!layer || featureId === undefined || featureId === null || featureId === "") {
        onNotice("選択地物のIDを取得できませんでした");
        return;
      }
      onPickFeature(layer, String(featureId));
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [layerById, mapReady, onNotice, onPickFeature]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.resize(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  return <MapSupportPane mapContainerRef={mapContainerRef} {...supportPaneProps} />;
}
