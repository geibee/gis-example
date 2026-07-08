import { lazy, Suspense } from "react";
import { useAppShell } from "../appShell";
import { useMapState } from "../mapState";

// 地図ペイン (maplibre-gl を含む) はメインチャンクとは別チャンクとして遅延ロードする
const MapPane = lazy(() => import("./MapPane"));

// MapPane への配線を App から切り出したホスト。props はすべて AppShell / MapState
// コンテキストから供給し、App 側のバケツリレーをなくす。
export function MapPaneHost() {
  const { mapSupportOpen, setMapSupportOpen, setNotice } = useAppShell();
  const map = useMapState();

  return (
    <Suspense fallback={<aside className={`map-support-pane${mapSupportOpen ? "" : " closed"}`} />}>
      <MapPane
        apiRef={map.mapApiRef}
        onReadyChange={map.setMapReady}
        layers={map.layers}
        mapHighlightResults={map.mapHighlightResults}
        layerById={map.layerById}
        onPickFeature={map.handleMapFeatureClick}
        onNotice={setNotice}
        open={mapSupportOpen}
        onToggle={() => setMapSupportOpen((open) => !open)}
        baseMapVisible={map.baseMapVisible}
        setBaseMapVisible={map.setBaseMapVisible}
        layerListItems={map.layerListItems}
        visibleLayerIds={map.visibleLayerIds}
        loadingLayers={map.loadingLayers}
        deletingLayerIds={map.deletingLayerIds}
        deletingResultSetIds={map.deletingResultSetIds}
        draggingLayerId={map.draggingLayerId}
        onRefreshLayers={map.refetchLayers}
        onToggleLayer={map.toggleLayer}
        onToggleLayerGroup={map.toggleLayerGroup}
        onRequestLayerDelete={(layer) => void map.requestLayerDelete(layer)}
        onRequestResultSetDelete={(resultSet) => void map.requestResultSetDelete(resultSet)}
        onDragLayerStart={map.startLayerDrag}
        onDragLayerOver={map.dragLayerOver}
        onDropLayer={map.dropLayer}
        onDragLayerEnd={() => map.setDraggingLayerId(null)}
        selectedFeature={map.selectedFeature}
        selectedFeatureLayer={map.selectedFeatureLayer}
        businessLinks={map.businessLinks}
        loadingBusinessLinks={map.loadingBusinessLinks}
        featureEditOpen={map.featureEditOpen}
        setFeatureEditOpen={map.setFeatureEditOpen}
        featurePropertyDraft={map.featurePropertyDraft}
        setFeaturePropertyDraft={map.setFeaturePropertyDraft}
        featureGeometryDraft={map.featureGeometryDraft}
        setFeatureGeometryDraft={map.setFeatureGeometryDraft}
        savingFeature={map.savingFeature}
        onSaveFeature={() => void map.saveSelectedFeature()}
      />
    </Suspense>
  );
}
