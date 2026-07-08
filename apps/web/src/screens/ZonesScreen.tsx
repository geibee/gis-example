import { useAppState } from "../appState";
import { ZoneSearchPanel } from "../components/ZoneSearchPanel";
import { ZoneWorkspace } from "../components/ZoneWorkspace";

// 区域画面: App の state/handler (AppStateContext) を既存 Workspace へ渡す薄いラッパ
export default function ZonesScreen() {
  const app = useAppState();
  return (
    <section className="tab-pane zone-tab active">
      <ZoneWorkspace
        query={app.zoneQuery}
        setQuery={app.setZoneQuery}
        filters={app.zoneFilters}
        setFilters={app.setZoneFilters}
        filtersOpen={app.zoneFiltersOpen}
        setFiltersOpen={app.setZoneFiltersOpen}
        items={app.zones}
        selectedId={app.selectedZoneId}
        selected={app.selectedZone}
        draft={app.zoneDraft}
        setDraft={app.setZoneDraft}
        creating={app.creatingZone}
        loading={app.loadingZones}
        saving={app.savingZone}
        deleting={app.deletingZone}
        onRefresh={() => void app.refreshZones()}
        onSearch={app.submitZoneListSearch}
        onSelect={app.selectZone}
        onCreate={app.beginCreateZone}
        onCancelCreate={app.cancelCreateZone}
        onBackToList={() => app.navigateTab("zone")}
        onSave={() => void app.saveZone()}
        onDelete={() => void app.removeZone()}
        onOpenLand={app.selectLand}
        onOpenBuilding={app.selectBuilding}
        onOpenParty={app.selectParty}
        onShowOnMap={(zone) => void app.openZoneOnMap(zone)}
        onOpenSourceFeature={(layerId, featureId) => void app.openSourceFeature(layerId, featureId)}
        onUseSelectedFeature={app.applySelectedFeatureToZoneDraft}
        layers={app.layers}
        selectedFeature={app.selectedFeature}
        selectedFeatureLayer={app.selectedFeatureLayer}
        zoneSourceLayerId={app.zoneSourceLayerId}
        setZoneSourceLayerId={app.setZoneSourceLayerId}
        zoneSourceLayers={app.zoneSourceLayers}
        zoneUploadFile={app.zoneUploadFile}
        setZoneUploadFile={app.setZoneUploadFile}
        zoneUploadFormat={app.zoneUploadFormat}
        setZoneUploadFormat={app.setZoneUploadFormat}
        zoneUploadSrid={app.zoneUploadSrid}
        setZoneUploadSrid={app.setZoneUploadSrid}
        creatingZoneLayer={app.creatingZoneLayer}
        onSubmitZoneFromLayer={() => void app.submitZoneFromLayer()}
        onSubmitZoneUpload={() => void app.submitZoneUpload()}
        selectedProject={app.selectedProject}
        projects={app.projects}
        onProjectChange={app.setSelectedProject}
        gisTools={
          <ZoneSearchPanel
            layers={app.layers}
            layerById={app.layerById}
            lands={app.lands}
            buildings={app.buildings}
            parties={app.parties}
            resultName={app.analysisName}
            setResultName={app.setAnalysisName}
            query={app.zoneSearchQuery}
            setQuery={app.setZoneSearchQuery}
            builderOpen={app.conditionBuilderOpen}
            setBuilderOpen={app.setConditionBuilderOpen}
            attributeConditions={app.attributeConditions}
            setAttributeConditions={app.setAttributeConditions}
            spatialConditions={app.spatialConditions}
            setSpatialConditions={app.setSpatialConditions}
            onAddAttribute={app.addAttributeCondition}
            onAddSpatial={app.addSpatialCondition}
            linkedOnly={app.zoneSearchLinkedOnly}
            setLinkedOnly={app.setZoneSearchLinkedOnly}
            spatialLayerIds={app.zoneSpatialLayerIds}
            setSpatialLayerIds={app.setZoneSpatialLayerIds}
            businessSourceType={app.zoneBusinessSourceType}
            setBusinessSourceType={app.setZoneBusinessSourceType}
            businessQuery={app.zoneBusinessQuery}
            setBusinessQuery={app.setZoneBusinessQuery}
            businessStatus={app.zoneBusinessStatus}
            setBusinessStatus={app.setZoneBusinessStatus}
            landUse={app.zoneLandUse}
            setLandUse={app.setZoneLandUse}
            buildingUse={app.zoneBuildingUse}
            setBuildingUse={app.setZoneBuildingUse}
            partyQuery={app.zonePartyQuery}
            setPartyQuery={app.setZonePartyQuery}
            partyType={app.zonePartyType}
            setPartyType={app.setZonePartyType}
            relationType={app.zoneRelationType}
            setRelationType={app.setZoneRelationType}
            loading={app.loadingZoneSearch}
            saving={app.savingConditionSearch}
            results={app.zoneSearchResults}
            selectedFeature={app.selectedFeature}
            onSearch={() => void app.submitZoneSearch()}
            onSave={() => void app.saveConditionSearchResult()}
            onClear={app.clearZoneSearchConditions}
            onSelect={(result) => void app.openZoneSearchResult(result)}
          />
        }
      />
    </section>
  );
}
