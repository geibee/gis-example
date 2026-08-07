import { useEffect, useMemo, useState } from "react";
import { Camera, MessageSquarePlus, X } from "lucide-react";
import { useAppShell } from "../appShell";
import { notifyError, notifySuccess } from "../notifications";
import { useCreateFeedbackThreadMutation, useFeedbackThreadsQuery } from "../queries/feedbackThreads";
import { useReviewSessionsQuery } from "../queries/reviewSessions";
import {
  captureExcludeAttribute,
  feedbackMapAttribute,
  resolveScreenTarget,
  useReview,
  type FeedbackTarget,
  type PickedFeedbackTarget
} from "../review";
import type { ReviewSession } from "../contracts";
import { errorMessage } from "../utils";
import { FeedbackPins } from "./FeedbackPins";

// フィードバックオーバーレイ (docs/prototype-review.md Phase 2〜3)。
//
// 業務画面側に個別実装を入れず、どの画面からでも「対象箇所をクリック → 観点を選ぶ →
// コメントを書く」でコンテキスト付きの指摘を残せるようにする。
// 証跡は投稿ボタンを押した時点ではなく「対象をクリックした瞬間」に固定化する
// (入力パネルを開いてから撮ると、パネルに隠れた画面が証跡に残らないため)。

export function FeedbackOverlay() {
  const { selectedProject } = useAppShell();
  // 受付中のセッションがないときはレビュー機能自体を出さない
  const sessionsQuery = useReviewSessionsQuery(selectedProject, "open");
  const session = sessionsQuery.data?.[0] ?? null;
  const threadsQuery = useFeedbackThreadsQuery(session?.id ?? null);
  const { mode, picked, startPicking, selectTarget, reset } = useReview();

  useEffect(() => {
    if (!session && mode !== "idle") reset();
  }, [mode, reset, session]);

  // レビューモード中の最初のクリックをコメント対象の指定として横取りする。
  // capture フェーズで止めるので、業務画面側のハンドラは実行されない
  useEffect(() => {
    if (mode !== "picking" && mode !== "capturing") return;
    const onClick = (event: MouseEvent) => {
      if (mode !== "picking") return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest(`[${captureExcludeAttribute}]`)) return;
      // MapLibre は Canvas 1 枚なので、地図アダプタ側で地物 / 地点として解決する。
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

  if (!session) return null;

  return (
    <>
      {mode === "idle" ? (
        <>
          <FeedbackPins threads={threadsQuery.data ?? []} />
          <button
            type="button"
            className="feedback-launcher"
            {...{ [captureExcludeAttribute]: "" }}
            onClick={startPicking}
          >
            <MessageSquarePlus size={16} />
            フィードバック
          </button>
        </>
      ) : null}

      {mode === "picking" || mode === "capturing" ? (
        <div className="feedback-picking-bar" role="status" {...{ [captureExcludeAttribute]: "" }}>
          <span>
            {mode === "capturing"
              ? "投稿時点の画面を取得しています…"
              : "コメントしたい箇所をクリックしてください"}
          </span>
          <button type="button" className="subtle-button" onClick={reset}>
            <X size={14} />
            キャンセル
          </button>
        </div>
      ) : null}

      {mode === "composing" && picked ? (
        <FeedbackComposer session={session} picked={picked} onClose={reset} />
      ) : null}
    </>
  );
}

type FeedbackComposerProps = {
  session: ReviewSession;
  picked: PickedFeedbackTarget;
  onClose: () => void;
};

function FeedbackComposer({ session, picked, onClose }: FeedbackComposerProps) {
  // 選べるのは今回 ACTIVE の観点だけ (FUTURE / OUT_OF_SCOPE はガイドで見せる)
  const activePerspectives = useMemo(
    () => session.perspectives.filter((perspective) => perspective.status === "ACTIVE"),
    [session.perspectives]
  );
  const [perspectiveCode, setPerspectiveCode] = useState(activePerspectives[0]?.code ?? "");
  const [body, setBody] = useState("");
  const createThread = useCreateFeedbackThreadMutation();

  const previewUrl = useMemo(() => {
    const blob = picked.evidence?.blob;
    // jsdom など createObjectURL の無い環境ではプレビューを出さない (投稿自体は成立する)
    if (!blob || typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(blob);
  }, [picked.evidence]);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || !perspectiveCode) return;
    const evidence = picked.evidence;
    try {
      await createThread.mutateAsync({
        reviewSessionId: session.id,
        metadata: {
          perspectiveCode,
          body: trimmed,
          targetType: picked.target.type,
          target: picked.target as unknown as Record<string, never>,
          pageId: window.location.pathname,
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
      notifySuccess("フィードバックを投稿しました");
      onClose();
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  return (
    <div className="feedback-composer" role="dialog" aria-label="フィードバックの投稿" {...{ [captureExcludeAttribute]: "" }}>
      <div className="panel-header">
        <h2>フィードバック</h2>
        <button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <p className="feedback-target-summary">
        対象: <code>{describeTarget(picked.target)}</code>
      </p>

      {picked.evidence ? (
        <div className="feedback-evidence">
          <p className="review-guide-note">
            <Camera size={13} aria-hidden="true" /> 投稿時点の画面を証跡として保存します (
            {picked.evidence.viewportWidth}×{picked.evidence.viewportHeight})
          </p>
          {previewUrl ? <img src={previewUrl} alt="証跡プレビュー" /> : null}
        </div>
      ) : (
        <p className="notice error" role="alert">
          証跡の取得に失敗しました ({picked.captureError ?? "原因不明"})。コメントのみ投稿します。
        </p>
      )}

      <fieldset className="feedback-perspectives">
        <legend>レビュー観点</legend>
        {activePerspectives.map((perspective) => (
          <label key={perspective.code} className="feedback-perspective-choice">
            <input
              type="radio"
              name="perspective"
              value={perspective.code}
              checked={perspectiveCode === perspective.code}
              onChange={() => setPerspectiveCode(perspective.code)}
            />
            {perspective.label}
          </label>
        ))}
      </fieldset>

      <label className="feedback-body-field">
        コメント
        <textarea
          rows={5}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="気づいた点をご記入ください"
        />
      </label>

      <div className="button-row">
        <button type="button" className="subtle-button" onClick={onClose}>
          キャンセル
        </button>
        <button
          type="button"
          className="command-button"
          disabled={!body.trim() || !perspectiveCode || createThread.isPending}
          onClick={() => void submit()}
        >
          {createThread.isPending ? "投稿中..." : "投稿する"}
        </button>
      </div>
    </div>
  );
}

/** 対象を顧客に見える言葉で 1 行に要約する */
function describeTarget(target: FeedbackTarget): string {
  switch (target.type) {
    case "UI_ELEMENT":
      return target.feedbackTargetId;
    case "SCREEN_POSITION":
      return `画面上の位置 (${target.relativeX}, ${target.relativeY})`;
    case "MAP_FEATURE":
      return `地物 ${target.source}/${target.featureId}`;
    case "MAP_POSITION":
      return `地図上の地点 (${target.longitude.toFixed(5)}, ${target.latitude.toFixed(5)})`;
  }
}
