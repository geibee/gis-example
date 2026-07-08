import { useAppState } from "../appState";
import { PartyWorkspace } from "../components/PartyWorkspace";

// 関係者画面: App の state/handler (AppStateContext) を既存 Workspace へ渡す薄いラッパ
export default function PartiesScreen() {
  const app = useAppState();
  return (
    <section className="tab-pane active">
      <PartyWorkspace
        query={app.partyQuery}
        setQuery={app.setPartyQuery}
        filters={app.partyFilters}
        setFilters={app.setPartyFilters}
        filtersOpen={app.partyFiltersOpen}
        setFiltersOpen={app.setPartyFiltersOpen}
        items={app.parties}
        lands={app.lands}
        buildings={app.buildings}
        selectedId={app.selectedPartyId}
        selected={app.selectedParty}
        draft={app.partyDraft}
        setDraft={app.setPartyDraft}
        creating={app.creatingParty}
        loading={app.loadingParties}
        saving={app.savingParty}
        deleting={app.deletingParty}
        onRefresh={() => void app.refreshParties()}
        onSearch={app.submitPartyListSearch}
        onSelect={app.selectParty}
        onCreate={app.beginCreateParty}
        onCancelCreate={app.cancelCreateParty}
        onBackToList={() => app.navigateTab("parties")}
        onSave={() => void app.saveParty()}
        onDelete={() => void app.removeParty()}
        onOpenLand={app.selectLand}
        onOpenBuilding={app.selectBuilding}
        onSaveRelationship={(relationshipId, relationshipDraft) => void app.saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void app.removeRelationship(relationshipId)}
        selectedProject={app.selectedProject}
        projects={app.projects}
        onProjectChange={app.setSelectedProject}
      />
    </section>
  );
}
