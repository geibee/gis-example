import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ReviewSession } from "./contracts";
import { useDismissiblePanel } from "./dismiss";
import { FeedbackPins } from "./FeedbackPins";
import { FeedbackThreadDrawer } from "./FeedbackThreadDrawer";
import { ReviewSessionIntroduction } from "./ReviewSessionIntroduction";
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
  /** レビュー開始案内の既読状態を保存するlocalStorageキー。 */
  reviewIntroductionStorageKey?: string;
  /** 受付中レビューがない場合に管理者へ表示する、新規レビュー作成画面のURL。 */
  reviewManagementUrl?: string;
};

/** 投稿、DOMピン、スレッド閲覧をdocument.body上のPortalとして提供する。 */
export function FeedbackOverlay({
  launcherLabel = "フィードバック",
  reviewIntroductionStorageKey,
  reviewManagementUrl
}: FeedbackOverlayProps) {
  const sessionQuery = useOpenReviewSessionQuery();
  const session = sessionQuery.data ?? null;
  const threadsQuery = useFeedbackThreadsQuery(session?.id ?? null);
  const {
    mode,
    picked,
    activeThreadId,
    contextMenu,
    startPicking,
    selectTarget,
    showContextMenu,
    closeContextMenu,
    closeThread,
    reset
  } = useFeedbackState();

  useEffect(() => {
    if (sessionQuery.isSuccess && !session && mode !== "idle") reset();
  }, [mode, reset, session, sessionQuery.isSuccess]);

  useEffect(() => {
    if (sessionQuery.isSuccess && !session && contextMenu) closeContextMenu();
  }, [closeContextMenu, contextMenu, session, sessionQuery.isSuccess]);

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

  useEffect(() => {
    if (!session || mode !== "idle") return;
    const onContextMenu = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest(`[${captureExcludeAttribute}]`)) return;
      // 地図上ではMapLibreアダプタが地物・緯度経度を解決する。
      if (element?.closest(`[${feedbackMapAttribute}]`)) return;
      event.preventDefault();
      showContextMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        target: resolveScreenTarget(
          { clientX: event.clientX, clientY: event.clientY },
          element,
          { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
        )
      });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, [mode, session, showContextMenu]);

  if (typeof document === "undefined") return null;
  const content = !session ? (
    activeThreadId
      ? <FeedbackThreadDrawer threadId={activeThreadId} onClose={closeThread} />
      : reviewManagementUrl
        ? <ReviewInactiveStatus
            managementUrl={reviewManagementUrl}
            loading={sessionQuery.isPending}
            error={sessionQuery.isError}
            onRetry={() => void sessionQuery.refetch()}
          />
        : null
  ) : (
    <>
      <ReviewSessionIntroduction
        session={session}
        storageKey={reviewIntroductionStorageKey}
        visible={mode === "idle" && !activeThreadId && !contextMenu}
      />
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
      {mode === "idle" && contextMenu ? (
        <FeedbackContextMenu
          clientX={contextMenu.clientX}
          clientY={contextMenu.clientY}
          onClose={closeContextMenu}
          onSelect={() => {
            const target = contextMenu.target;
            startPicking();
            void selectTarget(target);
          }}
        />
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

function ReviewInactiveStatus({
  managementUrl,
  loading,
  error,
  onRetry
}: {
  managementUrl: string;
  loading: boolean;
  error: boolean;
  onRetry(): void;
}) {
  if (loading) {
    return <div className="wfg-feedback-review-status is-loading" role="status"><span className="wfg-feedback-review-status-dot" /><span><strong>レビュー状態を確認中</strong><small>受付中のレビューを探しています</small></span></div>;
  }
  if (error) {
    return <div className="wfg-feedback-review-status is-error" role="status"><span className="wfg-feedback-review-status-dot" /><span><strong>レビュー状態を取得できません</strong><small>Feedback Serviceへの接続を確認してください</small></span><button type="button" onClick={onRetry}>再試行</button></div>;
  }
  return <div className="wfg-feedback-review-status is-inactive" role="status"><span className="wfg-feedback-review-status-dot" /><span><strong>レビューは開始されていません</strong><small>対象画面と観点を設定して受付を開始できます</small></span><a href={managementUrl} target="_blank" rel="noreferrer">レビューを開始</a></div>;
}

function FeedbackContextMenu({
  clientX,
  clientY,
  onClose,
  onSelect
}: {
  clientX: number;
  clientY: number;
  onClose: () => void;
  onSelect: () => void;
}) {
  const menuRef = useDismissiblePanel<HTMLDivElement>(onClose);
  const menuWidth = 220;
  const menuHeight = 48;
  const viewportMargin = 8;
  const left = Math.max(viewportMargin, Math.min(clientX, window.innerWidth - menuWidth - viewportMargin));
  const top = Math.max(viewportMargin, Math.min(clientY, window.innerHeight - menuHeight - viewportMargin));

  return (
    <div
      ref={menuRef}
      className="wfg-feedback-context-menu"
      role="menu"
      aria-label="フィードバックメニュー"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={onSelect}>フィードバックを残す</button>
    </div>
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
  const panelRef = useDismissiblePanel<HTMLElement>(onClose);
  const {
    notify,
    currentPageId,
    participantName,
    saveParticipantName
  } = useFeedbackPluginContext();
  const activePerspectives = useMemo(
    () => session.perspectives.filter((perspective) => perspective.status === "ACTIVE"),
    [session.perspectives]
  );
  const [perspectiveCode, setPerspectiveCode] = useState(activePerspectives[0]?.code ?? "");
  const [participantNameDraft, setParticipantNameDraft] = useState(participantName ?? "");
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

  useEffect(() => {
    setParticipantNameDraft(participantName ?? "");
  }, [participantName]);

  const submit = async () => {
    const trimmed = body.trim();
    const submittedParticipantName = participantNameDraft.trim();
    if (!trimmed || !perspectiveCode || !submittedParticipantName) return;
    setError(null);
    const evidence = picked.evidence;
    try {
      await createThread.mutateAsync({
        reviewSessionId: session.id,
        metadata: {
          perspectiveCode,
          body: trimmed,
          participantName: submittedParticipantName,
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
      saveParticipantName(submittedParticipantName);
      notify({ type: "success", message: "フィードバックを投稿しました" });
      onClose();
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify({ type: "error", message });
    }
  };

  return (
    <section ref={panelRef} className="wfg-feedback-panel wfg-feedback-composer" role="dialog" aria-label="フィードバックの投稿">
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
        投稿者名
        <input
          type="text"
          aria-label="投稿者名"
          autoComplete="name"
          maxLength={100}
          required
          value={participantNameDraft}
          onChange={(event) => setParticipantNameDraft(event.target.value)}
          placeholder="例: 山田 太郎"
        />
        <span className="wfg-feedback-field-help">このブラウザに保存され、次回から自動入力されます。</span>
      </label>
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
          disabled={!body.trim() || !participantNameDraft.trim() || !perspectiveCode || createThread.isPending}
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
