import { useAppState } from "../appState";
import { BuildingWorkspace } from "../components/BuildingWorkspace";

// 建物画面: App の state/handler (AppStateContext) を既存 Workspace へ渡す薄いラッパ
export default function BuildingsScreen() {
  const app = useAppState();
  return (
    <section className="tab-pane active">
      <BuildingWorkspace
        query={app.buildingQuery}
        setQuery={app.setBuildingQuery}
        filters={app.buildingFilters}
        setFilters={app.setBuildingFilters}
        filtersOpen={app.buildingFiltersOpen}
        setFiltersOpen={app.setBuildingFiltersOpen}
        items={app.buildings}
        lands={app.lands}
        selectedId={app.selectedBuildingId}
        selected={app.selectedBuilding}
        draft={app.buildingDraft}
        setDraft={app.setBuildingDraft}
        creating={app.creatingBuilding}
        loading={app.loadingBuildings}
        saving={app.savingBuilding}
        deleting={app.deletingBuilding}
        onRefresh={() => void app.refreshBuildings()}
        onSearch={app.submitBuildingListSearch}
        onSelect={app.selectBuilding}
        onCreate={app.beginCreateBuilding}
        onCancelCreate={app.cancelCreateBuilding}
        onBackToList={() => app.navigateTab("buildings")}
        onSave={() => void app.saveBuilding()}
        onDelete={() => void app.removeBuilding()}
        onOpenLand={app.selectLand}
        onOpenParty={app.selectParty}
        onSaveRelationship={(relationshipId, relationshipDraft) => void app.saveRelationship(relationshipId, relationshipDraft)}
        onDeleteRelationship={(relationshipId) => void app.removeRelationship(relationshipId)}
        onUseMapBounds={() => app.useMapBoundsFilter(app.setBuildingFilters)}
        onUseSelectedFeature={() => app.useSelectedFeatureFilter(app.setBuildingFilters)}
        onOpenSourceFeature={(layerId, featureId) => void app.openSourceFeature(layerId, featureId)}
        layers={app.layers}
        parties={app.parties}
        selectedFeature={app.selectedFeature}
        selectedFeatureLayer={app.selectedFeatureLayer}
        selectedProject={app.selectedProject}
        projects={app.projects}
        onProjectChange={app.setSelectedProject}
      />
    </section>
  );
}
