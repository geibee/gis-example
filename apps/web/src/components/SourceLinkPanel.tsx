import { Map as MapIcon } from "lucide-react";
import type { Layer } from "../contracts";

export function SourceLinkPanel({
  layers,
  layerId,
  featureId,
  onOpen
}: {
  layers: Layer[];
  layerId: string;
  featureId: string;
  onOpen: (layerId?: string | null, featureId?: string | null) => void;
}) {
  const layerName = layers.find((layer) => layer.id === layerId)?.name ?? layerId;
  const linked = Boolean(layerId && featureId);
  return (
    <div className="source-link-panel">
      <div>
        <h3>GISリンク</h3>
        <p>{linked ? `${layerName} #${featureId}` : "GIS地物は未設定です"}</p>
      </div>
      <button className="subtle-button" type="button" onClick={() => onOpen(layerId, featureId)} disabled={!linked}>
        <MapIcon size={15} />
        地図で表示
      </button>
    </div>
  );
}
