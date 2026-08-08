import { useCallback, useEffect } from "react";
import type { Map as MapLibreMap, MapMouseEvent, Marker } from "maplibre-gl";
import type { FeedbackThread } from "./contracts";
import { useFeedbackThreadsQuery, useOpenReviewSessionQuery } from "./queries";
import { useFeedbackState } from "./state";
import { parseFeedbackTarget, resolveMapTarget } from "./target";
import { captureExcludeAttribute } from "./types";

export type FeedbackMapLayer = {
  id: string;
  featureIdColumn?: string | null;
};

export type FeedbackMapLibreAdapterProps = {
  map: MapLibreMap;
  layers: readonly FeedbackMapLayer[];
  styleLayersByLayerId: Readonly<Record<string, readonly string[]>>;
};

/** MapLibreの地物／地点選択と、経緯度に固定されたスレッドピンを提供する。 */
export function FeedbackMapLibreAdapter({
  map,
  layers,
  styleLayersByLayerId
}: FeedbackMapLibreAdapterProps) {
  const { mode, selectTarget, showContextMenu, openThread } = useFeedbackState();
  const sessionQuery = useOpenReviewSessionQuery();
  const threadsQuery = useFeedbackThreadsQuery(sessionQuery.data?.id ?? null);
  const threads = threadsQuery.data ?? [];

  const resolveTarget = useCallback((event: MapMouseEvent) => {
    const queryLayerIds = Object.values(styleLayersByLayerId)
      .flat()
      .filter((id) => Boolean(map.getLayer(id)));
    const featureIdPropertyBySource = Object.fromEntries(
      layers.flatMap((layer) => layer.featureIdColumn ? [[layer.id, layer.featureIdColumn]] : [])
    );
    return resolveMapTarget(map, event, { layers: queryLayerIds, featureIdPropertyBySource });
  }, [layers, map, styleLayersByLayerId]);

  useEffect(() => {
    if (mode !== "picking") return;
    const handleFeedbackClick = (event: MapMouseEvent) => {
      event.preventDefault();
      void selectTarget(resolveTarget(event));
    };
    map.on("click", handleFeedbackClick);
    return () => {
      map.off("click", handleFeedbackClick);
    };
  }, [map, mode, resolveTarget, selectTarget]);

  useEffect(() => {
    if (mode !== "idle" || !sessionQuery.data) return;
    const handleFeedbackContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      event.originalEvent.preventDefault();
      showContextMenu({
        clientX: event.originalEvent.clientX,
        clientY: event.originalEvent.clientY,
        target: resolveTarget(event)
      });
    };
    map.on("contextmenu", handleFeedbackContextMenu);
    return () => {
      map.off("contextmenu", handleFeedbackContextMenu);
    };
  }, [map, mode, resolveTarget, sessionQuery.data, showContextMenu]);

  useEffect(() => {
    let active = true;
    const markers: Array<{ marker: Marker; element: HTMLButtonElement; onClick: (event: Event) => void }> = [];
    void import("maplibre-gl").then(({ default: maplibregl }) => {
      if (!active) return;
      threads.forEach((thread, index) => {
        const target = parseFeedbackTarget(thread.targetMetadata);
        if (!target || (target.type !== "MAP_FEATURE" && target.type !== "MAP_POSITION")) return;

        const element = document.createElement("button");
        element.type = "button";
        element.className = `wfg-feedback-map-pin${thread.status === "RESOLVED" ? " is-resolved" : ""}`;
        const number = document.createElement("span");
        number.textContent = String(index + 1);
        element.append(number);
        element.setAttribute(captureExcludeAttribute, "");
        element.setAttribute("aria-label", threadLabel(thread));
        const onClick = (event: Event) => {
          event.stopPropagation();
          openThread(thread.id);
        };
        element.addEventListener("click", onClick);

        const marker = new maplibregl.Marker({ element, anchor: "bottom" })
          .setLngLat([target.longitude, target.latitude])
          .addTo(map);
        markers.push({ marker, element, onClick });
      });
    });
    return () => {
      active = false;
      markers.forEach(({ marker, element, onClick }) => {
        element.removeEventListener("click", onClick);
        marker.remove();
      });
    };
  }, [map, openThread, threads]);

  return null;
}

function threadLabel(thread: FeedbackThread): string {
  return `${thread.perspectiveLabel}: ${thread.messages[0]?.body ?? "コメント"}`;
}
