import type { Building, Land, Party, Project } from "../contracts";
import type { BusinessObjectFilters, RelationshipDraft } from "../appTypes";
import { partyTypeOptions } from "../constants";
import { mergeChoiceOptions, newPartyDraft, relationshipTypeChoices, toPartyDraft } from "../utils";
import { DataTable, type DataTableColumn } from "../ui/DataTable";
import { BusinessFilterPanel } from "./BusinessFilterPanel";
import { ObjectActions } from "./ObjectActions";
import { ObjectSidebar } from "./ObjectSidebar";
import { PartyForm, partyFormId, type PartyFormValues } from "./PartyForm";
import { RelationshipEditor } from "./RelationshipEditor";

const partyColumns: Array<DataTableColumn<Party>> = [
  { key: "id", header: "ID", render: (party) => party.id },
  { key: "name", header: "名称", render: (party) => party.name },
  { key: "partyType", header: "種別", render: (party) => party.partyType },
  {
    key: "addressContact",
    header: "住所/連絡先",
    render: (party) => (
      <>
        <strong>{party.address ?? ""}</strong>
        <span>{party.contact ?? ""}</span>
      </>
    )
  },
  { key: "relationships", header: "関係数", render: (party) => party.relationships.length }
];

export function PartyWorkspace({
  query,
  setQuery,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  items,
  lands,
  buildings,
  selectedId,
  selected,
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
  onSaveRelationship,
  onDeleteRelationship,
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
  items: Party[];
  lands: Land[];
  buildings: Building[];
  selectedId: string | null;
  selected: Party | null;
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
  onSave: (values: PartyFormValues) => void;
  onDelete: () => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  // フォーム初期値はサーバ状態 (selected) から直接導出する。編集対象の切り替えは
  // PartyForm の key で検知され、バックグラウンド再取得では編集中の値を上書きしない。
  const formValues: PartyFormValues = creating ? newPartyDraft() : selected ? toPartyDraft(selected) : newPartyDraft();
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, items.map((party) => party.partyType), formValues.partyType);
  const relationChoices = relationshipTypeChoices(items, lands, buildings);
  return (
    <div className={`object-workspace${detailOpen ? " detail-mode" : " list-mode"}`}>
      {!detailOpen ? (
      <ObjectSidebar
        title="関係者"
        query={query}
        setQuery={setQuery}
        loading={loading}
        onRefresh={onRefresh}
        onSearch={onSearch}
        onCreate={onCreate}
        filterContent={
          <BusinessFilterPanel
            kind="party"
            filters={filters}
            setFilters={setFilters}
            open={filtersOpen}
            setOpen={setFiltersOpen}
            layers={[]}
            selectedFeature={null}
            selectedFeatureLayer={null}
            partyTypeOptions={partyTypeChoices}
            relationTypeOptions={relationChoices}
          />
        }
        selectedProject={selectedProject}
        projects={projects}
        onProjectChange={onProjectChange}
      >
        <DataTable
          columns={partyColumns}
          rows={items}
          rowKey={(party) => party.id}
          onRowClick={(party) => onSelect(party.id)}
          selectedRowKey={selectedId}
          emptyMessage="関係者はありません"
          pageSize={50}
        />
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <PartyForm
              key={creating ? "new-party" : selected?.id}
              creating={creating}
              defaultValues={formValues}
              partyTypeOptions={partyTypeChoices}
              detailHref={selected ? `/parties/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
              onSubmit={onSave}
            />
            {selected ? (
              <RelationshipEditor
                relationships={selected.relationships}
                parties={items}
                lands={lands}
                buildings={buildings}
                fixedPartyId={selected.id}
                onOpenParty={onSelect}
                onOpenLand={onOpenLand}
                onOpenBuilding={onOpenBuilding}
                onSave={onSaveRelationship}
                onDelete={onDeleteRelationship}
                relationOptions={relationChoices}
              />
            ) : null}
            <ObjectActions
              saving={saving}
              deleting={deleting}
              formId={partyFormId}
              onDelete={onDelete}
              onCancel={onCancelCreate}
              creating={creating}
            />
          </>
        ) : (
          <p className="empty-state">関係者を読み込み中です</p>
        )}
      </section>
      ) : null}
    </div>
  );
}
