import { useEffect, useMemo, useState } from "react";
import type { FeedbackThread } from "./contracts";
import { useFeedbackPluginContext } from "./plugin-context";
import { useFeedbackState } from "./state";
import { parseFeedbackTarget } from "./target";
import { feedbackThreadMatchesPath } from "./thread-route";
import { feedbackTargetAttribute, type FeedbackTarget } from "./types";

type PinPosition = { thread: FeedbackThread; x: number; y: number };

export function FeedbackPins({ threads }: { threads: FeedbackThread[] }) {
  const { openThread } = useFeedbackState();
  const { currentPath } = useFeedbackPluginContext();
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setLayoutVersion((version) => version + 1);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("popstate", refresh);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("popstate", refresh);
    };
  }, []);

  const pins = useMemo(
    () => threads.flatMap((thread) => {
      if (!feedbackThreadMatchesPath(thread, currentPath)) return [];
      const target = parseFeedbackTarget(thread.targetMetadata);
      if (!target || target.type === "MAP_FEATURE" || target.type === "MAP_POSITION") return [];
      const position = screenPinPosition(thread, target, currentPath);
      return position ? [{ thread, ...position }] : [];
    }),
    // layoutVersion triggers DOM geometry reads after scroll / resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentPath, layoutVersion, threads]
  );
  return (
    <div className="wfg-feedback-screen-pins">
      {pins.map((pin) => (
        <button
          type="button"
          className={`wfg-feedback-pin${pin.thread.status === "RESOLVED" ? " is-resolved" : ""}`}
          style={{ left: pin.x, top: pin.y }}
          aria-label={threadLabel(pin.thread)}
          key={pin.thread.id}
          onClick={() => openThread(pin.thread.id)}
        >
          <span>{pin.thread.displayNumber}</span>
        </button>
      ))}
    </div>
  );
}

function screenPinPosition(
  thread: FeedbackThread,
  target: Extract<FeedbackTarget, { type: "UI_ELEMENT" | "SCREEN_POSITION" }>,
  pathname: string
): { x: number; y: number } | null {
  const evidencePath = thread.evidence ? pathOf(thread.evidence.route) : null;
  const stored = {
    x: target.relativeX * document.documentElement.clientWidth,
    y: target.relativeY * document.documentElement.clientHeight
  };
  if (target.type === "SCREEN_POSITION") return evidencePath === pathname ? stored : null;
  const owner = findFeedbackOwner(target.feedbackTargetId);
  if (!owner) return null;
  const rect = owner.getBoundingClientRect();
  const storedInside = stored.x >= rect.left && stored.x <= rect.right && stored.y >= rect.top && stored.y <= rect.bottom;
  return storedInside
    ? stored
    : { x: rect.left + Math.min(rect.width, 18), y: rect.top + Math.min(rect.height, 18) };
}

function findFeedbackOwner(id: string): Element | null {
  return Array.from(document.querySelectorAll(`[${feedbackTargetAttribute}]`)).find(
    (element) => element.getAttribute(feedbackTargetAttribute) === id
  ) ?? null;
}

function pathOf(route: string): string | null {
  try { return new URL(route, window.location.origin).pathname; } catch { return null; }
}

function threadLabel(thread: FeedbackThread): string {
  const body = thread.messages[0]?.body ?? "コメント";
  return `${thread.perspectiveLabel}: ${body}${thread.status === "RESOLVED" ? " (解決済み)" : ""}`;
}
