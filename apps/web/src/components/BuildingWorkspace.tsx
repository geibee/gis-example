import { Map as MapIcon } from "lucide-react";
import type { Building, Feature, Land, Layer, Party, Project } from "../contracts";
import type { BuildingDraft, BusinessObjectFilters, RelationshipDraft } from "../appTypes";
import {
  buildingStructureOptions,
  buildingUseOptions,
  businessStatusOptions,
  partyTypeOptions,
  relationTypeOptions,
  rightTypeOptions
} from "../constants";
import { formatArea, gisLinkSummary, mergeChoiceOptions, relationshipSummary, relationshipTypeChoices } from "../utils";
import { DataTable, type DataTableColumn } from "../ui/DataTable";
import { BusinessFilterPanel } from "./BusinessFilterPanel";
import { ChoiceSelect } from "./ChoiceSelect";
import { ObjectActions } from "./ObjectActions";
import { ObjectDetailHeader } from "./ObjectDetailHeader";
import { ObjectSidebar } from "./ObjectSidebar";
import { RelationshipEditor } from "./RelationshipEditor";
import { SourceLinkPanel } from "./SourceLinkPanel";

const buildingColumns: Array<DataTableColumn<Building>> = [
  { key: "id", header: "ID", render: (building) => building.id },
  {
    key: "name",
    header: "名称",
    render: (building) => (
      <>
        <strong>{building.name}</strong>
        <span>{building.houseNumber ?? building.buildingLocation ?? ""}</span>
      </>
    )
  },
  { key: "land", header: "土地", render: (building) => building.landLabel ?? "未設定" },
  {
    key: "useStructure",
    header: "用途/構造",
    render: (building) => [building.buildingUse, building.structure].filter(Boolean).join(" / ")
  },
  { key: "floors", header: "階数", render: (building) => building.floors ?? "" },
  { key: "totalFloorArea", header: "延床", render: (building) => formatArea(building.totalFloorAreaSqm) },
  { key: "relationships", header: "関係者", render: (building) => relationshipSummary(building.relationships) },
  { key: "gis", header: "GIS", render: (building) => gisLinkSummary(building.sourceLayerId, building.sourceFeatureId) }
];

