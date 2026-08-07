import { useEffect, useState } from "react";
import { useAppShell } from "../appShell";
import { ReviewGuide, reviewSessionStatusLabels } from "../components/ReviewGuide";
import { useReviewSessionsQuery } from "../queries/reviewSessions";
import { errorMessage } from "../utils";

// レビュー画面 (docs/prototype-review.md Phase 1)。
// プロジェクトのレビューセッションを選び、そのガイド (何を・どの観点で見てほしいか) を表示する。
// コメント投稿 (Phase 2) はここで選んだ観点を引き継ぐ想定。
export default function ReviewScreen() {
  const { selectedProject } = useAppShell();
  const sessionsQuery = useReviewSessionsQuery(selectedProject);
  const sessions = sessionsQuery.data ?? [];

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedPerspective, setSelectedPerspective] = useState<string | null>(null);

  // 受付中のセッションを既定で開く (無ければ最新)
  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }
    if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) return;
    setSelectedSessionId((sessions.find((session) => session.status === "open") ?? sessions[0]).id);
  }, [selectedSessionId, sessions]);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <section className="tab-pane review-tab active">
      <div className="review-layout">
        <aside className="review-session-list" aria-label="レビューセッション">
          <h2 className="section-title">レビューセッション</h2>
          {sessionsQuery.isPending ? <p className="review-guide-note">読み込み中...</p> : null}
          {sessionsQuery.isError ? (
            <p className="notice error" role="alert">
              {errorMessage(sessionsQuery.error)}
            </p>
          ) : null}
          {!sessionsQuery.isPending && !sessionsQuery.isError && sessions.length === 0 ? (
            <p className="review-guide-note">このプロジェクトにはまだレビューセッションがありません。</p>
          ) : null}
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`review-session-item${session.id === selectedSessionId ? " selected" : ""}`}
                  aria-current={session.id === selectedSessionId}
                  onClick={() => {
                    setSelectedSessionId(session.id);
                    setSelectedPerspective(null);
                  }}
                >
                  <span className="review-session-title">{session.title}</span>
                  <span className={`review-status review-status-${session.status}`}>
                    {reviewSessionStatusLabels[session.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="review-guide-pane">
          {selectedSession ? (
            <ReviewGuide
              session={selectedSession}
              selectedPerspective={selectedPerspective}
              // 受付中のセッションでのみ観点を選べる (準備中・終了後は読むだけ)
              onSelectPerspective={selectedSession.status === "open" ? setSelectedPerspective : undefined}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
