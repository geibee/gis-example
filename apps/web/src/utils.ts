import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { getBuilding, getLand } from "./api";
import type {
  AttributeConditionDraft,
  Building,
  BusinessLinks,
  BusinessObjectFilters,
  ConditionQuery,
  ConditionQueryCondition,
  Feature,
  FeatureSearchResult,
  Land,
  Layer,
  Party,
  PartyRelationship,
  Zone
} from "./types";
import type {
  BuildingDraft,
  BusinessListSearchCriteria,
  BusinessMapTarget,
  BusinessMapTargetContext,
  BusinessTab,
  LandDraft,
  LayerListItem,
  LayerViewState,
  PartyDraft,
  RouteSelection,
  ZoneDraft,
  ZoneLayerCreateMetadata
} from "./appTypes";
import {
  businessMapHighlightLimit,
  emptyBusinessLinks,
  layerViewStateStoragePrefix,
  relationTypeOptions
} from "./constants";

export function emptyBusinessListSearchCriteria(): BusinessListSearchCriteria {
  return { query: "", filters: {} };
}

export function toBusinessListSearchCriteria(query: string, filters: BusinessObjectFilters): BusinessListSearchCriteria {
  return { query: query.trim(), filters: { ...filters } };
}

export function normalizeZoneLayerFilter(filters: BusinessObjectFilters, zoneLayers: Layer[]): BusinessObjectFilters {
  const selectedLayerId = filters.zoneLayerId?.trim();
  if (selectedLayerId && zoneLayers.some((layer) => layer.id === selectedLayerId)) {
    return filters;
  }
  if (zoneLayers[0]) {
    if (filters.zoneLayerId === zoneLayers[0].id) return filters;
    return { ...filters, zoneLayerId: zoneLayers[0].id };
  }
  if (!selectedLayerId) return filters;
  const nextFilters = { ...filters };
  delete nextFilters.zoneLayerId;
  return nextFilters;
}

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

export function toAttributePayload(condition: AttributeConditionDraft) {
  if (condition.operator === "IS NULL") {
    return {
      layerId: condition.layerId,
      field: condition.field,
      operator: condition.operator
    };
  }
  if (condition.operator === "IN") {
    return {
      layerId: condition.layerId,
      field: condition.field,
      operator: condition.operator,
      values: condition.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    };
  }
  return {
    layerId: condition.layerId,
    field: condition.field,
    operator: condition.operator,
    value: parseDraftValue(condition.value)
  };
}

export function toConditionAttributePayload(condition: AttributeConditionDraft): ConditionQueryCondition {
  const payload = toAttributePayload(condition);
  return {
    type: "attribute",
    ...payload
  };
}

export function conditionResultName(name: string, query: ConditionQuery): string {
  const explicitName = name.trim();
  if (explicitName) return explicitName;
  const keyword = query.keyword?.trim();
  return keyword ? `条件検索結果: ${keyword}` : "条件検索結果";
}

export function readZoneDistance(operator: string, value: string): number | undefined {
  if (operator !== "dwithin") return undefined;
  const distance = Number(value.trim());
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error("指定距離は正の数値で入力してください");
  }
  return distance;
}

export function parseDraftValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

export function parseEditedProperty(value: string, originalValue: unknown, fieldName: string): unknown {
  const trimmed = value.trim();
  if (originalValue === null || originalValue === undefined) {
    return trimmed ? parseDraftValue(value) : null;
  }
  if (typeof originalValue === "number") {
    if (!trimmed) return null;
    const next = Number(trimmed);
    if (!Number.isFinite(next)) throw new Error(`${fieldName} は数値で入力してください`);
    return next;
  }
  if (typeof originalValue === "boolean") {
    if (trimmed.toLowerCase() === "true") return true;
    if (trimmed.toLowerCase() === "false") return false;
    throw new Error(`${fieldName} は true または false で入力してください`);
  }
  if (typeof originalValue === "object") {
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  }
  return value;
}

