import { useEffect } from "react";
import maplibregl, { type Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";
import type { FeedbackThread, Layer } from "../contracts";
import { captureExcludeAttribute, parseFeedbackTarget, resolveMapTarget, useReview } from "../review";

type FeedbackMapAdapterProps = {
  map: MapLibreMap;
  layers: Layer[];
  styleLayersByLayerId: Readonly<Record<string, string[]>>;
  threads: FeedbackThread[];
};

/** MapLibre の WebGL クリック対象解決と、経緯度ベースのコメントピン描画を受け持つ。 */
export function FeedbackMapAdapter({ map, layers, styleLayersByLayerId, threads }: FeedbackMapAdapterProps) {
  const { mode, selectTarget, openThread } = useReview();

  useEffect(() => {
    if (mode !== "picking") return;
    const handleReviewClick = (event: MapMouseEvent) => {
      const queryLayerIds = Object.values(styleLayersByLayerId)
        .flat()
        .filter((id) => Boolean(map.getLayer(id)));
      const featureIdPropertyBySource = Object.fromEntries(
        layers.map((layer) => [layer.id, layer.featureIdColumn])
      );
      event.preventDefault();
      void selectTarget(
        resolveMapTarget(map, event, {
          layers: queryLayerIds,
          featureIdPropertyBySource
        })
      );
    };
    map.on("click", handleReviewClick);
    return () => {
      map.off("click", handleReviewClick);
    };
  }, [layers, map, mode, selectTarget, styleLayersByLayerId]);

  useEffect(() => {
    const markers = threads.flatMap((thread, index) => {
      const target = parseFeedbackTarget(thread.targetMetadata);
      if (!target || (target.type !== "MAP_FEATURE" && target.type !== "MAP_POSITION")) return [];

      const element = document.createElement("button");
      element.type = "button";
      element.className = `feedback-map-pin${thread.status === "RESOLVED" ? " resolved" : ""}`;
      const number = document.createElement("span");
      number.textContent = String(index + 1);
      element.append(number);
      element.setAttribute(captureExcludeAttribute, "");
      element.setAttribute("aria-label", threadLabel(thread));
      // ピンを開く操作を、背後にある地物選択として扱わない。
      element.addEventListener("click", (event) => event.stopPropagation());

      const content = document.createElement("div");
      content.className = "feedback-map-popover";
      content.setAttribute(captureExcludeAttribute, "");
      const heading = document.createElement("strong");
      heading.textContent = thread.perspectiveLabel;
      const body = document.createElement("p");
      body.textContent = thread.messages[0]?.body ?? "コメント本文はありません";
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "subtle-button feedback-thread-open";
      openButton.textContent = "スレッドを開く";
      openButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openThread(thread.id);
      });
      content.append(heading, body, openButton);

      const popup = new maplibregl.Popup({ closeOnClick: false, offset: 18 }).setDOMContent(content);
      const marker = new maplibregl.Marker({ element, anchor: "bottom" })
        .setLngLat([target.longitude, target.latitude])
        .setPopup(popup)
        .addTo(map);
      return [marker];
    });
    return () => {
      markers.forEach((marker) => marker.remove());
    };
  }, [map, openThread, threads]);

  return null;
}

function threadLabel(thread: FeedbackThread): string {
  return `${thread.perspectiveLabel}: ${thread.messages[0]?.body ?? "コメント"}`;
}
