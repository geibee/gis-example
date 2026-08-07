import { useEffect, useMemo, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import type { FeedbackThread } from "../contracts";
import {
  captureExcludeAttribute,
  feedbackTargetAttribute,
  parseFeedbackTarget,
  useReview,
  type FeedbackTarget
} from "../review";

type PinPosition = {
  thread: FeedbackThread;
  x: number;
  y: number;
};

/** 現在の画面に属する UI / 画面座標コメントを、業務 UI の上へピンとして重ねる。 */
export function FeedbackPins({ threads }: { threads: FeedbackThread[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { openThread } = useReview();
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setLayoutVersion((version) => version + 1);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, []);

  const pins = useMemo(
    () =>
      threads.flatMap((thread) => {
        const target = parseFeedbackTarget(thread.targetMetadata);
        if (!target || target.type === "MAP_FEATURE" || target.type === "MAP_POSITION") return [];
        const position = screenPinPosition(thread, target, pathname);
        return position ? [{ thread, ...position }] : [];
      }),
    // layoutVersion intentionally retriggers DOM geometry reads after scroll / resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutVersion, pathname, threads]
  );

  const selected = pins.find((pin) => pin.thread.id === selectedId) ?? null;

  return (
    <div className="feedback-screen-pins" {...{ [captureExcludeAttribute]: "" }}>
      {pins.map((pin, index) => (
        <button
          type="button"
          className={`feedback-pin${pin.thread.status === "RESOLVED" ? " resolved" : ""}`}
          style={{ left: pin.x, top: pin.y }}
          aria-label={threadLabel(pin.thread)}
          aria-pressed={selectedId === pin.thread.id}
          key={pin.thread.id}
          onClick={() => setSelectedId((current) => (current === pin.thread.id ? null : pin.thread.id))}
        >
          <span>{index + 1}</span>
        </button>
      ))}
      {selected ? (
        <FeedbackPinPopover
          pin={selected}
          onOpen={() => {
            setSelectedId(null);
            openThread(selected.thread.id);
          }}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function FeedbackPinPopover({ pin, onOpen, onClose }: { pin: PinPosition; onOpen: () => void; onClose: () => void }) {
  const message = pin.thread.messages[0];
  const left = Math.max(8, Math.min(window.innerWidth - 288, pin.x + 18));
  const top = Math.max(8, Math.min(window.innerHeight - 150, pin.y - 12));
  return (
    <aside className="feedback-pin-popover" style={{ left, top }} aria-label="コメントの概要">
      <div>
        <strong>{pin.thread.perspectiveLabel}</strong>
        <span>{pin.thread.status === "RESOLVED" ? "解決済み" : "未解決"}</span>
      </div>
      <p>{message?.body ?? "コメント本文はありません"}</p>
      <button type="button" className="subtle-button feedback-thread-open" onClick={onOpen}>
        スレッドを開く
      </button>
      <button type="button" className="icon-button" aria-label="コメント概要を閉じる" onClick={onClose}>
        ×
      </button>
    </aside>
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
  if (target.type === "SCREEN_POSITION") {
    // 証跡が無ければ画面を特定できず、別画面へ誤表示するためピンを出さない。
    return evidencePath === pathname ? stored : null;
  }

  const owner = findFeedbackOwner(target.feedbackTargetId);
  if (!owner) return null;
  const rect = owner.getBoundingClientRect();
  const storedInside =
    stored.x >= rect.left && stored.x <= rect.right && stored.y >= rect.top && stored.y <= rect.bottom;
  return storedInside
    ? stored
    : { x: rect.left + Math.min(rect.width, 18), y: rect.top + Math.min(rect.height, 18) };
}

function findFeedbackOwner(id: string): Element | null {
  return (
    Array.from(document.querySelectorAll(`[${feedbackTargetAttribute}]`)).find(
      (element) => element.getAttribute(feedbackTargetAttribute) === id
    ) ?? null
  );
}

function pathOf(route: string): string | null {
  try {
    return new URL(route, window.location.origin).pathname;
  } catch {
    return null;
  }
}

function threadLabel(thread: FeedbackThread): string {
  const body = thread.messages[0]?.body ?? "コメント";
  return `${thread.perspectiveLabel}: ${body}${thread.status === "RESOLVED" ? " (解決済み)" : ""}`;
}