export function moveLayerBefore(layers: Layer[], sourceLayerId: string, targetLayerId: string): Layer[] {
  const sourceIndex = layers.findIndex((layer) => layer.id === sourceLayerId);
  const targetIndex = layers.findIndex((layer) => layer.id === targetLayerId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layers;

  const next = [...layers];
  const [sourceLayer] = next.splice(sourceIndex, 1);
  const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(insertIndex, 0, sourceLayer);
  return next;
}

export function orderLayers(layers: Layer[], layerOrder: string[] | undefined): Layer[] {
  if (!layerOrder?.length) return layers;
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const orderedLayers: Layer[] = [];
  const usedLayerIds = new Set<string>();

  for (const layerId of layerOrder) {
    const layer = layerById.get(layerId);
    if (!layer) continue;
    orderedLayers.push(layer);
    usedLayerIds.add(layerId);
  }

  return [...orderedLayers, ...layers.filter((layer) => !usedLayerIds.has(layer.id))];
}

export function groupLayerListItems(layers: Layer[]): LayerListItem[] {
  const items: LayerListItem[] = [];
  const resultSetItems = new Map<string, Extract<LayerListItem, { type: "resultSet" }>>();
  for (const layer of layers) {
    if (layer.resultSetId) {
      const existing = resultSetItems.get(layer.resultSetId);
      if (existing) {
        existing.layers.push(layer);
      } else {
        const item: Extract<LayerListItem, { type: "resultSet" }> = {
          type: "resultSet",
          id: layer.resultSetId,
          name: layer.resultSetName ?? "条件検索結果",
          layers: [layer]
        };
        resultSetItems.set(layer.resultSetId, item);
        items.push(item);
      }
      continue;
    }
    items.push({ type: "layer", layer });
  }
  return items;
}

export function restoreVisibleLayerIds(
  layers: Layer[],
  savedViewState: Partial<LayerViewState> | null,
  previousLayerIds: Set<string>,
  currentVisibleLayerIds: Set<string>
): Set<string> {
  if (savedViewState?.visibleLayerIds) {
    const savedVisibleLayerIds = new Set(savedViewState.visibleLayerIds);
    const savedKnownLayerIds = new Set(savedViewState.layerOrder ?? []);
    return new Set(
      layers
        .filter((layer) => savedVisibleLayerIds.has(layer.id) || !savedKnownLayerIds.has(layer.id))
        .map((layer) => layer.id)
    );
  }

  if (previousLayerIds.size || currentVisibleLayerIds.size) {
    const next = new Set(layers.filter((layer) => currentVisibleLayerIds.has(layer.id)).map((layer) => layer.id));
    for (const layer of layers) {
      if (!previousLayerIds.has(layer.id)) next.add(layer.id);
    }
    return next;
  }

  return new Set(layers.map((layer) => layer.id));
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

export function readLayerViewState(projectId: string): Partial<LayerViewState> | null {
  try {
    const rawState = window.localStorage.getItem(layerViewStateStoragePrefix + projectId);
    if (!rawState) return null;
    const parsed = JSON.parse(rawState) as Partial<LayerViewState>;
    return {
      baseMapVisible: typeof parsed.baseMapVisible === "boolean" ? parsed.baseMapVisible : undefined,
      visibleLayerIds: Array.isArray(parsed.visibleLayerIds) ? parsed.visibleLayerIds.filter(isString) : undefined,
      layerOrder: Array.isArray(parsed.layerOrder) ? parsed.layerOrder.filter(isString) : undefined
    };
  } catch {
    return null;
  }
}

export function writeLayerViewState(projectId: string, state: LayerViewState) {
  try {
    window.localStorage.setItem(layerViewStateStoragePrefix + projectId, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in private or restricted browser contexts.
  }
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatArea(value?: number | null): string {
  return value === null || value === undefined ? "" : value.toLocaleString();
}

export function relationshipSummary(relationships: PartyRelationship[]): string {
  if (!relationships.length) return "";
  return relationships
    .slice(0, 2)
    .map((relationship) => `${relationship.relationType}:${relationship.partyName ?? relationship.partyId}`)
    .join(" / ");
}

export function gisLinkSummary(layerId?: string | null, featureId?: string | null): string {
  return layerId && featureId ? "あり" : "";
}

export function zoneLayerSummary(layers: Layer[], layerId?: string | null, featureId?: string | null): string {
  if (!layerId || !featureId) return "";
  const layer = layers.find((item) => item.id === layerId);
  return `${layer?.name ?? "区域レイヤ"} · ID ${featureId}`;
}

export function zoneLayerIdOf(zone: Zone): string {
  return zone.zoneLayerId ?? zone.sourceLayerId ?? "";
}

export function zoneFeatureIdOf(zone: Zone): string {
  return zone.zoneFeatureId ?? zone.sourceFeatureId ?? "";
}

export async function buildBusinessMapTargets({
  tab,
  zones,
  lands,
  buildings,
  parties,
  layerById
}: BusinessMapTargetContext): Promise<BusinessMapTarget[]> {
  if (tab === "zone") {
    const includeContained = zones.length === 1;
    const groups = await Promise.all(zones.map((zone) => zoneToBusinessMapTargets(zone, layerById, includeContained)));
    return groups.flat();
  }
  if (tab === "lands") {
    return lands.flatMap((land) => landToBusinessMapTarget(land, layerById) ?? []);
  }
  if (tab === "buildings") {
    return buildings.flatMap((building) => buildingToBusinessMapTarget(building, layerById) ?? []);
  }
  return partyBusinessMapTargets(parties, lands, buildings, layerById);
}

export async function zoneToBusinessMapTargets(zone: Zone, layerById: Map<string, Layer>, includeContained: boolean): Promise<BusinessMapTarget[]> {
  const zoneLayerId = zoneLayerIdOf(zone);
  const zoneFeatureId = zoneFeatureIdOf(zone);
  if (!zoneLayerId || !zoneFeatureId) return [];
  const targets: BusinessMapTarget[] = [{
    layerId: zoneLayerId,
    layerName: sourceLayerName(layerById, zoneLayerId, "区域"),
    featureId: zoneFeatureId,
    matchSummary: `区域 ${zone.id} · ${zone.name}`,
    businessLinks: {
      lands: zone.lands ?? [],
      buildings: zone.buildings ?? []
    },
    matchedBusinessLinks: emptyBusinessLinks
  }];
  if (!includeContained) return targets;

  const landTargets = await Promise.all(
    (zone.lands ?? []).map(async (link) => {
      const land = await getLandForMap(link.id);
      return land ? landToBusinessMapTarget(land, layerById, "区域内の土地", { lands: [link], buildings: [] }) : null;
    })
  );
  const buildingTargets = await Promise.all(
    (zone.buildings ?? []).map(async (link) => {
      const building = await getBuildingForMap(link.id);
      return building ? buildingToBusinessMapTarget(building, layerById, "区域内の建物", { lands: [], buildings: [link] }) : null;
    })
  );
  return [...targets, ...landTargets, ...buildingTargets].filter((target): target is BusinessMapTarget => Boolean(target));
}

export function landToBusinessMapTarget(
  land: Land,
  layerById: Map<string, Layer>,
  matchSummary = `土地 ${land.id} · ${landMapLabel(land)}`,
  matchedBusinessLinks?: BusinessLinks
): BusinessMapTarget | null {
  if (!land.sourceLayerId || !land.sourceFeatureId) return null;
  const landLink = { id: land.id, label: landMapLabel(land) };
  return {
    layerId: land.sourceLayerId,
    layerName: sourceLayerName(layerById, land.sourceLayerId, "土地"),
    featureId: land.sourceFeatureId,
    matchSummary,
    businessLinks: {
      lands: [landLink],
      buildings: land.buildings
    },
    matchedBusinessLinks: matchedBusinessLinks ?? {
      lands: [landLink],
      buildings: []
    }
  };
}

export function buildingToBusinessMapTarget(
  building: Building,
  layerById: Map<string, Layer>,
  matchSummary = `建物 ${building.id} · ${buildingMapLabel(building)}`,
  matchedBusinessLinks?: BusinessLinks
): BusinessMapTarget | null {
  if (!building.sourceLayerId || !building.sourceFeatureId) return null;
  const buildingLink = { id: building.id, label: buildingMapLabel(building) };
  return {
    layerId: building.sourceLayerId,
    layerName: sourceLayerName(layerById, building.sourceLayerId, "建物"),
    featureId: building.sourceFeatureId,
    matchSummary,
    businessLinks: {
      lands: building.landId ? [{ id: building.landId, label: building.landLabel ?? building.landId }] : [],
      buildings: [buildingLink]
    },
    matchedBusinessLinks: matchedBusinessLinks ?? {
      lands: [],
      buildings: [buildingLink]
    }
  };
}

export async function partyBusinessMapTargets(
  parties: Party[],
  lands: Land[],
  buildings: Building[],
  layerById: Map<string, Layer>
): Promise<BusinessMapTarget[]> {
  const landById = new Map(lands.map((land) => [land.id, land]));
  const buildingById = new Map(buildings.map((building) => [building.id, building]));
  const relationships = parties
    .flatMap((party) => party.relationships.map((relationship) => ({ party, relationship })))
    .slice(0, businessMapHighlightLimit * 2);
  const targets = await Promise.all(
    relationships.map(async ({ party, relationship }) => {
      const matchSummary = `${party.name} · ${relationship.relationType}`;
      if (relationship.targetType === "land") {
        const land = landById.get(relationship.targetId) ?? (await getLandForMap(relationship.targetId));
        if (!land) return null;
        return landToBusinessMapTarget(land, layerById, matchSummary, {
          lands: [{ id: land.id, label: relationship.targetLabel ?? landMapLabel(land) }],
          buildings: []
        });
      }
      const building = buildingById.get(relationship.targetId) ?? (await getBuildingForMap(relationship.targetId));
      if (!building) return null;
      return buildingToBusinessMapTarget(building, layerById, matchSummary, {
        lands: [],
        buildings: [{ id: building.id, label: relationship.targetLabel ?? buildingMapLabel(building) }]
      });
    })
  );
  return targets.filter((target): target is BusinessMapTarget => Boolean(target));
}

export async function getLandForMap(id: string): Promise<Land | null> {
  try {
    return await getLand(id);
  } catch {
    return null;
  }
}

export async function getBuildingForMap(id: string): Promise<Building | null> {
  try {
    return await getBuilding(id);
  } catch {
    return null;
  }
}

export function uniqueBusinessMapTargets(targets: BusinessMapTarget[]): BusinessMapTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.layerId}:${target.featureId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sourceLayerName(layerById: Map<string, Layer>, layerId: string, fallback: string): string {
  return layerById.get(layerId)?.name ?? fallback;
}

export function landMapLabel(land: Land): string {
  return [land.lotNumber, land.address].filter(Boolean).join(" · ") || land.id;
}

export function buildingMapLabel(building: Building): string {
  return building.name || building.houseNumber || building.buildingLocation || building.id;
}

export function featureResultSummary(result: FeatureSearchResult): string {
  const entries = Object.entries(result.properties)
    .filter(([, value]) => value !== null && value !== undefined && formatValue(value) !== "")
    .slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join(" · ") || "属性なし";
}

export function businessLinksSummary(links: BusinessLinks): string {
  const parts = [];
  if (links.lands.length) parts.push(`土地 ${links.lands.length}`);
  if (links.buildings.length) parts.push(`建物 ${links.buildings.length}`);
  return parts.length ? parts.join(" / ") : "業務リンクなし";
}

export function featureResultBusinessSummary(result: FeatureSearchResult): string {
  const matchedLinks = result.matchedBusinessLinks ?? emptyBusinessLinks;
  if (matchedLinks.lands.length || matchedLinks.buildings.length) {
    return `一致: ${businessLinksSummary(matchedLinks)}`;
  }
  return businessLinksSummary(result.businessLinks ?? emptyBusinessLinks);
}

export function groupFeatureResults(results: FeatureSearchResult[]) {
  const groups = new Map<string, { layerId: string; layerName: string; results: FeatureSearchResult[] }>();
  for (const result of results) {
    const existing = groups.get(result.layerId);
    if (existing) {
      existing.results.push(result);
    } else {
      groups.set(result.layerId, {
        layerId: result.layerId,
        layerName: result.layerName,
        results: [result]
      });
    }
  }
  return [...groups.values()];
}

export function mergeChoiceOptions(
  defaults: string[],
  ...sources: Array<string | null | undefined | Array<string | null | undefined>>
): string[] {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) values.add(trimmed);
  };
  defaults.forEach(add);
  sources.forEach((source) => {
    if (Array.isArray(source)) {
      source.forEach(add);
    } else {
      add(source);
    }
  });
  return [...values];
}

export function attributeValueOptionKey(layerId: string, field: string): string {
  return `${layerId}\u001f${field}`;
}

export function relationshipTypeChoices(...groups: Array<Array<{ relationships: PartyRelationship[] }>>): string[] {
  return mergeChoiceOptions(
    relationTypeOptions,
    groups.flatMap((group) => group.flatMap((item) => item.relationships.map((relationship) => relationship.relationType)))
  );
}

export function formatEditorValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function editableFeatureAttributes(layer: Layer) {
  return layer.attributes.filter((attribute) => attribute.name !== layer.featureIdColumn && attribute.name !== layer.geometryColumn);
}

export function defaultZoneSpatialLayerIds(layers: Layer[]): string[] {
  const polygonLayerIds = layers.filter(isPolygonLayer).map((layer) => layer.id);
  if (polygonLayerIds.length) return polygonLayerIds;
  return layers[0] ? [layers[0].id] : [];
}

export function isPolygonLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("POLYGON");
}

export function isZoneLayer(layer: Layer): boolean {
  return layer.layerRole === "zone";
}

export function zoneLayerOptions(layers: Layer[]): Layer[] {
  const zoneLayers = layers.filter(isZoneLayer);
  return zoneLayers.length ? zoneLayers : layers.filter(isZoneSourceLayer);
}

export function isZoneSourceLayer(layer: Layer): boolean {
  const geometryType = layer.geometryType.toUpperCase();
  return geometryType.includes("POLYGON") || geometryType === "GEOMETRY";
}

export function canCreateZoneLayerFromSource(layer: Layer): boolean {
  const geometryType = layer.geometryType.toUpperCase();
  return layer.layerRole !== "zone" && (geometryType.includes("POINT") || geometryType.includes("POLYGON") || geometryType === "GEOMETRY");
}

export function canUseSelectedFeatureAsZoneFeature(feature: Feature, layer: Layer): boolean {
  return isZoneLayer(layer) && isPolygonGeometry(feature.geometry);
}

export function isPolygonGeometry(geometry: unknown): boolean {
  return isRecord(geometry) && typeof geometry.type === "string" && geometry.type.toUpperCase().includes("POLYGON");
}

export type GeometryBounds = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

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

export function geoJsonGeometryBounds(geometry: unknown): GeometryBounds | null {
  if (!isRecord(geometry)) return null;
  const bounds: GeometryBounds = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY
  };

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const childBounds = geoJsonGeometryBounds(child);
      if (childBounds) {
        extendBounds(bounds, childBounds.minLng, childBounds.minLat);
        extendBounds(bounds, childBounds.maxLng, childBounds.maxLat);
      }
    }
  } else {
    extendBoundsFromCoordinates(bounds, geometry.coordinates);
  }

  if (!Number.isFinite(bounds.minLng) || !Number.isFinite(bounds.minLat)) return null;
  return bounds;
}

