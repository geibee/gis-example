import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  Image,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import { useAppShell } from "../appShell";
import type { FeedbackSummary as FeedbackSummaryDto, FeedbackThread, ReviewSession } from "../contracts";
import {
  useFeedbackEvidenceQuery,
  useFeedbackSummaryQuery,
  useFeedbackThreadSearchQuery
} from "../queries/feedbackThreads";
import {
  usePurgeExpiredReviewEvidenceMutation,
  useReviewRetentionPolicyQuery,
  useUpdateReviewRetentionPolicyMutation
} from "../queries/reviewGovernance";
import { useUpdateReviewSessionMutation } from "../queries/reviewSessions";
import {
  useRetryFailedReviewNotificationsMutation,
  useReviewNotificationSettingsQuery,
  useUpdateReviewNotificationSettingsMutation
} from "../queries/reviewNotifications";
import { notifyError, notifySuccess } from "../notifications";
import { captureExcludeAttribute, useReview } from "../review";
import { errorMessage } from "../utils";

const PAGE_SIZE = 20;

type FeedbackManagementPanelProps = {
  projectId: string;
  session: ReviewSession;
  selectedPerspective: string | null;
  onPerspectiveChange: (code: string | null) => void;
};

/** Phase 5: プロジェクト横断集計と、選択セッション内のスレッド検索・証跡確認。 */
export function FeedbackManagementPanel({
  projectId,
  session,
  selectedPerspective,
  onPerspectiveChange
}: FeedbackManagementPanelProps) {
  const { openThread } = useReview();
  const { me } = useAppShell();
  const [status, setStatus] = useState<"" | "OPEN" | "RESOLVED">("");
  const [evidence, setEvidence] = useState<"" | "with" | "without">("");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchText, setSearchText] = useState("");
  const [offset, setOffset] = useState(0);
  const [evidenceThread, setEvidenceThread] = useState<FeedbackThread | null>(null);

  useEffect(() => setOffset(0), [projectId, session.id]);

  const searchQuery = useMemo(
    () => ({
      projectId,
      reviewSessionId: session.id,
      status: status || undefined,
      perspectiveCode: selectedPerspective ?? undefined,
      hasEvidence: evidence === "" ? undefined : evidence === "with",
      q: searchText || undefined,
      limit: PAGE_SIZE,
      offset
    }),
    [evidence, offset, projectId, searchText, selectedPerspective, session.id, status]
  );
  const threadsQuery = useFeedbackThreadSearchQuery(searchQuery);
  const summaryQuery = useFeedbackSummaryQuery(projectId);
  const threads = threadsQuery.data?.items ?? [];
  const totalCount = threadsQuery.data?.totalCount ?? 0;
  const page = Math.floor(offset / PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const canManage =
    me?.systemRole === "admin" ||
    me?.memberships.some((membership) => membership.projectId === projectId && membership.role === "editor") === true;

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSearchText(searchDraft.trim());
  };

  return (
    <section className="feedback-management" aria-label="フィードバック管理">
      <header className="feedback-management-header">
        <div>
          <p className="eyebrow">レビュー管理</p>
          <h2>フィードバックの確認</h2>
        </div>
        <span className="review-guide-note">一覧は「{session.title}」で絞り込まれています</span>
      </header>

      {summaryQuery.isError ? (
        <p className="notice error" role="alert">
          {errorMessage(summaryQuery.error)}
        </p>
      ) : null}
      {summaryQuery.data ? <FeedbackSummary summary={summaryQuery.data} selectedSessionId={session.id} /> : null}
      {canManage ? <ReviewRetentionPanel projectId={projectId} session={session} /> : null}
      {canManage ? <ReviewNotificationPanel projectId={projectId} /> : null}

      <form className="feedback-management-filters" aria-label="フィードバックの絞り込み" onSubmit={applySearch}>
        <label>
          状態
          <select
            value={status}
            onChange={(event) => {
              setOffset(0);
              setStatus(event.target.value as typeof status);
            }}
          >
            <option value="">すべて</option>
            <option value="OPEN">未解決</option>
            <option value="RESOLVED">解決済み</option>
          </select>
        </label>
        <label>
          観点
          <select
            value={selectedPerspective ?? ""}
            onChange={(event) => {
              setOffset(0);
              onPerspectiveChange(event.target.value || null);
            }}
          >
            <option value="">すべて</option>
            {session.perspectives.map((perspective) => (
              <option value={perspective.code} key={perspective.code}>
                {perspective.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          証跡
          <select
            value={evidence}
            onChange={(event) => {
              setOffset(0);
              setEvidence(event.target.value as typeof evidence);
            }}
          >
            <option value="">すべて</option>
            <option value="with">証跡あり</option>
            <option value="without">証跡なし</option>
          </select>
        </label>
        <label className="feedback-management-search">
          コメント本文
          <span>
            <input
              type="search"
              value={searchDraft}
              placeholder="コメントを検索"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <button type="submit" className="subtle-button" aria-label="コメントを検索">
              <Search size={14} />
            </button>
          </span>
        </label>
      </form>

      {threadsQuery.isError ? (
        <p className="notice error" role="alert">
          {errorMessage(threadsQuery.error)}
        </p>
      ) : null}
      {threadsQuery.isPending ? <p className="review-guide-note">フィードバックを読み込んでいます...</p> : null}
      {!threadsQuery.isPending && !threadsQuery.isError && threads.length === 0 ? (
        <p className="empty-state compact">条件に一致するフィードバックはありません。</p>
      ) : null}

      <div className="feedback-management-list" aria-label="フィードバックスレッド一覧">
        {threads.map((thread) => {
          const firstMessage = thread.messages[0];
          return (
            <article className="feedback-management-thread" key={thread.id}>
              <button
                type="button"
                className="feedback-management-thread-main"
                aria-label={`スレッドを開く: ${firstMessage?.body ?? thread.perspectiveLabel}`}
                onClick={() => openThread(thread.id)}
              >
                <span className="feedback-management-thread-meta">
                  <strong>{thread.perspectiveLabel}</strong>
                  <span className={`feedback-thread-status${thread.status === "RESOLVED" ? " resolved" : ""}`}>
                    {thread.status === "RESOLVED" ? "解決済み" : "未解決"}
                  </span>
                  <time dateTime={thread.updatedAt}>{formatTimestamp(thread.updatedAt)}</time>
                </span>
                <span className="feedback-management-thread-body">
                  {firstMessage?.body ?? "コメント本文はありません"}
                </span>
                <span className="feedback-management-thread-footer">
                  {thread.createdByName ?? "退職済みユーザー"} · {thread.messages.length}件のメッセージ
                </span>
              </button>
              {thread.evidence ? (
                <button
                  type="button"
                  className="subtle-button feedback-evidence-button"
                  aria-label={`証跡を確認: ${firstMessage?.body ?? thread.perspectiveLabel}`}
                  onClick={() => setEvidenceThread(thread)}
                >
                  <Image size={14} />
                  証跡
                </button>
              ) : (
                <span className="feedback-no-evidence">証跡なし</span>
              )}
            </article>
          );
        })}
      </div>

      {totalCount > 0 ? (
        <nav className="feedback-management-pagination" aria-label="フィードバックページ切り替え">
          <span>全 {totalCount} 件</span>
          <button
            type="button"
            className="subtle-button"
            aria-label="前のフィードバックページ"
            disabled={page === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="subtle-button"
            aria-label="次のフィードバックページ"
            disabled={page >= pageCount - 1}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      ) : null}

      {evidenceThread ? (
        <FeedbackEvidenceDialog thread={evidenceThread} onClose={() => setEvidenceThread(null)} />
      ) : null}
    </section>
  );
}

function ReviewNotificationPanel({ projectId }: { projectId: string }) {
  const settingsQuery = useReviewNotificationSettingsQuery(projectId);
  const updateSettings = useUpdateReviewNotificationSettingsMutation();
  const retryFailed = useRetryFailedReviewNotificationsMutation();
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [teamsEnabled, setTeamsEnabled] = useState(false);
  const [issueEnabled, setIssueEnabled] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setEmailEnabled(settingsQuery.data.emailEnabled);
    setTeamsEnabled(settingsQuery.data.teamsEnabled);
    setIssueEnabled(settingsQuery.data.issueEnabled);
  }, [settingsQuery.data]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await updateSettings.mutateAsync({
        projectId,
        request: { emailEnabled, teamsEnabled, issueEnabled }
      });
      notifySuccess("レビュー通知の設定を更新しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const retry = async () => {
    try {
      const result = await retryFailed.mutateAsync(projectId);
      notifySuccess(`${result.retriedDeliveryCount}件の通知を再試行します`);
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const settings = settingsQuery.data;
  return (
    <section className="review-notifications" aria-label="レビュー通知・外部連携">
      <header>
        <div>
          <BellRing size={16} />
          <h3>通知・外部連携</h3>
        </div>
        <span>
          配信待ち {settings?.pendingDeliveryCount ?? 0}件 / 失敗 {settings?.failedDeliveryCount ?? 0}件
        </span>
      </header>
      <p>証跡画像は送信せず、指摘本文と内部リンクだけを一方向に配信します。</p>
      {settingsQuery.isError ? (
        <p className="notice error" role="alert">
          {errorMessage(settingsQuery.error)}
        </p>
      ) : null}
      <form onSubmit={(event) => void save(event)}>
        <label>
          <input
            type="checkbox"
            checked={emailEnabled}
            disabled={!settings?.emailAvailable && !emailEnabled}
            onChange={(event) => setEmailEnabled(event.target.checked)}
          />
          Email（プロジェクトメンバー）
          {!settings?.emailAvailable ? <small>サーバー未設定</small> : null}
        </label>
        <label>
          <input
            type="checkbox"
            checked={teamsEnabled}
            disabled={!settings?.teamsAvailable && !teamsEnabled}
            onChange={(event) => setTeamsEnabled(event.target.checked)}
          />
          Microsoft Teams
          {!settings?.teamsAvailable ? <small>サーバー未設定</small> : null}
        </label>
        <label>
          <input
            type="checkbox"
            checked={issueEnabled}
            disabled={!settings?.issueAvailable && !issueEnabled}
            onChange={(event) => setIssueEnabled(event.target.checked)}
          />
          Issue 生成
          {!settings?.issueAvailable ? <small>サーバー未設定</small> : null}
        </label>
        <button type="submit" className="subtle-button" disabled={settingsQuery.isPending || updateSettings.isPending}>
          通知設定を更新
        </button>
      </form>
      <div className="review-notifications-retry">
        <span>失敗した配信は自動で最大回数まで再試行されます。</span>
        <button
          type="button"
          className="subtle-button"
          disabled={!settings?.failedDeliveryCount || retryFailed.isPending}
          onClick={() => void retry()}
        >
          <RefreshCw size={14} />
          失敗した通知を再試行
        </button>
      </div>
    </section>
  );
}

function ReviewRetentionPanel({ projectId, session }: { projectId: string; session: ReviewSession }) {
  const policyQuery = useReviewRetentionPolicyQuery(projectId);
  const updatePolicy = useUpdateReviewRetentionPolicyMutation();
  const updateSession = useUpdateReviewSessionMutation();
  const purgeEvidence = usePurgeExpiredReviewEvidenceMutation();
  const [projectDays, setProjectDays] = useState("");
  const [sessionDays, setSessionDays] = useState("");

  useEffect(() => {
    setProjectDays(policyQuery.data?.defaultEvidenceRetentionDays?.toString() ?? "");
  }, [policyQuery.data?.defaultEvidenceRetentionDays]);
  useEffect(() => {
    setSessionDays(session.evidenceRetentionDays?.toString() ?? "");
  }, [session.evidenceRetentionDays, session.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextProjectDays = projectDays === "" ? null : Number(projectDays);
    const nextSessionDays = sessionDays === "" ? null : Number(sessionDays);
    try {
      if (nextProjectDays !== (policyQuery.data?.defaultEvidenceRetentionDays ?? null)) {
        await updatePolicy.mutateAsync({
          projectId,
          request: { defaultEvidenceRetentionDays: nextProjectDays }
        });
      }
      if (nextSessionDays !== (session.evidenceRetentionDays ?? null)) {
        await updateSession.mutateAsync({ id: session.id, request: { evidenceRetentionDays: nextSessionDays } });
      }
      notifySuccess("証跡の保存期間を更新しました");
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const purge = async () => {
    if (!window.confirm("期限切れ証跡を完全に削除します。この操作は取り消せません。続行しますか？")) return;
    try {
      const result = await purgeEvidence.mutateAsync(projectId);
      if (result.failedEvidenceCount > 0) {
        notifyError(`${result.purgedEvidenceCount}件を削除し、${result.failedEvidenceCount}件は再試行が必要です`);
      } else {
        notifySuccess(`${result.purgedEvidenceCount}件の期限切れ証跡を削除しました`);
      }
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  return (
    <section className="review-retention" aria-label="証跡の保存期間">
      <header>
        <div>
          <ShieldCheck size={16} />
          <h3>証跡の保存期間</h3>
        </div>
        <span>
          実効値: {session.effectiveEvidenceRetentionDays ? `${session.effectiveEvidenceRetentionDays}日` : "自動削除なし"}
        </span>
      </header>
      {policyQuery.isError ? (
        <p className="notice error" role="alert">
          {errorMessage(policyQuery.error)}
        </p>
      ) : null}
      <form onSubmit={(event) => void save(event)}>
        <label>
          プロジェクト既定（日）
          <input
            type="number"
            min={1}
            max={3650}
            value={projectDays}
            placeholder="自動削除なし"
            onChange={(event) => setProjectDays(event.target.value)}
          />
        </label>
        <label>
          このセッションの上書き（日）
          <input
            type="number"
            min={1}
            max={3650}
            value={sessionDays}
            placeholder="プロジェクト既定を継承"
            onChange={(event) => setSessionDays(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="subtle-button"
          disabled={updatePolicy.isPending || updateSession.isPending || policyQuery.isPending}
        >
          保存期間を更新
        </button>
      </form>
      <div className="review-retention-purge">
        <span>
          期限切れ {policyQuery.data?.expiredEvidenceCount ?? 0}件
          {policyQuery.data ? `（${formatBytes(policyQuery.data.expiredEvidenceBytes)}）` : ""}
        </span>
        <button
          type="button"
          className="subtle-button danger"
          disabled={!policyQuery.data?.expiredEvidenceCount || purgeEvidence.isPending}
          onClick={() => void purge()}
        >
          <Trash2 size={14} />
          {purgeEvidence.isPending ? "削除中..." : "期限切れ証跡を削除"}
        </button>
      </div>
    </section>
  );
}

function FeedbackSummary({
  summary,
  selectedSessionId
}: {
  summary: FeedbackSummaryDto;
  selectedSessionId: string;
}) {
  return (
    <div className="feedback-summary" role="group" aria-label="フィードバック集計">
      <dl className="feedback-summary-cards">
        <SummaryCard label="全件" value={summary.totalCount} />
        <SummaryCard label="未解決" value={summary.openCount} />
        <SummaryCard label="解決済み" value={summary.resolvedCount} />
        <SummaryCard label="証跡あり" value={summary.withEvidenceCount} />
      </dl>
      <div className="feedback-summary-breakdown">
        <section aria-label="セッション別集計">
          <h3>セッション別</h3>
          <ul>
            {summary.sessions.map((item) => (
              <li className={item.reviewSessionId === selectedSessionId ? "selected" : ""} key={item.reviewSessionId}>
                <span>{item.title}</span>
                <span>
                  {item.totalCount}件（未解決 {item.openCount}）
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="観点別集計">
          <h3>観点別</h3>
          <ul>
            {summary.perspectives.map((item) => (
              <li key={item.perspectiveCode}>
                <span>{item.perspectiveLabel}</span>
                <span>
                  {item.totalCount}件（未解決 {item.openCount}）
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FeedbackEvidenceDialog({ thread, onClose }: { thread: FeedbackThread; onClose: () => void }) {
  const evidenceQuery = useFeedbackEvidenceQuery(thread.id);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!evidenceQuery.data || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(evidenceQuery.data);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [evidenceQuery.data]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="feedback-evidence-backdrop" {...{ [captureExcludeAttribute]: "" }}>
      <section className="feedback-evidence-dialog" role="dialog" aria-label="証跡の確認">
        <header className="panel-header">
          <div>
            <p className="eyebrow">投稿時点の画面</p>
            <h2>{thread.perspectiveLabel}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="証跡を閉じる" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {thread.evidence ? (
          <p className="feedback-evidence-metadata">
            <code>{thread.evidence.route}</code>
            <span>
              {thread.evidence.viewportWidth}×{thread.evidence.viewportHeight} · {formatTimestamp(thread.evidence.capturedAt)}
            </span>
            <span>
              保存期限: {thread.evidence.expiresAt ? formatTimestamp(thread.evidence.expiresAt) : "自動削除なし"}
            </span>
          </p>
        ) : null}
        {evidenceQuery.isPending ? <p className="review-guide-note">証跡を読み込んでいます...</p> : null}
        {evidenceQuery.isError ? (
          <p className="notice error" role="alert">
            {errorMessage(evidenceQuery.error)}
          </p>
        ) : null}
        {imageUrl ? <img src={imageUrl} alt="コメント投稿時点の証跡" /> : null}
        {evidenceQuery.isSuccess && !imageUrl ? (
          <p className="review-guide-note">
            <MessageSquareText size={14} /> 証跡を取得しました。
          </p>
        ) : null}
      </section>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
