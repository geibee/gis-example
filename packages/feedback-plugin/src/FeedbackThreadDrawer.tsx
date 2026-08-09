import { useEffect, useState, type FormEvent } from "react";
import type { FeedbackMessage, FeedbackThread } from "./contracts";
import { useDismissiblePanel } from "./dismiss";
import { errorMessage, PanelHeader } from "./FeedbackOverlay";
import { useFeedbackPluginContext } from "./plugin-context";
import {
  useCreateFeedbackMessageMutation,
  useCurrentUserQuery,
  useFeedbackMessageHistoryQuery,
  useFeedbackThreadQuery,
  useUpdateFeedbackMessageMutation,
  useUpdateFeedbackThreadStatusMutation
} from "./queries";

export function FeedbackThreadDrawer({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const threadQuery = useFeedbackThreadQuery(threadId);
  const panelRef = useDismissiblePanel<HTMLElement>(onClose);

  return (
    <aside ref={panelRef} className="wfg-feedback-panel wfg-feedback-thread-drawer" role="dialog" aria-label="フィードバックスレッド">
      {threadQuery.isPending ? (
        <PanelHeader title="コメントを読み込んでいます…" onClose={onClose} />
      ) : threadQuery.isError ? (
        <>
          <PanelHeader title="コメントを表示できません" onClose={onClose} />
          <p className="wfg-feedback-error" role="alert">{errorMessage(threadQuery.error)}</p>
        </>
      ) : (
        <FeedbackThreadContent thread={threadQuery.data} onClose={onClose} />
      )}
    </aside>
  );
}

function FeedbackThreadContent({ thread, onClose }: { thread: FeedbackThread; onClose: () => void }) {
  const { notify, participantName, saveParticipantName } = useFeedbackPluginContext();
  const meQuery = useCurrentUserQuery();
  const me = meQuery.data;
  const [participantNameDraft, setParticipantNameDraft] = useState(participantName ?? "");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createMessage = useCreateFeedbackMessageMutation();
  const updateStatus = useUpdateFeedbackThreadStatusMutation();
  const canManage =
    me?.systemRole === "admin" ||
    me?.memberships.some(
      (membership) => membership.projectId === thread.projectId && membership.role === "editor"
    ) === true;

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    const submittedParticipantName = participantNameDraft.trim();
    if (!trimmed || !submittedParticipantName || thread.status !== "OPEN") return;
    setError(null);
    try {
      await createMessage.mutateAsync({
        threadId: thread.id,
        request: { body: trimmed, participantName: submittedParticipantName }
      });
      saveParticipantName(submittedParticipantName);
      setBody("");
      notify({ type: "success", message: "返信を投稿しました" });
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify({ type: "error", message });
    }
  };

  const changeStatus = async () => {
    const status = thread.status === "OPEN" ? "RESOLVED" : "OPEN";
    setError(null);
    try {
      await updateStatus.mutateAsync({ threadId: thread.id, request: { status } });
      notify({
        type: "success",
        message: status === "RESOLVED" ? "スレッドを解決済みにしました" : "スレッドを再開しました"
      });
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify({ type: "error", message });
    }
  };

  return (
    <>
      <PanelHeader title={thread.perspectiveLabel} onClose={onClose} closeLabel="スレッドを閉じる" />
      <div className="wfg-feedback-thread-meta">
        <span className={`wfg-feedback-thread-status${thread.status === "RESOLVED" ? " is-resolved" : ""}`}>
          {thread.status === "RESOLVED" ? "解決済み" : "未解決"}
        </span>
        <time dateTime={thread.createdAt}>{formatTimestamp(thread.createdAt)}</time>
      </div>
      {error ? <p className="wfg-feedback-error" role="alert">{error}</p> : null}
      <ol className="wfg-feedback-message-list" aria-label="メッセージ一覧">
        {thread.messages.map((message) => (
          <FeedbackMessageItem
            key={message.id}
            message={message}
            participantName={participantName}
            canEdit={message.participantName
              ? message.participantName === participantName
              : message.authorId === me?.userId}
          />
        ))}
      </ol>
      {thread.status === "OPEN" ? (
        <form className="wfg-feedback-reply-form" onSubmit={(event) => void submitReply(event)}>
          <label>
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
            <span className="wfg-feedback-field-help">このブラウザに保存されます。</span>
          </label>
          <label>
            返信
            <textarea
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="確認結果や追加情報をご記入ください"
            />
          </label>
          <button
            type="submit"
            className="wfg-feedback-button-primary"
            disabled={!body.trim() || !participantNameDraft.trim() || createMessage.isPending}
          >
            {createMessage.isPending ? "返信中…" : "返信する"}
          </button>
        </form>
      ) : (
        <p className="wfg-feedback-note">このスレッドは解決済みです。返信する場合は先に再開してください。</p>
      )}
      {canManage ? (
        <button
          type="button"
          className="wfg-feedback-button-secondary wfg-feedback-status-button"
          disabled={updateStatus.isPending}
          onClick={() => void changeStatus()}
        >
          {updateStatus.isPending ? "更新中…" : thread.status === "OPEN" ? "解決済みにする" : "スレッドを再開する"}
        </button>
      ) : null}
    </>
  );
}

