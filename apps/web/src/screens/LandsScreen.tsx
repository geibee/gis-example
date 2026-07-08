import { useAppState } from "../appState";
import { LandWorkspace } from "../components/LandWorkspace";

// 土地画面: App の state/handler (AppStateContext) を既存 Workspace へ渡す薄いラッパ
export default function LandsScreen() {
  const app = useAppState();
  return (
    <section className="tab-pane active">
      <LandWorkspace
        query={app.landQuery}
        setQuery={app.setLandQuery}
        filters={app.landFilters}
        setFilters={app.setLandFilters}
        filtersOpen={app.landFiltersOpen}
        setFiltersOpen={app.setLandFiltersOpen}
        items={app.lands}
        selectedId={app.selectedLandId}
        selected={app.selectedLand}
        draft={app.landDraft}
        setDraft={app.setLandDraft}
        creating={app.creatingLand}
        loading={app.loadingLands}
        saving={app.savingLand}
        deleting={app.deletingLand}
        onRefresh={() => void app.refreshLands()}
        onSearch={app.submitLandListSearch}
        onSelect={app.selectLand}
        onCreate={app.beginCreateLand}
        onCancelCreate={app.cancelCreateLand}
        onBackToList={() => app.navigateTab("lands")}
        onSave={() => void app.saveLand()}
        onDelete={() => void app.removeLand()}
        onOpenBuilding={app.selectBuilding}
        onOpenParty={app.selectParty}
        onSaveRelationship={(relationshipId, relationshipDraft) => void app.saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void app.removeRelationship(relationshipId)}
        onUseMapBounds={() => app.useMapBoundsFilter(app.setLandFilters)}
        onUseSelectedFeature={() => app.useSelectedFeatureFilter(app.setLandFilters)}
        onOpenSourceFeature={(layerId, featureId) => void app.openSourceFeature(layerId, featureId)}
        layers={app.layers}
        parties={app.parties}
        buildings={app.buildings}
        selectedFeature={app.selectedFeature}
        selectedFeatureLayer={app.selectedFeatureLayer}
        selectedProject={app.selectedProject}
        projects={app.projects}
        onProjectChange={app.setSelectedProject}
      />
    </section>
  );
}
