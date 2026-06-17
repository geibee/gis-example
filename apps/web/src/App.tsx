import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import maplibregl, { type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import {
  Eye,
  EyeOff,
  GripVertical,
  Layers,
  Loader2,
  Map as MapIcon,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  createAnalysisJob,
  createImportJob,
  getAnalysisJob,
  getFeature,
  getImportJob,
  getLayers,
  getProjects,
  updateFeature
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
const imperialPalaceCenter: [number, number] = [139.7528, 35.6852];
const defaultMapZoom = 12.5;
const layerViewStateStoragePrefix = "gis-example.layer-view-state.";

type LayerViewState = {
  baseMapVisible: boolean;
  visibleLayerIds: string[];
  layerOrder: string[];
};

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleLayersByLayerId = useRef<Record<string, string[]>>({});
  const appLayerByStyleLayer = useRef<Record<string, string>>({});
  const initializedLayerBounds = useRef(false);
  const seenLayerIds = useRef<Set<string>>(new Set());
  const loadedLayerProjectId = useRef<string | null>(null);
  const layersRef = useRef<Layer[]>([]);

  const [mapReady, setMapReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [layers, setLayers] = useState<Layer[]>([]);
  const [baseMapVisible, setBaseMapVisible] = useState(true);
  const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(new Set());
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
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

  const [outerBoundaryName, setOuterBoundaryName] = useState("");
  const [outerTargetLayerId, setOuterTargetLayerId] = useState("");
  const [outerBoundaryLayerId, setOuterBoundaryLayerId] = useState("");
  const [outerBoundaryBufferMeters, setOuterBoundaryBufferMeters] = useState("1000");

  const [featureEditOpen, setFeatureEditOpen] = useState(false);
  const [featurePropertyDraft, setFeaturePropertyDraft] = useState<Record<string, string>>({});
  const [featureGeometryDraft, setFeatureGeometryDraft] = useState("");
  const [savingFeature, setSavingFeature] = useState(false);

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
  const polygonLayers = useMemo(() => layers.filter(isPolygonLayer), [layers]);
  const boundaryCandidateLayers = useMemo(() => layers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer)), [layers]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const refreshLayers = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingLayers(true);
    try {
      const nextLayers = await getLayers(selectedProject);
      const savedViewState = readLayerViewState(selectedProject);
      const previousLayers = loadedLayerProjectId.current === selectedProject ? layersRef.current : [];
      const previousLayerIds = new Set(previousLayers.map((layer) => layer.id));
      const orderedLayers = orderLayers(nextLayers, savedViewState?.layerOrder ?? previousLayers.map((layer) => layer.id));
      const nextPolygonLayers = nextLayers.filter(isPolygonLayer);
      const nextBoundaryCandidateLayers = nextLayers.filter((layer) => isPolygonLayer(layer) || isLineLayer(layer));
      loadedLayerProjectId.current = selectedProject;
      if (typeof savedViewState?.baseMapVisible === "boolean") {
        setBaseMapVisible(savedViewState.baseMapVisible);
      }
      setLayers(orderedLayers);
      setVisibleLayerIds((current) => {
        return restoreVisibleLayerIds(orderedLayers, savedViewState, previousLayerIds, current);
      });
      if (!nextLayers.some((layer) => layer.id === targetLayerId)) {
        setTargetLayerId(nextLayers[0]?.id ?? "");
      }
      if (!nextPolygonLayers.some((layer) => layer.id === outerTargetLayerId)) {
        setOuterTargetLayerId(nextPolygonLayers[0]?.id ?? "");
      }
      if (!nextBoundaryCandidateLayers.some((layer) => layer.id === outerBoundaryLayerId)) {
        setOuterBoundaryLayerId(nextBoundaryCandidateLayers[0]?.id ?? "");
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoadingLayers(false);
    }
  }, [outerBoundaryLayerId, outerTargetLayerId, selectedProject, targetLayerId]);

  useEffect(() => {
    if (!selectedProject || loadedLayerProjectId.current !== selectedProject) return;
    writeLayerViewState(selectedProject, {
      baseMapVisible,
      visibleLayerIds: layers.filter((layer) => visibleLayerIds.has(layer.id)).map((layer) => layer.id),
      layerOrder: layers.map((layer) => layer.id)
    });
  }, [baseMapVisible, layers, selectedProject, visibleLayerIds]);

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
      center: imperialPalaceCenter,
      zoom: defaultMapZoom,
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
    syncMapLayerOrder(map, layers, styleLayersByLayerId.current);
  }, [layers, mapReady, visibleLayerIds]);

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

  useEffect(() => {
    if (!selectedFeature || !selectedFeatureLayer) {
      setFeatureEditOpen(false);
      setFeaturePropertyDraft({});
      setFeatureGeometryDraft("");
      return;
    }

    const nextDraft: Record<string, string> = {};
    for (const attribute of editableFeatureAttributes(selectedFeatureLayer)) {
      nextDraft[attribute.name] = formatEditorValue(selectedFeature.properties[attribute.name]);
    }
    setFeatureEditOpen(false);
    setFeaturePropertyDraft(nextDraft);
    setFeatureGeometryDraft(selectedFeature.geometry ? JSON.stringify(selectedFeature.geometry, null, 2) : "");
  }, [selectedFeature, selectedFeatureLayer]);

  const reloadLayerSource = (layerId: string) => {
    const source = mapRef.current?.getSource(layerId) as { reload?: () => void } | undefined;
    source?.reload?.();
  };

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

  const submitOuterBoundary = async () => {
    if (!selectedProject || !outerTargetLayerId || !outerBoundaryLayerId) return;
    const bufferMeters = Number(outerBoundaryBufferMeters || "1000");
    if (!Number.isFinite(bufferMeters) || bufferMeters <= 0) {
      setNotice("バッファ距離は正の数値で入力してください");
      return;
    }
    const body = {
      projectId: selectedProject,
      name: outerBoundaryName.trim() || undefined,
      targetLayerId: outerTargetLayerId,
      operation: "outer_boundary",
      boundaryLayerId: outerBoundaryLayerId,
      bufferMeters
    };
    try {
      const job = await createAnalysisJob(body);
      setAnalysisJobs((current) => upsertJob(current, job));
      pollAnalysisJob(job.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const saveSelectedFeature = async () => {
    if (!selectedFeature || !selectedFeatureLayer) return;
    let geometry: unknown = null;
    try {
      if (featureGeometryDraft.trim()) {
        geometry = JSON.parse(featureGeometryDraft);
      }
      const properties = Object.fromEntries(
        editableFeatureAttributes(selectedFeatureLayer).map((attribute) => [
          attribute.name,
          parseEditedProperty(
            featurePropertyDraft[attribute.name] ?? "",
            selectedFeature.properties[attribute.name],
            attribute.name
          )
        ])
      );
      setSavingFeature(true);
      const feature = await updateFeature(selectedFeatureLayer.id, selectedFeature.featureId, {
        properties,
        geometry
      });
      setSelectedFeature(feature);
      reloadLayerSource(selectedFeatureLayer.id);
      void refreshLayers();
      setNotice("地物を保存しました");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSavingFeature(false);
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

  const startLayerDrag = (event: DragEvent<HTMLDivElement>, layerId: string) => {
    setDraggingLayerId(layerId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
  };

  const dragLayerOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const dropLayer = (event: DragEvent<HTMLDivElement>, targetLayerId: string) => {
    event.preventDefault();
    const sourceLayerId = event.dataTransfer.getData("text/plain") || draggingLayerId;
    setDraggingLayerId(null);
    if (!sourceLayerId || sourceLayerId === targetLayerId) return;
    setLayers((current) => moveLayerBefore(current, sourceLayerId, targetLayerId));
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
              <span className="drag-handle disabled" aria-hidden="true" />
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
              <div
                className={`layer-row${draggingLayerId === layer.id ? " dragging" : ""}`}
                key={layer.id}
                draggable
                onDragEnd={() => setDraggingLayerId(null)}
                onDragOver={dragLayerOver}
                onDragStart={(event) => startLayerDrag(event, layer.id)}
                onDrop={(event) => dropLayer(event, layer.id)}
              >
                <span className="drag-handle" title="ドラッグして並べ替え" aria-label="ドラッグして並べ替え">
                  <GripVertical size={16} />
                </span>
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

        <section className="panel-section analysis-section">
          <div className="section-title">
            <MapIcon size={16} />
            <h2>外縁生成</h2>
          </div>
          <label>
            結果名
            <input value={outerBoundaryName} onChange={(event) => setOuterBoundaryName(event.target.value)} />
          </label>
          <label>
            ポリゴン1
            <select value={outerTargetLayerId} onChange={(event) => setOuterTargetLayerId(event.target.value)}>
              {polygonLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            区域指定レイヤ
            <select value={outerBoundaryLayerId} onChange={(event) => setOuterBoundaryLayerId(event.target.value)}>
              {boundaryCandidateLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            バッファ(m)
            <input
              value={outerBoundaryBufferMeters}
              onChange={(event) => setOuterBoundaryBufferMeters(event.target.value)}
              inputMode="decimal"
            />
          </label>
          <button
            className="command-button"
            type="button"
            onClick={() => void submitOuterBoundary()}
            disabled={!outerTargetLayerId || !outerBoundaryLayerId}
          >
            <Play size={16} />
            外縁生成開始
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
                <div>
                  <strong>{selectedFeatureLayer.name}</strong>
                  <span>ID {selectedFeature.featureId}</span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setFeatureEditOpen((open) => !open)}
                  title={featureEditOpen ? "編集を閉じる" : "地物編集"}
                >
                  {featureEditOpen ? <X size={16} /> : <Pencil size={16} />}
                </button>
              </div>
              {featureEditOpen ? (
                <FeatureEditor
                  layer={selectedFeatureLayer}
                  propertyDraft={featurePropertyDraft}
                  setPropertyDraft={setFeaturePropertyDraft}
                  geometryDraft={featureGeometryDraft}
                  setGeometryDraft={setFeatureGeometryDraft}
                  saving={savingFeature}
                  onCancel={() => setFeatureEditOpen(false)}
                  onSave={() => void saveSelectedFeature()}
                />
              ) : (
                <div className="property-table">
                  {Object.entries(selectedFeature.properties).map(([key, value]) => (
                    <div className="property-row" key={key}>
                      <span>{key}</span>
                      <strong>{formatValue(value)}</strong>
                    </div>
                  ))}
                </div>
              )}
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

function FeatureEditor({
  layer,
  propertyDraft,
  setPropertyDraft,
  geometryDraft,
  setGeometryDraft,
  saving,
  onCancel,
  onSave
}: {
  layer: Layer;
  propertyDraft: Record<string, string>;
  setPropertyDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  geometryDraft: string;
  setGeometryDraft: React.Dispatch<React.SetStateAction<string>>;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editableAttributes = editableFeatureAttributes(layer);
  return (
    <div className="feature-editor">
      {editableAttributes.length ? (
        <div className="feature-editor-fields">
          {editableAttributes.map((attribute) => (
            <label key={attribute.name}>
              {attribute.name}
              <input
                value={propertyDraft[attribute.name] ?? ""}
                onChange={(event) =>
                  setPropertyDraft((current) => ({
                    ...current,
                    [attribute.name]: event.target.value
                  }))
                }
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="empty-state compact">編集可能な属性はありません</p>
      )}
      <label>
        GeoJSON
        <textarea value={geometryDraft} onChange={(event) => setGeometryDraft(event.target.value)} spellCheck={false} />
      </label>
      <div className="button-row">
        <button className="subtle-button" type="button" onClick={onCancel}>
          <X size={15} />
          閉じる
        </button>
        <button className="command-button" type="button" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
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

function parseEditedProperty(value: string, originalValue: unknown, fieldName: string): unknown {
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

function moveLayerBefore(layers: Layer[], sourceLayerId: string, targetLayerId: string): Layer[] {
  const sourceIndex = layers.findIndex((layer) => layer.id === sourceLayerId);
  const targetIndex = layers.findIndex((layer) => layer.id === targetLayerId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layers;

  const next = [...layers];
  const [sourceLayer] = next.splice(sourceIndex, 1);
  const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(insertIndex, 0, sourceLayer);
  return next;
}

function orderLayers(layers: Layer[], layerOrder: string[] | undefined): Layer[] {
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

function restoreVisibleLayerIds(
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

function syncMapLayerOrder(
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

function readLayerViewState(projectId: string): Partial<LayerViewState> | null {
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

function writeLayerViewState(projectId: string, state: LayerViewState) {
  try {
    window.localStorage.setItem(layerViewStateStoragePrefix + projectId, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in private or restricted browser contexts.
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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

function formatEditorValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function editableFeatureAttributes(layer: Layer) {
  return layer.attributes.filter((attribute) => attribute.name !== layer.featureIdColumn && attribute.name !== layer.geometryColumn);
}

function isPolygonLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("POLYGON");
}

function isLineLayer(layer: Layer): boolean {
  return layer.geometryType.toUpperCase().includes("LINE");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
