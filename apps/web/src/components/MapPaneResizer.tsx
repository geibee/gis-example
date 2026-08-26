import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export const mapPaneMinWidth = 320;
const workspaceMinWidth = 320;
const resizerWidth = 8;
const keyboardResizeStep = 32;

function clampWidth(width: number, maximum: number) {
  return Math.min(Math.max(width, mapPaneMinWidth), maximum);
}

export function MapPaneResizer({
  open,
  fullscreen,
  width,
  onWidthChange
}: {
  open: boolean;
  fullscreen: boolean;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const activePointerId = useRef<number | null>(null);

  const maximumWidth = (element: HTMLDivElement) => {
    const workspaceWidth = element.parentElement?.getBoundingClientRect().width || window.innerWidth;
    return Math.max(mapPaneMinWidth, workspaceWidth - workspaceMinWidth - resizerWidth);
  };

  const widthFromPointer = (element: HTMLDivElement, clientX: number) => {
    const workspaceRect = element.parentElement?.getBoundingClientRect();
    const workspaceRight = workspaceRect?.right || window.innerWidth;
    return clampWidth(workspaceRight - clientX, maximumWidth(element));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    activePointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onWidthChange(widthFromPointer(event.currentTarget, event.clientX));
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    onWidthChange(widthFromPointer(event.currentTarget, event.clientX));
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
    const maximum = maximumWidth(event.currentTarget);
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = width + keyboardResizeStep;
    if (event.key === "ArrowRight") nextWidth = width - keyboardResizeStep;
    if (event.key === "Home") nextWidth = mapPaneMinWidth;
    if (event.key === "End") nextWidth = maximum;
    if (nextWidth === null) return;
    onWidthChange(clampWidth(nextWidth, maximum));
    event.preventDefault();
  };

  const maximum = Math.max(mapPaneMinWidth, window.innerWidth - workspaceMinWidth - resizerWidth);
  const accessibleWidth = clampWidth(width, maximum);

  return (
    <div
      className={`map-pane-resizer${open && !fullscreen ? "" : " hidden"}`}
      role="separator"
      aria-label="地図ペインの幅を変更"
      aria-orientation="vertical"
      aria-valuemin={mapPaneMinWidth}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(accessibleWidth)}
      aria-valuetext={`${Math.round(accessibleWidth)}ピクセル`}
      tabIndex={open && !fullscreen ? 0 : -1}
      title="左右にドラッグして地図の幅を変更"
      onKeyDown={handleKeyDown}
      onPointerCancel={finishPointerResize}
      onPointerDown={handlePointerDown}
      onLostPointerCapture={finishPointerResize}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerResize}
    />
  );
}
