import { Building2 } from "lucide-react";
import type { Building, Feature, Land, Layer, Party, Project } from "../contracts";
import type { BusinessObjectFilters, LandDraft, RelationshipDraft } from "../appTypes";
import {
  businessStatusOptions,
  landUseOptions,
  partyTypeOptions,
  registrationCauseOptions,
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

const landColumns: Array<DataTableColumn<Land>> = [
  { key: "id", header: "ID", render: (land) => land.id },
  {
    key: "address",
    header: "所在地 / 地番",
    render: (land) => (
      <>
        <strong>{land.address}</strong>
        <span>{land.lotNumber}</span>
      </>
    )
  },
  { key: "landUse", header: "用途", render: (land) => land.landUse ?? "" },
  { key: "areaSqm", header: "地積", render: (land) => formatArea(land.areaSqm) },
  { key: "status", header: "ステータス", render: (land) => land.status },
  { key: "relationships", header: "関係者", render: (land) => relationshipSummary(land.relationships) },
  { key: "gis", header: "GIS", render: (land) => gisLinkSummary(land.sourceLayerId, land.sourceFeatureId) }
];

export function LandWorkspace({
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
  onOpenBuilding,
  onOpenParty,
  onSaveRelationship,
  onDeleteRelationship,
  onUseMapBounds,
  onUseSelectedFeature,
  onOpenSourceFeature,
  layers,
  parties,
  buildings,
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
  items: Land[];
  selectedId: string | null;
  selected: Land | null;
  draft: LandDraft;
  setDraft: React.Dispatch<React.SetStateAction<LandDraft>>;
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
  onOpenBuilding: (id: string) => void;
  onOpenParty: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  onUseMapBounds: () => void;
  onUseSelectedFeature: () => void;
  onOpenSourceFeature: (layerId?: string | null, featureId?: string | null) => void;
  layers: Layer[];
  parties: Party[];
  buildings: Building[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const statusChoices = mergeChoiceOptions(businessStatusOptions, items.map((land) => land.status), draft.status);
  const landUseChoices = mergeChoiceOptions(landUseOptions, items.map((land) => land.landUse), draft.landUse);
  const rightTypeChoices = mergeChoiceOptions(rightTypeOptions, items.map((land) => land.rightType), draft.rightType);
  const registrationCauseChoices = mergeChoiceOptions(
    registrationCauseOptions,
    items.map((land) => land.registrationCause),
    draft.registrationCause
  );
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType));
  const relationChoices = relationshipTypeChoices(items, buildings, parties);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="土地"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="land"
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
            useOptions={landUseChoices}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <DataTable
          columns={landColumns}
          rows={items}
          rowKey={(land) => land.id}
          onRowClick={(land) => onSelect(land.id)}
          selectedRowKey={selectedId}
          emptyMessage="土地はありません"
          pageSize={50}
        />
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規土地" : selected?.id ?? ""}
              title={draft.lotNumber || "土地"}
              subtitle={draft.address}
              status={draft.status}
              href={selected ? `/lands/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                地番
                <input value={draft.lotNumber} onChange={(event) => setDraft((current) => ({ ...current, lotNumber: event.target.value }))} />
              </label>
              <label className="wide-field">
                所在地
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label>
                地目/用途
                <ChoiceSelect
                  value={draft.landUse}
                  onChange={(value) => setDraft((current) => ({ ...current, landUse: value }))}
                  options={landUseChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                地積(m2)
                <input value={draft.areaSqm} onChange={(event) => setDraft((current) => ({ ...current, areaSqm: event.target.value }))} inputMode="decimal" />
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
                登記原因
                <ChoiceSelect
                  value={draft.registrationCause}
                  onChange={(value) => setDraft((current) => ({ ...current, registrationCause: value }))}
                  options={registrationCauseChoices}
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

            {selected ? (
              <div className="object-related">
                <h3>建物</h3>
                {selected.buildings.map((building) => (
                  <button key={building.id} type="button" onClick={() => onOpenBuilding(building.id)}>
                    <Building2 size={15} />
                    <strong>{building.id}</strong>
                    <span>{building.label}</span>
                  </button>
                ))}
                {!selected.buildings.length ? <p className="empty-state compact">紐づく建物はありません</p> : null}
              </div>
            ) : null}

            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={parties}
                lands={items}
                buildings={buildings}
                fixedTarget={{ targetType: "land", targetId: selected.id }}
                onOpenParty={onOpenParty}
                onOpenLand={() => undefined}
                onOpenBuilding={onOpenBuilding}
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
          <p className="empty-state">土地を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}