export function extendBoundsFromCoordinates(bounds: GeometryBounds, value: unknown) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    extendBounds(bounds, value[0], value[1]);
    return;
  }
  for (const item of value) {
    extendBoundsFromCoordinates(bounds, item);
  }
}

export function extendBounds(bounds: GeometryBounds, lng: number, lat: number) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  bounds.minLng = Math.min(bounds.minLng, lng);
  bounds.minLat = Math.min(bounds.minLat, lat);
  bounds.maxLng = Math.max(bounds.maxLng, lng);
  bounds.maxLat = Math.max(bounds.maxLat, lat);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRoute(pathname: string): RouteSelection {
  const [segment, rawId] = pathname.split("/").filter(Boolean);
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (segment === "zones") return { tab: "zone", id };
  if (segment === "lands") return { tab: "lands", id };
  if (segment === "buildings") return { tab: "buildings", id };
  if (segment === "parties") return { tab: "parties", id };
  return { tab: "zone", id: null };
}

export function tabPath(tab: BusinessTab): string {
  if (tab === "zone") return "/zones";
  if (tab === "lands") return "/lands";
  if (tab === "buildings") return "/buildings";
  if (tab === "parties") return "/parties";
  return "/zones";
}

export function emptyZoneDraft(): ZoneDraft {
  return {
    id: "",
    name: "",
    zoneType: "",
    status: "",
    memo: "",
    zoneLayerId: "",
    zoneFeatureId: ""
  };
}

