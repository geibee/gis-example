import { useEffect, useRef } from "react";

/** パネル外のポインター操作またはEscapeで、一時的なSDK UIを閉じる。 */
export function useDismissiblePanel<T extends HTMLElement>(onDismiss: () => void) {
  const panelRef = useRef<T>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      const target = event.target;
      if (!panel || !(target instanceof Node) || panel.contains(target)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  return panelRef;
}
