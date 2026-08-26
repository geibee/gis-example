import { useEffect, useMemo, useState } from "react";
import { Building2, Layers, Loader2, Map as MapIcon, Upload, X } from "lucide-react";
import { searchFeatures } from "../api";
import type { Feature, FeatureSearchResult, Layer, Project, Zone } from "../contracts";
import type { BusinessObjectFilters, ZoneDraft } from "../appTypes";
import { zoneStatusOptions, zoneTypeOptions } from "../constants";
import {
  canUseSelectedFeatureAsZoneFeature,
  errorMessage,
  featureResultSummary,
  isPolygonGeometry,
  mergeChoiceOptions,
  zoneFeatureIdOf,
  zoneLayerIdOf,
  zoneLayerOptions,
  zoneLayerSummary
} from "../utils";
import { DataTable, type DataTableColumn } from "../ui/DataTable";
import { ChoiceSelect } from "./ChoiceSelect";
import { ObjectActions } from "./ObjectActions";
import { ObjectDetailHeader } from "./ObjectDetailHeader";
import { ObjectSidebar } from "./ObjectSidebar";
import { SourceLinkPanel } from "./SourceLinkPanel";
import { ZoneFilterPanel } from "./ZoneFilterPanel";
import { ZonePartySummary } from "./ZonePartySummary";

const zoneColumns = (layers: Layer[]): Array<DataTableColumn<Zone>> => [
  { key: "id", header: "ID", render: (zone) => zone.id },
  {
    key: "name",
    header: "区域名",
    render: (zone) => (
      <>
        <strong>{zone.name}</strong>
        <span>{zone.memo ?? ""}</span>
      </>
    )
  },
  { key: "zoneType", header: "種別", render: (zone) => zone.zoneType ?? "" },
  { key: "status", header: "ステータス", render: (zone) => zone.status },
  { key: "landCount", header: "土地", render: (zone) => (zone.landCount ?? 0).toLocaleString() },
  { key: "buildingCount", header: "建物", render: (zone) => (zone.buildingCount ?? 0).toLocaleString() },
  {
    key: "zoneLayer",
    header: "区域レイヤ",
    render: (zone) => zoneLayerSummary(layers, zoneLayerIdOf(zone), zoneFeatureIdOf(zone))
  }
];

