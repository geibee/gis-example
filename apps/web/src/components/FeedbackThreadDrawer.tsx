import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, RotateCcw, Send, X } from "lucide-react";
import { useAppShell } from "../appShell";
import type { FeedbackThread } from "../contracts";
import { notifyError, notifySuccess } from "../notifications";
import {
  useCreateFeedbackMessageMutation,
  useFeedbackThreadQuery,
  useUpdateFeedbackThreadStatusMutation
} from "../queries/feedbackThreads";
import { captureExcludeAttribute } from "../review";
import { errorMessage } from "../utils";

type FeedbackThreadDrawerProps = {
  threadId: string;
  onClose: () => void;
};

/** ピンから開き、会話と Resolve / Reopen を同じ文脈で扱う右 Drawer。 */
export function FeedbackThreadDrawer({ threadId, onClose }: FeedbackThreadDrawerProps) {
  const threadQuery = useFeedbackThreadQuery(threadId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      className="feedback-thread-drawer"
      role="dialog"
      aria-label="フィードバックスレッド"
      {...{ [captureExcludeAttribute]: "" }}
    >
      {threadQuery.isPending ? (
        <DrawerHeader title="コメントを読み込んでいます…" onClose={onClose} />
      ) : threadQuery.isError ? (
        <>
          <DrawerHeader title="コメントを表示できません" onClose={onClose} />
          <p className="notice error" role="alert">
            {errorMessage(threadQuery.error)}
          </p>
        </>
      ) : (
        <FeedbackThreadContent thread={threadQuery.data} onClose={onClose} />
      )}
    </aside>
  );
}

function FeedbackThreadContent({ thread, onClose }: { thread: FeedbackThread; onClose: () => void }) {
  const { me } = useAppShell();
  const [body, setBody] = useState("");
  const createMessage = useCreateFeedbackMessageMutation(thread.reviewSessionId);
  const updateStatus = useUpdateFeedbackThreadStatusMutation(thread.reviewSessionId);
  const canManage =
    me?.systemRole === "admin" ||
    me?.memberships.some((membership) => membership.projectId === thread.projectId && membership.role === "editor") ===
      true;

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || thread.status !== "OPEN") return;
    try {
      await createMessage.mutateAsync({ threadId: thread.id, request: { body: trimmed } });
      setBody("");
      notifySuccess("返信を投稿しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const changeStatus = async () => {
    const nextStatus = thread.status === "OPEN" ? "RESOLVED" : "OPEN";
    try {
      await updateStatus.mutateAsync({ threadId: thread.id, request: { status: nextStatus } });
      notifySuccess(nextStatus === "RESOLVED" ? "スレッドを解決済みにしました" : "スレッドを再開しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  return (
    <>
      <DrawerHeader title={thread.perspectiveLabel} onClose={onClose} />
      <div className="feedback-thread-meta">
        <span className={`feedback-thread-status${thread.status === "RESOLVED" ? " resolved" : ""}`}>
          {thread.status === "RESOLVED" ? "解決済み" : "未解決"}
        </span>
        <time dateTime={thread.createdAt}>{formatTimestamp(thread.createdAt)}</time>
      </div>

      <ol className="feedback-message-list" aria-label="メッセージ一覧">
        {thread.messages.map((message) => (
          <li key={message.id}>
            <div>
              <strong>{message.authorName ?? "退職済みユーザー"}</strong>
              <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
            </div>
            <p>{message.body}</p>
          </li>
        ))}
      </ol>

      {thread.status === "OPEN" ? (
        <form className="feedback-reply-form" onSubmit={(event) => void submitReply(event)}>
          <label>
            返信
            <textarea
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="確認結果や追加情報をご記入ください"
            />
          </label>
          <button type="submit" className="command-button" disabled={!body.trim() || createMessage.isPending}>
            <Send size={14} />
            {createMessage.isPending ? "返信中..." : "返信する"}
          </button>
        </form>
      ) : (
        <p className="review-guide-note">このスレッドは解決済みです。返信する場合は先に再開してください。</p>
      )}

      {canManage ? (
        <button
          type="button"
          className="subtle-button feedback-status-button"
          disabled={updateStatus.isPending}
          onClick={() => void changeStatus()}
        >
          {thread.status === "OPEN" ? <CheckCircle2 size={14} /> : <RotateCcw size={14} />}
          {updateStatus.isPending ? "更新中..." : thread.status === "OPEN" ? "解決済みにする" : "スレッドを再開する"}
        </button>
      ) : null}
    </>
  );
}

function DrawerHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="panel-header feedback-thread-header">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label="スレッドを閉じる" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