function FeedbackMessageItem({
  message,
  participantName,
  canEdit
}: {
  message: FeedbackMessage;
  participantName: string | null;
  canEdit: boolean;
}) {
  const { notify } = useFeedbackPluginContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateMessage = useUpdateFeedbackMessageMutation();
  const historyQuery = useFeedbackMessageHistoryQuery(historyOpen ? message.id : null);

  useEffect(() => {
    if (!editing) setDraft(message.body);
  }, [editing, message.body]);

  const save = async () => {
    const body = draft.trim();
    if (!body || body === message.body) {
      setEditing(false);
      setDraft(message.body);
      return;
    }
    setError(null);
    try {
      await updateMessage.mutateAsync({
        messageId: message.id,
        request: { body, participantName }
      });
      setEditing(false);
      notify({ type: "success", message: "コメントを編集しました" });
    } catch (caught) {
      const text = errorMessage(caught);
      setError(text);
      notify({ type: "error", message: text });
    }
  };

  return (
    <li>
      <div className="wfg-feedback-message-heading">
        <strong>{message.participantName ?? message.authorName ?? "投稿者不明"}</strong>
        <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
      </div>
      {editing ? (
        <div className="wfg-feedback-message-editor">
          <label>
            コメントを編集
            <textarea rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="wfg-feedback-button-row">
            <button type="button" className="wfg-feedback-button-secondary" onClick={() => setEditing(false)}>キャンセル</button>
            <button type="button" className="wfg-feedback-button-primary" disabled={!draft.trim() || updateMessage.isPending} onClick={() => void save()}>
              {updateMessage.isPending ? "保存中…" : "編集を保存"}
            </button>
          </div>
        </div>
      ) : <p>{message.body}</p>}
      {error ? <p className="wfg-feedback-error" role="alert">{error}</p> : null}
      <div className="wfg-feedback-message-actions">
        {message.editedAt ? (
          <button type="button" className="wfg-feedback-text-button" onClick={() => setHistoryOpen((open) => !open)}>編集履歴</button>
        ) : null}
        {canEdit && !editing ? (
          <button type="button" className="wfg-feedback-text-button" onClick={() => setEditing(true)}>編集</button>
        ) : null}
      </div>
      {historyOpen ? (
        <div className="wfg-feedback-message-history" role="region" aria-label="コメントの編集履歴">
          {historyQuery.isPending ? <p>履歴を読み込んでいます…</p> : null}
          {historyQuery.isError ? <p className="wfg-feedback-error">{errorMessage(historyQuery.error)}</p> : null}
          {historyQuery.data?.map((version) => (
            <article key={version.version}>
              <div>
                <strong>版 {version.version}</strong>
                {version.current ? <span>現在</span> : null}
                <span>{version.editedByParticipantName ?? version.editedByName ?? "編集者不明"}</span>
                <time dateTime={version.createdAt}>{formatTimestamp(version.createdAt)}</time>
              </div>
              <p>{version.body}</p>
            </article>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}
