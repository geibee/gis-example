import type { DragEvent } from "react";
import {
  Eye,
  EyeOff,
  GripVertical,
  Layers,
  Loader2,
  Map as MapIcon,
  Pencil,
  RefreshCcw,
  Trash2,
  X
} from "lucide-react";
import type { BusinessLinks, Feature, Layer } from "../contracts";
import type { LayerListItem } from "../appTypes";
import { formatValue } from "../utils";
import { BusinessLinksPanel } from "./BusinessLinksPanel";
import { FeatureEditor } from "./FeatureEditor";

export function MapSupportPane({
  open,
  onToggle,
  mapContainerRef,
  baseMapVisible,
  setBaseMapVisible,
  layerListItems,
  visibleLayerIds,
  loadingLayers,
  deletingLayerIds,
  deletingResultSetIds,
  draggingLayerId,
  onRefreshLayers,
  onToggleLayer,
  onToggleLayerGroup,
  onRequestLayerDelete,
  onRequestResultSetDelete,
  onDragLayerStart,
  onDragLayerOver,
  onDropLayer,
  onDragLayerEnd,
  selectedFeature,
  selectedFeatureLayer,
  businessLinks,
  loadingBusinessLinks,
  featureEditOpen,
  setFeatureEditOpen,
  featurePropertyDraft,
  setFeaturePropertyDraft,
  featureGeometryDraft,
  setFeatureGeometryDraft,
  savingFeature,
  onSaveFeature
}: {
  open: boolean;
  onToggle: () => void;
  mapContainerRef: React.RefObject<HTMLDivElement>;
  baseMapVisible: boolean;
  setBaseMapVisible: React.Dispatch<React.SetStateAction<boolean>>;
  layerListItems: LayerListItem[];
  visibleLayerIds: Set<string>;
  loadingLayers: boolean;
  deletingLayerIds: Set<string>;
  deletingResultSetIds: Set<string>;
  draggingLayerId: string | null;
  onRefreshLayers: () => void;
  onToggleLayer: (layerId: string) => void;
  onToggleLayerGroup: (layerIds: string[]) => void;
  onRequestLayerDelete: (layer: Layer) => void;
  onRequestResultSetDelete: (resultSet: Extract<LayerListItem, { type: "resultSet" }>) => void;
  onDragLayerStart: (event: DragEvent<HTMLDivElement>, layerId: string) => void;
  onDragLayerOver: (event: DragEvent<HTMLDivElement>) => void;
  onDropLayer: (event: DragEvent<HTMLDivElement>, targetLayerId: string) => void;
  onDragLayerEnd: () => void;
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  businessLinks: BusinessLinks;
  loadingBusinessLinks: boolean;
  featureEditOpen: boolean;
  setFeatureEditOpen: React.Dispatch<React.SetStateAction<boolean>>;
  featurePropertyDraft: Record<string, string>;
  setFeaturePropertyDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  featureGeometryDraft: string;
  setFeatureGeometryDraft: React.Dispatch<React.SetStateAction<string>>;
  savingFeature: boolean;
  onSaveFeature: () => void;
}) {
  return (
    <aside className={`map-support-pane${open ? "" : " closed"}`}>
      <header className="map-support-header">
        <div>
          <p className="eyebrow">Map Support</p>
          <h2>地図</h2>
        </div>
        <button className="icon-button" type="button" onClick={onToggle} title="地図ペインを閉じる">
          <EyeOff size={16} />
        </button>
      </header>

      <div className="support-map-panel">
        <div ref={mapContainerRef} className="map-container" />
      </div>

      <div className="map-support-scroll">
        <section className="panel-section layer-list-section">
          <div className="section-title">
            <Layers size={16} />
            <h2>レイヤ</h2>
            {loadingLayers ? <Loader2 className="spin muted-icon" size={15} /> : null}
            <button className="icon-button inline-icon-button" type="button" onClick={onRefreshLayers} title="レイヤ更新">
              <RefreshCcw size={15} />
            </button>
          </div>
          <div className="layer-list">
            <div className="layer-row base-layer">
              <span className="drag-handle disabled" aria-hidden="true" />
              <button className="icon-button" type="button" onClick={() => setBaseMapVisible((visible) => !visible)} title="ベース地図表示切替">
                {baseMapVisible ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
              <div className="layer-meta">
                <strong>
                  <MapIcon size={14} />
                  OpenStreetMap
                </strong>
                <span>ベース地図</span>
              </div>
              <span className="layer-action-spacer" aria-hidden="true" />
            </div>
            {layerListItems.map((item) => {
              if (item.type === "resultSet") {
                const childIds = item.layers.map((layer) => layer.id);
                const allVisible = childIds.every((layerId) => visibleLayerIds.has(layerId));
                const deletingResultSet = deletingResultSetIds.has(item.id);
                return (
                  <div className="layer-result-group" key={item.id}>
                    <div className="layer-row layer-group-row">
                      <span className="drag-handle disabled" aria-hidden="true" />
                      <button className="icon-button" type="button" onClick={() => onToggleLayerGroup(childIds)} title="まとめて表示切替">
                        {allVisible ? <Eye size={17} /> : <EyeOff size={17} />}
                      </button>
                      <div className="layer-meta">
                        <strong>{item.name}</strong>
                        <span>条件検索結果 · {item.layers.length.toLocaleString()}レイヤ</span>
                      </div>
                      <button
                        className="icon-button danger-icon-button"
                        type="button"
                        onClick={() => onRequestResultSetDelete(item)}
                        disabled={deletingResultSet}
                        title="条件検索結果を削除"
                      >
                        {deletingResultSet ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                      </button>
                    </div>
                    {item.layers.map((layer) => (
                      <div className="layer-row child-layer-row" key={layer.id}>
                        <span className="drag-handle disabled" aria-hidden="true" />
                        <button className="icon-button" type="button" onClick={() => onToggleLayer(layer.id)} title="表示切替">
                          {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                        </button>
                        <div className="layer-meta">
                          <strong>{layer.name}</strong>
                          <span>
                            {layer.geometryType} · {layer.rowCount.toLocaleString()}件
                          </span>
                        </div>
                        <button
                          className="icon-button danger-icon-button"
                          type="button"
                          onClick={() => onRequestLayerDelete(layer)}
                          disabled={deletingResultSet || deletingLayerIds.has(layer.id)}
                          title="レイヤ削除"
                        >
                          {deletingResultSet || deletingLayerIds.has(layer.id) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    ))}
                  </div>
                );
              }
              const layer = item.layer;
              return (
                <div
                  className={`layer-row${draggingLayerId === layer.id ? " dragging" : ""}`}
                  key={layer.id}
                  draggable
                  onDragEnd={onDragLayerEnd}
                  onDragOver={onDragLayerOver}
                  onDragStart={(event) => onDragLayerStart(event, layer.id)}
                  onDrop={(event) => onDropLayer(event, layer.id)}
                >
                  <span className="drag-handle" title="ドラッグして並べ替え" aria-label="ドラッグして並べ替え">
                    <GripVertical size={16} />
                  </span>
                  <button className="icon-button" type="button" onClick={() => onToggleLayer(layer.id)} title="表示切替">
                    {visibleLayerIds.has(layer.id) ? <Eye size={17} /> : <EyeOff size={17} />}
                  </button>
                  <div className="layer-meta">
                    <strong>{layer.name}</strong>
                    <span>
                      {layer.geometryType} · {layer.rowCount.toLocaleString()}件{layer.isResult ? " · 結果" : ""}{layer.layerRole === "zone" ? " · 区域" : ""}
                    </span>
                  </div>
                  <button
                    className="icon-button danger-icon-button"
                    type="button"
                    onClick={() => onRequestLayerDelete(layer)}
                    disabled={deletingLayerIds.has(layer.id)}
                    title="レイヤ削除"
                  >
                    {deletingLayerIds.has(layer.id) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  </button>
                </div>
              );
            })}
            {!layerListItems.length ? <p className="empty-state">レイヤはありません</p> : null}
          </div>
        </section>

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
                  onClick={() => setFeatureEditOpen((editing) => !editing)}
                  title={featureEditOpen ? "編集を閉じる" : "地物編集"}
                >
                  {featureEditOpen ? <X size={16} /> : <Pencil size={16} />}
                </button>
              </div>
              <BusinessLinksPanel links={businessLinks} loading={loadingBusinessLinks} />
              {featureEditOpen ? (
                <FeatureEditor
                  layer={selectedFeatureLayer}
                  propertyDraft={featurePropertyDraft}
                  setPropertyDraft={setFeaturePropertyDraft}
                  geometryDraft={featureGeometryDraft}
                  setGeometryDraft={setFeatureGeometryDraft}
                  saving={savingFeature}
                  onCancel={() => setFeatureEditOpen(false)}
                  onSave={onSaveFeature}
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
      </div>
    </aside>
  );
}