export function emptyLandDraft(): LandDraft {
  return {
    id: "",
    lotNumber: "",
    address: "",
    landUse: "",
    areaSqm: "",
    registeredOwner: "",
    rightType: "",
    registrationCause: "",
    registrationAcceptedOn: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

export function emptyBuildingDraft(): BuildingDraft {
  return {
    id: "",
    landId: "",
    name: "",
    buildingLocation: "",
    houseNumber: "",
    buildingUse: "",
    floors: "",
    totalFloorAreaSqm: "",
    structure: "",
    registeredOwner: "",
    rightType: "",
    registrationAcceptedOn: "",
    status: "",
    memo: "",
    sourceLayerId: "",
    sourceFeatureId: ""
  };
}

export function emptyPartyDraft(): PartyDraft {
  return {
    id: "",
    name: "",
    partyType: "",
    contact: "",
    address: "",
    memo: "",
    tags: ""
  };
}

export function parsePartyTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,、]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    )
  );
}

export function newLandDraft(): LandDraft {
  return { ...emptyLandDraft(), status: "調査中" };
}

export function newBuildingDraft(): BuildingDraft {
  return { ...emptyBuildingDraft(), status: "調査中" };
}

export function newPartyDraft(): PartyDraft {
  return { ...emptyPartyDraft(), partyType: "法人" };
}

