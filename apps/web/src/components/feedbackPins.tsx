import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MessageSquare, X } from "lucide-react";
import { useAppShell } from "../appShell";
import { getFeedbackEvidenceBlob } from "../api";
import { useFeedbackThreadsQuery } from "../queries/feedbackThreads";
import { useReviewSessionsQuery } from "../queries/reviewSessions";
import { captureExcludeAttribute, useReviewMode } from "../review";
import type { FeedbackThread } from "../contracts";
import { errorMessage } from "../utils";
import type { FeedbackMapPin } from "./MapPane";

// コメントピン (docs/prototype-review.md Phase 3)。
//
// 「どこへの指摘か」を一覧の文章ではなく画面上の位置で見せる。ピンは 2 系統ある:
//   - 画面ピン: UI_ELEMENT / SCREEN_POSITION。投稿元の画面 (pageId) が今の画面と
//     一致するものだけを、ビューポート相対座標に置く
//   - 地図ピン: MAP_FEATURE / MAP_POSITION。経緯度で MapLibre の Marker として置く
//     (画面が違っても地図上にあるので、pageId では絞らない)

/** 受付中のレビューセッションと、そのスレッド */
function useOpenSessionThreads() {
  const { selectedProject } = useAppShell();
  const sessionsQuery = useReviewSessionsQuery(selectedProject, "open");
  const session = sessionsQuery.data?.[0] ?? null;
  const threadsQuery = useFeedbackThreadsQuery(session?.id ?? null);
  return { session, threads: useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]) };
}

const screenTargetTypes = new Set(["UI_ELEMENT", "SCREEN_POSITION"]);

type ScreenPoint = { relativeX: number; relativeY: number };

function screenPointOf(thread: FeedbackThread): ScreenPoint | null {
  if (!screenTargetTypes.has(thread.targetType)) return null;
  const target = thread.targetMetadata as { relativeX?: unknown; relativeY?: unknown };
  if (typeof target.relativeX !== "number" || typeof target.relativeY !== "number") return null;
  return { relativeX: target.relativeX, relativeY: target.relativeY };
}

function mapPointOf(thread: FeedbackThread): { longitude: number; latitude: number } | null {
  if (thread.targetType !== "MAP_FEATURE" && thread.targetType !== "MAP_POSITION") return null;
  const target = thread.targetMetadata as { longitude?: unknown; latitude?: unknown };
  if (typeof target.longitude !== "number" || typeof target.latitude !== "number") return null;
  return { longitude: target.longitude, latitude: target.latitude };
}

/** 地図ペインへ渡すピン (MapPaneHost が使う) */
export function useFeedbackMapPins(): { mapPins: FeedbackMapPin[]; selectPin: (threadId: string) => void } {
  const { pinsVisible, selectThread } = useReviewMode();
  const { threads } = useOpenSessionThreads();

  const mapPins = useMemo<FeedbackMapPin[]>(() => {
    if (!pinsVisible) return [];
    return threads.flatMap((thread) => {
      const point = mapPointOf(thread);
      if (!point) return [];
      return [{ threadId: thread.id, ...point, resolved: thread.status === "RESOLVED" }];
    });
  }, [pinsVisible, threads]);

  return { mapPins, selectPin: selectThread };
}

/** 画面上のコメントピンと、開いているスレッドの内容 */
export function FeedbackPins() {
  const { pinsVisible, selectedThreadId, selectThread } = useReviewMode();
  const { threads } = useOpenSessionThreads();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const screenPins = useMemo(
    () =>
      threads.flatMap((thread) => {
        if (thread.pageId && thread.pageId !== pathname) return [];
        const point = screenPointOf(thread);
        return point ? [{ thread, point }] : [];
      }),
    [pathname, threads]
  );

  const selected = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  if (!pinsVisible) return null;

  return (
    <>
      {screenPins.map(({ thread, point }) => (
        <button
          key={thread.id}
          type="button"
          className={`feedback-screen-pin${thread.status === "RESOLVED" ? " resolved" : ""}`}
          style={{ left: `${point.relativeX * 100}%`, top: `${point.relativeY * 100}%` }}
          aria-label={`コメント: ${thread.messages[0]?.body ?? thread.perspectiveLabel}`}
          {...{ [captureExcludeAttribute]: "" }}
          onClick={() => selectThread(thread.id)}
        >
          <MessageSquare size={13} aria-hidden="true" />
        </button>
      ))}
      {selected ? <FeedbackThreadCard thread={selected} onClose={() => selectThread(null)} /> : null}
    </>
  );
}

function FeedbackThreadCard({ thread, onClose }: { thread: FeedbackThread; onClose: () => void }) {
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const loadEvidence = useCallback(async () => {
    try {
      const blob = await getFeedbackEvidenceBlob(thread.id);
      if (typeof URL.createObjectURL !== "function") return;
      setEvidenceUrl(URL.createObjectURL(blob));
    } catch (error) {
      setEvidenceError(errorMessage(error));
    }
  }, [thread.id]);

  useEffect(() => {
    setEvidenceUrl(null);
    setEvidenceError(null);
  }, [thread.id]);

  useEffect(() => {
    if (!evidenceUrl) return;
    return () => URL.revokeObjectURL(evidenceUrl);
  }, [evidenceUrl]);

  return (
    <aside className="feedback-thread-card" role="dialog" aria-label="コメントの内容" {...{ [captureExcludeAttribute]: "" }}>
      <div className="panel-header">
        <h2>{thread.perspectiveLabel}</h2>
        <button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p className="feedback-thread-meta">
        {thread.createdByName ?? "不明"} · {new Date(thread.createdAt).toLocaleString("ja-JP")} ·{" "}
        {thread.status === "RESOLVED" ? "解決済み" : "未解決"}
      </p>
      {thread.messages.map((message) => (
        <p key={message.id} className="feedback-thread-body">
          {message.body}
        </p>
      ))}
      {thread.evidence ? (
        <div className="feedback-evidence">
          {evidenceUrl ? (
            <img src={evidenceUrl} alt="投稿時点の証跡" />
          ) : (
            <button type="button" className="subtle-button" onClick={() => void loadEvidence()}>
              投稿時点の画面を見る
            </button>
          )}
          {evidenceError ? (
            <p className="notice error" role="alert">
              {evidenceError}
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
