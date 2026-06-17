import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import {
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Map as MapIcon,
  Play,
  Plus,
  RefreshCcw,
  Trash2,
  Upload
} from "lucide-react";
import {
  createAnalysisJob,
  createImportJob,
  getAnalysisJob,
  getFeature,
  getImportJob,
  getLayers,
  getProjects
} from "./api";
import type {
  AnalysisJob,
  AttributeConditionDraft,
  Feature,
  ImportJob,
  Layer,
  Project,
  SpatialConditionDraft
} from "./types";

const baseStyle = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

const attributeOperators = ["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL"];
const spatialOperators = ["intersects", "contains", "within", "dwithin"];
const layerColors = ["#0f766e", "#b45309", "#2563eb", "#be123c", "#7c3aed", "#15803d", "#c2410c"];

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLayersByLayerId = useRef<Record<string, string[]>>({});
  const appLayerByStyleLayer = useRef<Record<string, string>>({});
  const fittedInitialBounds = useRef(false);
  const seenLayerIds = useRef<Set<string>>(new Set());

  const [mapReady, setMapReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [layers, setLayers] = useState<Layer[]>([]);
  const [baseMapVisible, setBaseMapVisible] = useState(true);
  const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(new Set());
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
  const [selectedFeatureLayer, setSelectedFeatureLayer] = useState<Layer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingLayers, setLoadingLayers] = useState(false);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFormat, setUploadFormat] = useState("geojson");
  const [uploadSrid, setUploadSrid] = useState("4326");
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);

  const [analysisName, setAnalysisName] = useState("");
  const [targetLayerId, setTargetLayerId] = useState("");
  const [attributeConditions, setAttributeConditions] = useState<AttributeConditionDraft[]>([]);
  const [spatialConditions, setSpatialConditions] = useState<SpatialConditionDraft[]>([]);
  const [analysisJobs, setAnalysisJobs] = useState<AnalysisJob[]>([]);

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);

  const refreshLayers = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingLayers(true);
    try {
      const nextLayers = await getLayers(selectedProject);
      setLayers(nextLayers);
      setVisibleLayerIds((current) => {
        const next = new Set(current);
        for (const layer of nextLayers) {
          if (!current.size || layer.isResult) next.add(layer.id);
        }
        return next;
      });
      if (!targetLayerId && nextLayers[0]) setTargetLayerId(nextLayers[0].id);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLayers(false);
    }
  }, [selectedProject, targetLayerId]);

  useEffect(() => {
    getProjects()
      .then((items) => {
        setProjects(items);
        if (items[0]) setSelectedProject(items[0].id);
      })
      .catch((error) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    void refreshLayers();
  }, [refreshLayers]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as maplibregl.StyleSpecification,
      center: [139.7618, 35.6817],
      zoom: 15,
      attributionControl: { compact: true }
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.on("load", () => setMapReady(true));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
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
  }, [layers, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const visibleLayersWithBounds = layers.filter((layer) => visibleLayerIds.has(layer.id) && layer.bbox4326);
    if (!visibleLayersWithBounds.length) return;

    const layerToFit = !fittedInitialBounds.current
      ? visibleLayersWithBounds[0]
      : visibleLayersWithBounds.find((layer) => !seenLayerIds.current.has(layer.id));

    if (layerToFit?.bbox4326) {
      map.fitBounds(
        [
          [layerToFit.bbox4326[0], layerToFit.bbox4326[1]],
          [layerToFit.bbox4326[2], layerToFit.bbox4326[3]]
        ],
        { padding: 48, duration: 600, maxZoom: 16 }
      );
      fittedInitialBounds.current = true;
    }

    for (const layer of layers) {
      seenLayerIds.current.add(layer.id);
    }
  }, [layers, mapReady, visibleLayerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    const handleClick = async (event: MapLayerMouseEvent) => {
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
        setNotice("選択地物のIDを取得できませんでした");
        return;
      }
      try {
        const feature = await getFeature(layer.id, String(featureId));
        setSelectedFeature(feature);
        setSelectedFeatureLayer(layer);
      } catch (error) {
        setNotice(errorMessage(error));
      }
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [layerById, mapReady]);

  const submitUpload = async () => {
    if (!selectedProject || !uploadFile) return;
    const formData = new FormData();
    formData.set("projectId", selectedProject);
    formData.set("format", uploadFormat);
    if (uploadSrid.trim()) formData.set("sourceSrid", uploadSrid.trim());
    formData.set("file", uploadFile);
    try {
      const job = await createImportJob(formData);
      setImportJobs((current) => upsertJob(current, job));
      pollImportJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const pollImportJob = (id: string) => {
    const timer = window.setInterval(async () => {
      try {
        const job = await getImportJob(id);
        setImportJobs((current) => upsertJob(current, job));
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          void refreshLayers();
        }
      } catch (error) {
        window.clearInterval(timer);
        setNotice(errorMessage(error));
      }
    }, 1500);
  };

  const submitAnalysis = async () => {
    if (!selectedProject || !targetLayerId) return;
    const body = {
      projectId: selectedProject,
      name: analysisName.trim() || undefined,
      targetLayerId,
      attributeConditions: attributeConditions
        .filter((condition) => condition.layerId && condition.field)
        .map((condition) => toAttributePayload(condition)),
      spatialConditions: spatialConditions
        .filter((condition) => condition.layerId)
        .map((condition) => ({
          layerId: condition.layerId,
          operator: condition.operator,
          distanceMeters:
            condition.operator === "dwithin" ? Number(condition.distanceMeters || "0") : undefined
        }))
    };
    try {
      const job = await createAnalysisJob(body);
      setAnalysisJobs((current) => upsertJob(current, job));
      pollAnalysisJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const pollAnalysisJob = (id: string) => {
    const timer = window.setInterval(async () => {
      try {
        const job = await getAnalysisJob(id);
        setAnalysisJobs((current) => upsertJob(current, job));
        if (job.status === "succeeded" || job.status === "failed") {
          window.clearInterval(timer);
          void refreshLayers();
        }
      } catch (error) {
        window.clearInterval(timer);
        setNotice(errorMessage(error));
      }
    }, 1500);
  };

  const toggleLayer = (layerId: string) => {
    setVisibleLayerIds((current) => {
      const next = new Set(current);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const addAttributeCondition = () => {
    const layer = layerById.get(targetLayerId) ?? layers[0];
    setAttributeConditions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        layerId: layer?.id ?? "",
        field: layer?.attributes[0]?.name ?? "",
        operator: "=",
        value: ""
      }
    ]);
  };

  const addSpatialCondition = () => {
    const layer = layers.find((item) => item.id !== targetLayerId) ?? layers[0];
    setSpatialConditions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        layerId: layer?.id ?? "",
        operator: "intersects",
        distanceMeters: "50"
      }
    ]);
  };

  return (
    <div className="app-shell">
      <aside className="left-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">PostGIS Web GIS</p>
            <h1>レイヤ操作</h1>
          </div>
          <button className="icon-button" type="button" onClick={() => void refreshLayers()} title="レイヤ更新">
            <RefreshCcw size={18} />
          </button>
        </header>

        <section className="panel-section">
          <label>
            プロジェクト
            <select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <Upload size={16} />
            <h2>取込</h2>
          </div>
          <input type="file" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
          <div className="inline-fields">
            <label>
              形式
              <select value={uploadFormat} onChange={(event) => setUploadFormat(event.target.value)}>
                <option value="geojson">GeoJSON</option>
                <option value="shapefile">Shapefile zip</option>
                <option value="gml">GML</option>
                <option value="kml">KML</option>
                <option value="gpx">GPX</option>
              </select>
            </label>
            <label>
              SRID
              <input value={uploadSrid} onChange={(event) => setUploadSrid(event.target.value)} inputMode="numeric" />
            </label>
          </div>
          <button className="command-button" type="button" onClick={() => void submitUpload()} disabled={!uploadFile}>
            <Upload size={16} />
            取込開始
          </button>
        </section>

        <section className="panel-section layer-list-section">
          <div className="section-title">
            <Layers size={16} />
            <h2>レイヤ</h2>
            {loadingLayers ? <Loader2 className="spin muted-icon" size={15} /> : null}
          </div>
          <div className="layer-list">
            <div className="layer-row base-layer">
              <button
                className="icon-button"
                type="button"
                onClick={() => setBaseMapVisible((visible) => !visible)}
                title="ベース地図表示切替"
              >
                {baseMapVisible ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
              <div className="layer-meta">
                <strong>
                  <MapIcon size={14} />
                  OpenStreetMap
                </strong>
                <span>ベース地図</span>
              </div>
            </div>
            {layers.map((layer) => (
              <div className="layer-row" key={layer.id}>
                <button className="icon-button" type="button" onClick={() => toggleLayer(layer.id)} title="表示切替">
                  {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                </button>
                <div className="layer-meta">
                  <strong>{layer.name}</strong>
                  <span>
                    {layer.geometryType} · {layer.rowCount.toLocaleString()}件{layer.isResult ? " · 結果" : ""}
                  </span>
                </div>
              </div>
            ))}
            {!layers.length ? <p className="empty-state">取込済みレイヤはありません</p> : null}
          </div>
        </section>

        <section className="panel-section analysis-section">
          <div className="section-title">
            <Play size={16} />
            <h2>AND条件抽出</h2>
          </div>
          <label>
            結果名
            <input value={analysisName} onChange={(event) => setAnalysisName(event.target.value)} />
          </label>
          <label>
            対象レイヤ
            <select value={targetLayerId} onChange={(event) => setTargetLayerId(event.target.value)}>
              {layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
          </label>

          <ConditionEditor
            layers={layers}
            layerById={layerById}
            attributeConditions={attributeConditions}
            setAttributeConditions={setAttributeConditions}
            spatialConditions={spatialConditions}
            setSpatialConditions={setSpatialConditions}
          />

          <div className="button-row">
            <button className="subtle-button" type="button" onClick={addAttributeCondition}>
              <Plus size={15} />
              属性
            </button>
            <button className="subtle-button" type="button" onClick={addSpatialCondition}>
              <Plus size={15} />
              空間
            </button>
          </div>
          <button className="command-button" type="button" onClick={() => void submitAnalysis()} disabled={!targetLayerId}>
            <Play size={16} />
            抽出開始
          </button>
        </section>
      </aside>

      <main className="map-panel">
        <div ref={mapContainerRef} className="map-container" />
        {notice ? (
          <div className="notice">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>
              閉じる
            </button>
          </div>
        ) : null}
      </main>

      <aside className="right-panel">
        <section className="panel-section">
          <h2>選択地物</h2>
          {selectedFeature && selectedFeatureLayer ? (
            <div className="feature-view">
              <div className="feature-heading">
                <strong>{selectedFeatureLayer.name}</strong>
                <span>ID {selectedFeature.featureId}</span>
              </div>
              <div className="property-table">
                {Object.entries(selectedFeature.properties).map(([key, value]) => (
                  <div className="property-row" key={key}>
                    <span>{key}</span>
                    <strong>{formatValue(value)}</strong>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="empty-state">地図上の地物を選択してください</p>
          )}
        </section>

        <section className="panel-section">
          <h2>ジョブ</h2>
          <JobList title="取込" jobs={importJobs} />
          <JobList title="解析" jobs={analysisJobs} />
        </section>
      </aside>
    </div>
  );
}

function ConditionEditor({
  layers,
  layerById,
  attributeConditions,
  setAttributeConditions,
  spatialConditions,
  setSpatialConditions
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
  attributeConditions: AttributeConditionDraft[];
  setAttributeConditions: React.Dispatch<React.SetStateAction<AttributeConditionDraft[]>>;
  spatialConditions: SpatialConditionDraft[];
  setSpatialConditions: React.Dispatch<React.SetStateAction<SpatialConditionDraft[]>>;
}) {
  const updateAttribute = (id: string, patch: Partial<AttributeConditionDraft>) => {
    setAttributeConditions((current) =>
      current.map((condition) => {
        if (condition.id !== id) return condition;
        const next = { ...condition, ...patch };
        if (patch.layerId) {
          next.field = layerById.get(patch.layerId)?.attributes[0]?.name ?? "";
        }
        return next;
      })
    );
  };

  return (
    <div className="conditions">
      {attributeConditions.map((condition) => {
        const fields = layerById.get(condition.layerId)?.attributes ?? [];
        return (
          <div className="condition-row" key={condition.id}>
            <select value={condition.layerId} onChange={(event) => updateAttribute(condition.id, { layerId: event.target.value })}>
              {layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
            <select value={condition.field} onChange={(event) => updateAttribute(condition.id, { field: event.target.value })}>
              {fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
            <select value={condition.operator} onChange={(event) => updateAttribute(condition.id, { operator: event.target.value })}>
              {attributeOperators.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </select>
            <input
              value={condition.value}
              onChange={(event) => updateAttribute(condition.id, { value: event.target.value })}
              disabled={condition.operator === "IS NULL"}
            />
            <button
              className="icon-button"
              type="button"
              onClick={() => setAttributeConditions((current) => current.filter((item) => item.id !== condition.id))}
              title="条件削除"
            >
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}

      {spatialConditions.map((condition) => (
        <div className="condition-row spatial" key={condition.id}>
          <select
            value={condition.layerId}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, layerId: event.target.value } : item))
              )
            }
          >
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
          <select
            value={condition.operator}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, operator: event.target.value } : item))
              )
            }
          >
            {spatialOperators.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
          <input
            value={condition.operator === "dwithin" ? condition.distanceMeters : ""}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, distanceMeters: event.target.value } : item))
              )
            }
            disabled={condition.operator !== "dwithin"}
            placeholder={condition.operator === "dwithin" ? "m" : "距離なし"}
            inputMode="decimal"
            aria-label="dwithin距離メートル"
          />
          <button
            className="icon-button"
            type="button"
            onClick={() => setSpatialConditions((current) => current.filter((item) => item.id !== condition.id))}
            title="条件削除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function JobList({ title, jobs }: { title: string; jobs: Array<ImportJob | AnalysisJob> }) {
  return (
    <div className="job-group">
      <h3>{title}</h3>
      {jobs.slice(0, 5).map((job) => (
        <div className="job-row" key={job.id}>
          <span className={`status-dot ${job.status}`} />
          <div>
            <strong>{"filename" in job ? job.filename : job.name}</strong>
            <span>
              {job.status}
              {"resultCount" in job && job.resultCount !== null && job.resultCount !== undefined
                ? ` · ${job.resultCount.toLocaleString()}件`
                : ""}
            </span>
            {job.errorMessage ? <em>{job.errorMessage}</em> : null}
          </div>
        </div>
      ))}
      {!jobs.length ? <p className="empty-state compact">ジョブはありません</p> : null}
    </div>
  );
}

function addMapLayers(map: MapLibreMap, layer: Layer, color: string): string[] {
  const sourceLayer = layer.tileSourceId;
  const source = layer.id;
  const geometryType = layer.geometryType.toUpperCase();
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
      paint: { "fill-color": color, "fill-opacity": 0.32 }
    } as maplibregl.FillLayerSpecification);
    map.addLayer({
      id: outlineId,
      type: "line",
      source,
      "source-layer": sourceLayer,
      filter: ["==", "$type", "Polygon"],
      paint: { "line-color": color, "line-width": 1.2 }
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

function toAttributePayload(condition: AttributeConditionDraft) {
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

function parseDraftValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

function upsertJob<T extends { id: string }>(jobs: T[], next: T): T[] {
  const filtered = jobs.filter((job) => job.id !== next.id);
  return [next, ...filtered];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