export function newZoneDraft(): ZoneDraft {
  return {
    ...emptyZoneDraft(),
    status: "有効"
  };
}

export function toZoneDraft(zone: Zone): ZoneDraft {
  return {
    id: zone.id,
    name: zone.name,
    zoneType: zone.zoneType ?? "",
    status: zone.status,
    memo: zone.memo ?? "",
    zoneLayerId: zoneLayerIdOf(zone),
    zoneFeatureId: zoneFeatureIdOf(zone)
  };
}

export function zoneMetadataFromDraft(draft: ZoneDraft): ZoneLayerCreateMetadata {
  return {
    name: nullableString(draft.name),
    zoneType: nullableString(draft.zoneType),
    status: nullableString(draft.status)
  };
}

export function toLandDraft(land: Land): LandDraft {
  return {
    id: land.id,
    lotNumber: land.lotNumber,
    address: land.address,
    landUse: land.landUse ?? "",
    areaSqm: land.areaSqm === null || land.areaSqm === undefined ? "" : String(land.areaSqm),
    registeredOwner: land.registeredOwner ?? "",
    rightType: land.rightType ?? "",
    registrationCause: land.registrationCause ?? "",
    registrationAcceptedOn: land.registrationAcceptedOn ?? "",
    status: land.status,
    memo: land.memo ?? "",
    sourceLayerId: land.sourceLayerId ?? "",
    sourceFeatureId: land.sourceFeatureId ?? ""
  };
}

