import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ReviewSession } from "./contracts";
import { FeedbackPins } from "./FeedbackPins";
import { FeedbackThreadDrawer } from "./FeedbackThreadDrawer";
import { useFeedbackPluginContext } from "./plugin-context";
import {
  useCreateFeedbackThreadMutation,
  useFeedbackThreadsQuery,
  useOpenReviewSessionQuery
} from "./queries";
import { useFeedbackState } from "./state";
import { resolveScreenTarget } from "./target";
import {
  captureExcludeAttribute,
  feedbackMapAttribute,
  type FeedbackTarget
} from "./types";

export type FeedbackOverlayProps = {
  launcherLabel?: string;
};

/** 投稿、DOMピン、スレッド閲覧をdocument.body上のPortalとして提供する。 */
export function FeedbackOverlay({ launcherLabel = "フィードバック" }: FeedbackOverlayProps) {
  const sessionQuery = useOpenReviewSessionQuery();
  const session = sessionQuery.data ?? null;
  const threadsQuery = useFeedbackThreadsQuery(session?.id ?? null);
  const { mode, picked, activeThreadId, startPicking, selectTarget, closeThread, reset } = useFeedbackState();

  useEffect(() => {
    if (sessionQuery.isSuccess && !session && mode !== "idle") reset();
  }, [mode, reset, session, sessionQuery.isSuccess]);

  useEffect(() => {
    if (mode !== "picking" && mode !== "capturing") return;
    const onClick = (event: MouseEvent) => {
      if (mode !== "picking") return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest(`[${captureExcludeAttribute}]`)) return;
      if (element?.closest(`[${feedbackMapAttribute}]`)) return;
      event.preventDefault();
      event.stopPropagation();
      void selectTarget(
        resolveScreenTarget(
          { clientX: event.clientX, clientY: event.clientY },
          element,
          { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
        )
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mode, reset, selectTarget]);

  if (typeof document === "undefined") return null;
  const content = !session ? (
    activeThreadId ? <FeedbackThreadDrawer threadId={activeThreadId} onClose={closeThread} /> : null
  ) : (
    <>
      {mode === "idle" ? (
        <>
          <FeedbackPins threads={threadsQuery.data ?? []} />
          <button type="button" className="wfg-feedback-launcher" onClick={startPicking}>
            <span aria-hidden="true">＋</span>
            {launcherLabel}
          </button>
        </>
      ) : null}
      {mode === "picking" || mode === "capturing" ? (
        <div className="wfg-feedback-picking-bar" role="status">
          <span>
            {mode === "capturing"
              ? "投稿時点の画面を取得しています…"
              : "コメントしたい箇所をクリックしてください"}
          </span>
          <button type="button" className="wfg-feedback-button-secondary" onClick={reset}>
            キャンセル
          </button>
        </div>
      ) : null}
      {mode === "composing" && picked ? (
        <FeedbackComposer session={session} picked={picked} onClose={reset} />
      ) : null}
      {mode === "idle" && activeThreadId ? (
        <FeedbackThreadDrawer threadId={activeThreadId} onClose={closeThread} />
      ) : null}
    </>
  );

  return createPortal(
    <div className="wfg-feedback-root" {...{ [captureExcludeAttribute]: "" }}>
      {content}
    </div>,
    document.body
  );
}

function FeedbackComposer({
  session,
  picked,
  onClose
}: {
  session: ReviewSession;
  picked: ReturnType<typeof useFeedbackState>["picked"] & {};
  onClose: () => void;
}) {
  const { notify, currentPageId } = useFeedbackPluginContext();
  const activePerspectives = useMemo(
    () => session.perspectives.filter((perspective) => perspective.status === "ACTIVE"),
    [session.perspectives]
  );
  const [perspectiveCode, setPerspectiveCode] = useState(activePerspectives[0]?.code ?? "");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createThread = useCreateFeedbackThreadMutation();
  const previewUrl = useMemo(() => {
    const blob = picked.evidence?.blob;
    return blob && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  }, [picked.evidence]);

  useEffect(() => {
    if (previewUrl) return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || !perspectiveCode) return;
    setError(null);
    const evidence = picked.evidence;
    try {
      await createThread.mutateAsync({
        reviewSessionId: session.id,
        metadata: {
          perspectiveCode,
          body: trimmed,
          targetType: picked.target.type,
          target: picked.target as unknown as Record<string, unknown>,
          pageId: currentPageId ?? null,
          route: evidence?.route ?? `${window.location.pathname}${window.location.search}`,
          viewportWidth: evidence?.viewportWidth ?? null,
          viewportHeight: evidence?.viewportHeight ?? null,
          scrollX: evidence?.scrollX ?? null,
          scrollY: evidence?.scrollY ?? null,
          pixelRatio: evidence?.pixelRatio ?? null,
          frontendVersion: evidence?.frontendVersion ?? null,
          capturedAt: evidence?.capturedAt ?? null
        },
        screenshot: evidence?.blob ?? null
      });
      notify({ type: "success", message: "フィードバックを投稿しました" });
      onClose();
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify({ type: "error", message });
    }
  };

  return (
    <section className="wfg-feedback-panel wfg-feedback-composer" role="dialog" aria-label="フィードバックの投稿">
      <PanelHeader title="フィードバック" onClose={onClose} closeLabel="投稿画面を閉じる" />
      <p className="wfg-feedback-target-summary">
        対象: <code>{describeTarget(picked.target)}</code>
      </p>
      {picked.evidence ? (
        <div className="wfg-feedback-evidence">
          <p>
            投稿時点の画面を証跡として保存します（{picked.evidence.viewportWidth}×
            {picked.evidence.viewportHeight}）
          </p>
          {previewUrl ? <img src={previewUrl} alt="証跡プレビュー" /> : null}
        </div>
      ) : (
        <p className="wfg-feedback-error" role="alert">
          証跡の取得に失敗しました（{picked.captureError ?? "原因不明"}）。コメントのみ投稿します。
        </p>
      )}
      {error ? <p className="wfg-feedback-error" role="alert">{error}</p> : null}
      <fieldset className="wfg-feedback-perspectives">
        <legend>レビュー観点</legend>
        {activePerspectives.map((perspective) => (
          <label key={perspective.code}>
            <input
              type="radio"
              name="wfg-feedback-perspective"
              value={perspective.code}
              checked={perspectiveCode === perspective.code}
              onChange={() => setPerspectiveCode(perspective.code)}
            />
            {perspective.label}
          </label>
        ))}
      </fieldset>
      <label className="wfg-feedback-field">
        コメント
        <textarea
          rows={5}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="気づいた点をご記入ください"
        />
      </label>
      <div className="wfg-feedback-button-row">
        <button type="button" className="wfg-feedback-button-secondary" onClick={onClose}>キャンセル</button>
        <button
          type="button"
          className="wfg-feedback-button-primary"
          disabled={!body.trim() || !perspectiveCode || createThread.isPending}
          onClick={() => void submit()}
        >
          {createThread.isPending ? "投稿中…" : "投稿する"}
        </button>
      </div>
    </section>
  );
}

export function PanelHeader({
  title,
  onClose,
  closeLabel = "閉じる"
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
}) {
  return (
    <header className="wfg-feedback-panel-header">
      <h2>{title}</h2>
      <button type="button" className="wfg-feedback-icon-button" aria-label={closeLabel} onClick={onClose}>×</button>
    </header>
  );
}

function describeTarget(target: FeedbackTarget): string {
  switch (target.type) {
    case "UI_ELEMENT": return target.feedbackTargetId;
    case "SCREEN_POSITION": return `画面上の位置 (${target.relativeX}, ${target.relativeY})`;
    case "MAP_FEATURE": return `地物 ${target.source}/${target.featureId}`;
    case "MAP_POSITION": return `地図上の地点 (${target.longitude.toFixed(5)}, ${target.latitude.toFixed(5)})`;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