export function BuildingWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  lands,
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
  onOpenParty,
  onSaveRelationship,
  onDeleteRelationship,
  onUseMapBounds,
  onUseSelectedFeature,
  onOpenSourceFeature,
  layers,
  parties,
  selectedFeature,
  selectedFeatureLayer,
  selectedProject,
  projects,
  onProjectChange
}: {
  query: string;
  setQuery: (value: string) => void;
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  filtersOpen: boolean;
  setFiltersOpen: (value: boolean) => void;
  items: Building[];
  lands: Land[];
  selectedId: string | null;
  selected: Building | null;
  draft: BuildingDraft;
  setDraft: React.Dispatch<React.SetStateAction<BuildingDraft>>;
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
  onOpenParty: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  onUseMapBounds: () => void;
  onUseSelectedFeature: () => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  layers: Layer[];
  parties: Party[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(businessStatusOptions, items.map((building) => building.status), draft.status);
  const buildingUseChoices = mergeChoiceOptions(buildingUseOptions, items.map((building) => building.buildingUse), draft.buildingUse);
  const structureChoices = mergeChoiceOptions(buildingStructureOptions, items.map((building) => building.structure), draft.structure);
  const rightTypeChoices = mergeChoiceOptions(rightTypeOptions, items.map((building) => building.rightType), draft.rightType);
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType));
  const relationChoices = relationshipTypeChoices(items, lands, parties);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="建物"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="building"
            filters={filters}
            setFilters={setFilters}
            open={filtersOpen}
            setOpen={setFiltersOpen}
            layers={layers}
            selectedFeature={selectedFeature}
            selectedFeatureLayer={selectedFeatureLayer}
            onUseMapBounds={onUseMapBounds}
            onUseSelectedFeature={onUseSelectedFeature}
            statusOptions={statusChoices}
            useOptions={buildingUseChoices}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <DataTable
          columns={buildingColumns}
          rows={items}
          rowKey={(building) => building.id}
          onRowClick={(building) => onSelect(building.id)}
          selectedRowKey={selectedId}
          emptyMessage="建物はありません"
          pageSize={50}
        />
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規建物" : selected?.id ?? ""}
              title={draft.name || "建物"}
              subtitle={selected?.landLabel ?? draft.buildingLocation}
              status={draft.status}
              href={selected ? `/buildings/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                土地ID
                <select value={draft.landId} onChange={(event) => setDraft((current) => ({ ...current, landId: event.target.value }))}>
                  <option value="">未設定</option>
                  {lands.map((land) => (
                    <option key={land.id} value={land.id}>
                      {land.id} {land.lotNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                建物名
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                所在
                <input value={draft.buildingLocation} onChange={(event) => setDraft((current) => ({ ...current, buildingLocation: event.target.value }))} />
              </label>
              <label>
                家屋番号相当
                <input value={draft.houseNumber} onChange={(event) => setDraft((current) => ({ ...current, houseNumber: event.target.value }))} />
              </label>
              <label>
                用途
                <ChoiceSelect
                  value={draft.buildingUse}
                  onChange={(value) => setDraft((current) => ({ ...current, buildingUse: value }))}
                  options={buildingUseChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                構造
                <ChoiceSelect
                  value={draft.structure}
                  onChange={(value) => setDraft((current) => ({ ...current, structure: value }))}
                  options={structureChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                階数
                <input value={draft.floors} onChange={(event) => setDraft((current) => ({ ...current, floors: event.target.value }))} inputMode="numeric" />
              </label>
              <label>
                延床面積(m2)
                <input value={draft.totalFloorAreaSqm} onChange={(event) => setDraft((current) => ({ ...current, totalFloorAreaSqm: event.target.value }))} inputMode="decimal" />
              </label>
              <label>
                登記名義人
                <input value={draft.registeredOwner} onChange={(event) => setDraft((current) => ({ ...current, registeredOwner: event.target.value }))} />
              </label>
              <label>
                権利種別
                <ChoiceSelect
                  value={draft.rightType}
                  onChange={(value) => setDraft((current) => ({ ...current, rightType: value }))}
                  options={rightTypeChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                受付日
                <input type="date" value={draft.registrationAcceptedOn} onChange={(event) => setDraft((current) => ({ ...current, registrationAcceptedOn: event.target.value }))} />
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
              <label>
                GISレイヤ
                <select value={draft.sourceLayerId} onChange={(event) => setDraft((current) => ({ ...current, sourceLayerId: event.target.value }))}>
                  <option value="">未設定</option>
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                GIS地物ID
                <input value={draft.sourceFeatureId} onChange={(event) => setDraft((current) => ({ ...current, sourceFeatureId: event.target.value }))} />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
            <SourceLinkPanel layers={layers} layerId={draft.sourceLayerId} featureId={draft.sourceFeatureId} onOpen={onOpenSourceFeature} />
            {selected?.landId ? (
              <div className="object-related">
                <h3>土地</h3>
                <button type="button" onClick={() => selected.landId && onOpenLand(selected.landId)}>
                  <MapIcon size={15} />
                  <strong>{selected.landId}</strong>
                  <span>{selected.landLabel}</span>
                </button>
              </div>
            ) : null}
            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={parties}
                lands={lands}
                buildings={items}
                fixedTarget={{ targetType: "building", targetId: selected.id }}
                onOpenParty={onOpenParty}
                onOpenLand={onOpenLand}
                onOpenBuilding={() => undefined}
                onSave={onSaveRelationship}
                onDelete={onDeleteRelationship}
                relationOptions={relationChoices}
              />
            ) : null}
            <ObjectActions
              saving={saving}
              deleting={deleting}
              onSave={onSave}
              onDelete={onDelete}
              onCancel={onCancelCreate}
              creating={creating}
            />
          </>
        ) : (
          <p className="empty-state">建物を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}
