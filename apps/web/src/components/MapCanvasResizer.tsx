import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export const mapCanvasMinHeight = 260;
const detailsMinHeight = 160;
const resizerHeight = 8;
const keyboardResizeStep = 32;

function clampHeight(height: number, maximum: number) {
  return Math.min(Math.max(height, mapCanvasMinHeight), maximum);
}

function resizeBounds(element: HTMLDivElement) {
  const paneRect = element.parentElement?.getBoundingClientRect();
  const mapRect = element.previousElementSibling?.getBoundingClientRect();
  const paneBottom = paneRect && paneRect.height > 0 ? paneRect.bottom : window.innerHeight;
  const mapTop = mapRect && mapRect.height > 0 ? mapRect.top : paneRect?.top ?? 0;
  return {
    mapTop,
    maximum: Math.max(mapCanvasMinHeight, paneBottom - mapTop - detailsMinHeight - resizerHeight)
  };
}

export function MapCanvasResizer({
  open,
  fullscreen,
  height,
  onHeightChange
}: {
  open: boolean;
  fullscreen: boolean;
  height: number;
  onHeightChange: (height: number) => void;
}) {
  const activePointerId = useRef<number | null>(null);

  const heightFromPointer = (element: HTMLDivElement, clientY: number) => {
    const { mapTop, maximum } = resizeBounds(element);
    return clampHeight(clientY - mapTop, maximum);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    activePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onHeightChange(heightFromPointer(event.currentTarget, event.clientY));
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    onHeightChange(heightFromPointer(event.currentTarget, event.clientY));
    event.preventDefault();
  };

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    activePointerId.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { maximum } = resizeBounds(event.currentTarget);
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = height - keyboardResizeStep;
    if (event.key === "ArrowDown") nextHeight = height + keyboardResizeStep;
    if (event.key === "Home") nextHeight = mapCanvasMinHeight;
    if (event.key === "End") nextHeight = maximum;
    if (nextHeight === null) return;
    onHeightChange(clampHeight(nextHeight, maximum));
    event.preventDefault();
  };

  const maximum = Math.max(
    mapCanvasMinHeight,
    window.innerHeight - detailsMinHeight - resizerHeight
  );
  const accessibleHeight = clampHeight(height, maximum);

  return (
    <div
      className={`map-canvas-resizer${open && !fullscreen ? "" : " hidden"}`}
      role="separator"
      aria-label="地図キャンバスの高さを変更"
      aria-orientation="horizontal"
      aria-valuemin={mapCanvasMinHeight}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(accessibleHeight)}
      aria-valuetext={`${Math.round(accessibleHeight)}ピクセル`}
      tabIndex={open && !fullscreen ? 0 : -1}
      title="上下にドラッグして地図の高さを変更"
      onKeyDown={handleKeyDown}
      onPointerCancel={finishPointerResize}
      onPointerDown={handlePointerDown}
      onLostPointerCapture={finishPointerResize}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerResize}
    />
  );
}
