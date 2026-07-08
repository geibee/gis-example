import type { Building, Land, Party, Project } from "../contracts";
import type { BusinessObjectFilters, PartyDraft, RelationshipDraft } from "../appTypes";
import { partyTypeOptions, relationTypeOptions } from "../constants";
import { mergeChoiceOptions, relationshipTypeChoices } from "../utils";
import { BusinessFilterPanel } from "./BusinessFilterPanel";
import { ChoiceSelect } from "./ChoiceSelect";
import { ObjectActions } from "./ObjectActions";
import { ObjectDetailHeader } from "./ObjectDetailHeader";
import { ObjectSidebar } from "./ObjectSidebar";
import { RelationshipEditor } from "./RelationshipEditor";

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
  draft: PartyDraft;
  setDraft: React.Dispatch<React.SetStateAction<PartyDraft>>;
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
  onSaveRelationship: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDeleteRelationship: (relationshipId: string) => void;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
}) {
  const detailOpen = creating || Boolean(selectedId);
  const hasDetailContent = creating || Boolean(selected);
  const partyTypeChoices = mergeChoiceOptions(partyTypeOptions, items.map((party) => party.partyType), draft.partyType);
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
        <div className="business-table-scroll">
          <table className="business-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>種別</th>
                <th>住所/連絡先</th>
                <th>関係数</th>
              </tr>
            </thead>
            <tbody>
              {items.map((party) => (
                <tr key={party.id} onClick={() => onSelect(party.id)}>
                  <td>{party.id}</td>
                  <td>{party.name}</td>
                  <td>{party.partyType}</td>
                  <td>
                    <strong>{party.address ?? ""}</strong>
                    <span>{party.contact ?? ""}</span>
                  </td>
                  <td>{party.relationships.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length ? <p className="empty-state">関係者はありません</p> : null}
      </ObjectSidebar>
      ) : null}

      {detailOpen ? (
      <section className="object-detail">
        {hasDetailContent ? (
          <>
            <ObjectDetailHeader
              id={creating ? draft.id || "新規関係者" : selected?.id ?? ""}
              title={draft.name || "関係者"}
              subtitle={draft.partyType}
              href={selected ? `/parties/${encodeURIComponent(selected.id)}` : undefined}
              onBack={creating ? onCancelCreate : onBackToList}
            />
            <div className="object-form">
              <label>
                ID
                <input value={draft.id} disabled={!creating} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
              </label>
              <label>
                名称
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label>
                種別
                <ChoiceSelect
                  value={draft.partyType}
                  onChange={(value) => setDraft((current) => ({ ...current, partyType: value }))}
                  options={partyTypeChoices}
                  emptyLabel="選択"
                />
              </label>
              <label>
                連絡先
                <input value={draft.contact} onChange={(event) => setDraft((current) => ({ ...current, contact: event.target.value }))} />
              </label>
              <label className="wide-field">
                住所
                <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
              </label>
              <label className="wide-field">
                タグ
                <input
                  value={draft.tags}
                  placeholder="例: 外国人、競合（読点またはカンマ区切り）"
                  onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                />
              </label>
              <label className="wide-field">
                メモ
                <textarea value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} />
              </label>
            </div>
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
              onSave={onSave}
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