export function ZoneWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  selectedId,
  selected,
  draft,
  setDraft,
  creating,
  loading,
  saving,
  deleting,
  onRefresh,
  onSearch,
  onSelect,
  onCreate,
  onCancelCreate,
  onBackToList,
  onSave,
  onDelete,
  onOpenLand,
  onOpenBuilding,
  onOpenParty,
  onShowOnMap,
  onOpenSourceFeature,
  onUseSelectedFeature,
  layers,
  selectedFeature,
  selectedFeatureLayer,
  zoneSourceLayerId,
  setZoneSourceLayerId,
  zoneSourceLayers,
  zoneUploadFile,
  setZoneUploadFile,
  zoneUploadFormat,
  setZoneUploadFormat,
  zoneUploadSrid,
  setZoneUploadSrid,
  creatingZoneLayer,
  onSubmitZoneFromLayer,
  onSubmitZoneUpload,
  selectedProject,
  projects,
  onProjectChange,
  gisTools
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Zone[];
  selectedId: string | null;
  selected: Zone | null;
  draft: ZoneDraft;
  setDraft: React.Dispatch<React.SetStateAction<ZoneDraft>>;
  creating: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onBackToList: () => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onOpenParty: (id: string) => void;
  onShowOnMap: (zone: Zone) => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  onUseSelectedFeature: () => void;
  layers: Layer[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  zoneSourceLayerId: string;
  setZoneSourceLayerId: (value: string) => void;
  zoneSourceLayers: Layer[];
  zoneUploadFile: File | null;
  setZoneUploadFile: (file: File | null) => void;
  zoneUploadFormat: string;
  setZoneUploadFormat: (value: string) => void;
  zoneUploadSrid: string;
  setZoneUploadSrid: (value: string) => void;
  creatingZoneLayer: boolean;
  onSubmitZoneFromLayer: () => void;
  onSubmitZoneUpload: () => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
  gisTools: React.ReactNode;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(zoneStatusOptions, items.map((zone) => zone.status), draft.status);
  const typeChoices = mergeChoiceOptions(zoneTypeOptions, items.map((zone) => zone.zoneType), draft.zoneType);
  const sourceLayers = useMemo(() => zoneLayerOptions(layers), [layers]);
  const selectedFeatureUsable = Boolean(
    selectedFeature && selectedFeatureLayer && canUseSelectedFeatureAsZoneFeature(selectedFeature, selectedFeatureLayer)
  );
  const [featureOptions, setFeatureOptions] = useState<FeatureSearchResult[]>([]);
  const [loadingFeatureOptions, setLoadingFeatureOptions] = useState(false);
  const [featureOptionsError, setFeatureOptionsError] = useState<string | null>(null);

  useEffect(() => {
    const sourceLayerId = draft.zoneLayerId?.trim() ?? "";
    if (!sourceLayerId) {
      setFeatureOptions([]);
      setFeatureOptionsError(null);
      setLoadingFeatureOptions(false);
      return;
    }
    let active = true;
    setLoadingFeatureOptions(true);
    setFeatureOptionsError(null);
    searchFeatures({ projectId: selectedProject, layerId: sourceLayerId, limit: 80 })
      .then((results) => {
        if (active) setFeatureOptions(results.filter((result) => isPolygonGeometry(result.geometry)));
      })
      .catch((error) => {
        if (active) {
          setFeatureOptions([]);
          setFeatureOptionsError(errorMessage(error));
        }
      })
      .finally(() => {
        if (active) setLoadingFeatureOptions(false);
      });
    return () => {
      active = false;
    };
  }, [draft.zoneLayerId, selectedProject]);

  const featureOptionIds = new Set(featureOptions.map((option) => option.featureId));
  const zoneFeatureFields = (
    <>
      <label>
        区域レイヤ
        <select
          value={draft.zoneLayerId ?? ""}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              zoneLayerId: event.target.value,
              zoneFeatureId: ""
            }))
          }
        >
          <option value="">選択</option>
          {sourceLayers.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layer.name} ({layer.geometryType})
            </option>
          ))}
        </select>
      </label>
      <label>
        区域地物
        <select
          value={draft.zoneFeatureId ?? ""}
          onChange={(event) => setDraft((current) => ({ ...current, zoneFeatureId: event.target.value }))}
          disabled={!draft.zoneLayerId || loadingFeatureOptions || Boolean(featureOptionsError)}
        >
          <option value="">{loadingFeatureOptions ? "取得中" : "選択"}</option>
          {draft.zoneFeatureId && !featureOptionIds.has(draft.zoneFeatureId) ? (
            <option value={draft.zoneFeatureId}>ID {draft.zoneFeatureId}</option>
          ) : null}
          {featureOptions.map((result) => (
            <option key={`${result.layerId}:${result.featureId}`} value={result.featureId}>
              ID {result.featureId} · {featureResultSummary(result)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
  const selectedFeatureAction = (
    <button className="subtle-button" type="button" onClick={onUseSelectedFeature} disabled={!selectedFeatureUsable}>
      <Layers size={15} />
      選択中の地物を設定
    </button>
  );
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
        <ObjectSidebar
          title="区域"
          query={query}
          setQuery={setQuery}
          loading={loading}
          onRefresh={onRefresh}
          onSearch={onSearch}
          onCreate={onCreate}
          filterContent={
            <ZoneFilterPanel
              filters={filters}
              setFilters={setFilters}
              open={filtersOpen}
              setOpen={setFiltersOpen}
              layers={layers}
              statusOptions={statusChoices}
              typeOptions={typeChoices}
            />
          }
          selectedProject={selectedProject}
          projects={projects}
          onProjectChange={onProjectChange}
        >
          <DataTable
            columns={zoneColumns(layers)}
            rows={items}
            rowKey={(zone) => zone.id}
            onRowClick={(zone) => onSelect(zone.id)}
            selectedRowKey={selectedId}
            emptyMessage="区域はありません"
            pageSize={50}
            tableClassName="business-table zone-table"
          />
          <details className="advanced-gis-tools">
            <summary>
              <Layers size={15} />
              GIS検索
            </summary>
            {gisTools}
          </details>
        </ObjectSidebar>
      ) : null}

      {detailOpen ? (
        <section className="object-detail">
          {hasDetailContent ? (
            <>
              <ObjectDetailHeader
                id={creating ? draft.id || "新規区域" : selected?.id ?? ""}
                title={draft.name || "区域"}
                subtitle={draft.zoneType}
                status={draft.status}
                href={selected ? `/zones/${encodeURIComponent(selected.id)}` : undefined}
                onBack={creating ? onCancelCreate : onBackToList}
              />
              <div className="object-form">
                {!creating ? (
                  <label>
                    ID
                    <input value={draft.id} disabled onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
                  </label>
                ) : null}
                <label>
                  区域名
                  <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label>
                  種別
                  <ChoiceSelect
                    value={draft.zoneType}
                    onChange={(value) => setDraft((current) => ({ ...current, zoneType: value }))}
                    options={typeChoices}
                    emptyLabel="選択"
                  />
                </label>
                <label>
                  ステータス
                  <ChoiceSelect
                    value={draft.status}
                    onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
                    options={statusChoices}
                    emptyLabel="選択"
                  />
                </label>
                {!creating ? zoneFeatureFields : null}
                {!creating ? (
                  <label className="wide-field">
                    メモ
                    <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
                  </label>
                ) : null}
              </div>

              {creating ? (
                <section className="object-related zone-data-panel">
                  <h3>
                    <Upload size={15} />
                    区域データ
                  </h3>
                  <div className="zone-data-grid">
                    <div className="zone-data-block">
                      <div className="mini-heading">
                        <span>ファイル</span>
                      </div>
                      <input type="file" onChange={(event) => setZoneUploadFile(event.target.files?.[0] ?? null)} />
                      <div className="inline-fields">
                        <label>
                          形式
                          <select value={zoneUploadFormat} onChange={(event) => setZoneUploadFormat(event.target.value)}>
                            <option value="geojson">GeoJSON</option>
                            <option value="shapefile">Shapefile zip</option>
                            <option value="gml">GML</option>
                            <option value="kml">KML</option>
                            <option value="gpx">GPX</option>
                          </select>
                        </label>
                        <label>
                          SRID
                          <input value={zoneUploadSrid} onChange={(event) => setZoneUploadSrid(event.target.value)} inputMode="numeric" />
                        </label>
                      </div>
                      <button className="command-button" type="button" onClick={onSubmitZoneUpload} disabled={!zoneUploadFile || creatingZoneLayer}>
                        {creatingZoneLayer ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
                        アップロードして作成
                      </button>
                    </div>

                    <div className="zone-data-block">
                      <div className="mini-heading">
                        <span>取込済みデータ</span>
                      </div>
                      <label>
                        データ
                        <select value={zoneSourceLayerId} onChange={(event) => setZoneSourceLayerId(event.target.value)}>
                          <option value="">選択</option>
                          {zoneSourceLayers.map((layer) => (
                            <option key={layer.id} value={layer.id}>
                              {layer.name} ({layer.geometryType})
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="zone-data-note" role="note">
                        <strong>対象レイヤに外縁を生成した区域レイヤを作成します</strong>
                        <p>
                          元のデータレイヤは変更せず、選択したポイント・ポリゴン地物から1000mバッファを作成し、
                          その外縁で囲まれる区域面を新しい区域レイヤとして追加します。
                        </p>
                        <ol>
                          <li>ポイントは点を中心に半径1000m、ポリゴンは形状の外側1000mまでをバッファ化します。</li>
                          <li>距離計算はメートル単位の座標系に変換して行います。</li>
                          <li>複数地物のバッファは重なりを統合し、1つの区域面として保存します。</li>
                          <li>空形状や区域化できない形状は除外し、作成後に区域レコードへ紐づけます。</li>
                        </ol>
                      </div>
                      <button className="command-button" type="button" onClick={onSubmitZoneFromLayer} disabled={!zoneSourceLayerId || creatingZoneLayer}>
                        {creatingZoneLayer ? <Loader2 className="spin" size={16} /> : <Layers size={16} />}
                        指定データから作成
                      </button>
                      {!zoneSourceLayers.length ? <p className="empty-state compact">対象データはありません</p> : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {!creating ? (
                <>
                  <div className="button-row compact-actions">
                    {selectedFeatureAction}
                    {selected ? (
                      <button className="subtle-button" type="button" onClick={() => onShowOnMap(selected)}>
                        <MapIcon size={15} />
                        地図で表示
                      </button>
                    ) : null}
                  </div>

                  <SourceLinkPanel layers={layers} layerId={draft.zoneLayerId} featureId={draft.zoneFeatureId} onOpen={onOpenSourceFeature} />
                </>
              ) : null}

              {selected ? <ZonePartySummary zoneId={selected.id} onOpenParty={onOpenParty} /> : null}

              {selected ? (
                <div className="object-related zone-contained-links">
                  <h3>含まれる土地</h3>
                  {(selected.lands ?? []).map((land) => (
                    <button key={land.id} type="button" onClick={() => onOpenLand(land.id)}>
                      <MapIcon size={15} />
                      <strong>{land.id}</strong>
                      <span>{land.label}</span>
                    </button>
                  ))}
                  {!(selected.lands ?? []).length ? <p className="empty-state compact">区域内の土地はありません</p> : null}
                  <h3>含まれる建物</h3>
                  {(selected.buildings ?? []).map((building) => (
                    <button key={building.id} type="button" onClick={() => onOpenBuilding(building.id)}>
                      <Building2 size={15} />
                      <strong>{building.id}</strong>
                      <span>{building.label}</span>
                    </button>
                  ))}
                  {!(selected.buildings ?? []).length ? <p className="empty-state compact">区域内の建物はありません</p> : null}
                </div>
              ) : null}

              {creating ? (
                <div className="object-actions">
                  <button className="subtle-button" type="button" onClick={onCancelCreate} disabled={creatingZoneLayer}>
                    <X size={15} />
                    キャンセル
                  </button>
                </div>
              ) : (
                <ObjectActions saving={saving} deleting={deleting} onSave={onSave} onDelete={onDelete} onCancel={onCancelCreate} creating={false} />
              )}
            </>
          ) : (
            <p className="empty-state">区域を読み込み中です</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