export function toBuildingDraft(building: Building): BuildingDraft {
  return {
    id: building.id,
    landId: building.landId ?? "",
    name: building.name,
    buildingLocation: building.buildingLocation ?? "",
    houseNumber: building.houseNumber ?? "",
    buildingUse: building.buildingUse ?? "",
    floors: building.floors === null || building.floors === undefined ? "" : String(building.floors),
    totalFloorAreaSqm:
      building.totalFloorAreaSqm === null || building.totalFloorAreaSqm === undefined ? "" : String(building.totalFloorAreaSqm),
    structure: building.structure ?? "",
    registeredOwner: building.registeredOwner ?? "",
    rightType: building.rightType ?? "",
    registrationAcceptedOn: building.registrationAcceptedOn ?? "",
    status: building.status,
    memo: building.memo ?? "",
    sourceLayerId: building.sourceLayerId ?? "",
    sourceFeatureId: building.sourceFeatureId ?? ""
  };
}

export function toPartyDraft(party: Party): PartyDraft {
  return {
    id: party.id,
    name: party.name,
    partyType: party.partyType,
    contact: party.contact ?? "",
    address: party.address ?? "",
    memo: party.memo ?? "",
    tags: (party.tags ?? []).join("、")
  };
}

export function nullableString(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

export function nullableNumber(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const next = Number(trimmed);
  if (!Number.isFinite(next)) throw new Error(`${label} は数値で入力してください`);
  return next;
}

export function nullableInteger(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const next = Number(trimmed);
  if (!Number.isInteger(next)) throw new Error(`${label} は整数で入力してください`);
  return next;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
