import { CalendarClock, CircleSlash, Clock, Check } from "lucide-react";
import type { ReviewPerspective, ReviewSession } from "../contracts";

// レビューガイド (docs/prototype-review.md 8.1)。
//
// この画面の役割は「今回何を見てほしいか」をレビュー開始前に確定させること。
// FUTURE / OUT_OF_SCOPE の観点を隠さずグレーアウトして見せるのが要点で、
// 「今は見なくてよい」と「存在を忘れている」を顧客から区別できるようにする。

/** 観点の状態ごとの見出しと説明 (顧客に見せる語彙)。 */
const perspectiveGroups = [
  {
    status: "ACTIVE" as const,
    heading: "今回確認してほしいこと",
    note: null,
    icon: Check
  },
  {
    status: "FUTURE" as const,
    heading: "今後確認予定",
    note: "今回は選択できません。後続フェーズで改めてレビューします。",
    icon: Clock
  },
  {
    status: "OUT_OF_SCOPE" as const,
    heading: "今回対象外",
    note: "今回のプロトタイピングでは原則対象外です。",
    icon: CircleSlash
  }
];

export const reviewSessionStatusLabels: Record<ReviewSession["status"], string> = {
  draft: "準備中",
  open: "レビュー受付中",
  closed: "受付終了"
};

/** ISO-8601 (オフセット付き) を日本語表記へ。解釈できない値はそのまま見せる (握り潰さない)。 */
export function formatReviewPeriod(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt && !endAt) return null;
  const format = (value?: string | null) => {
    if (!value) return "未設定";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
  };
  return `${format(startAt)} 〜 ${format(endAt)}`;
}

type ReviewGuideProps = {
  session: ReviewSession;
  /** 選択中の観点コード (Phase 2 のコメント投稿で使う)。 */
  selectedPerspective?: string | null;
  /** 観点を選べるようにする場合に渡す。ACTIVE 以外は選択できない。 */
  onSelectPerspective?: (code: string) => void;
};

export function ReviewGuide({ session, selectedPerspective, onSelectPerspective }: ReviewGuideProps) {
  const period = formatReviewPeriod(session.startAt, session.endAt);
  const reviewableScopes = session.scopes.filter((scope) => scope.reviewable);
  const excludedScopes = session.scopes.filter((scope) => !scope.reviewable);

  return (
    <section className="review-guide" aria-label="レビューガイド">
      <header className="review-guide-header">
        <p className="eyebrow">レビューセッション</p>
        <h2>{session.title}</h2>
        <p className="review-guide-meta">
          <span className={`review-status review-status-${session.status}`}>
            {reviewSessionStatusLabels[session.status]}
          </span>
          {period ? (
            <span className="review-guide-period">
              <CalendarClock size={14} aria-hidden="true" />
              {period}
            </span>
          ) : null}
        </p>
        {session.description ? <p className="review-guide-description">{session.description}</p> : null}
      </header>

      {perspectiveGroups.map((group) => {
        const perspectives = session.perspectives.filter((perspective) => perspective.status === group.status);
        if (perspectives.length === 0) return null;
        return (
          <div className="panel-section" key={group.status}>
            <h3 className="section-title">{group.heading}</h3>
            {group.note ? <p className="review-guide-note">{group.note}</p> : null}
            <ul className={`review-perspective-list review-perspective-${group.status.toLowerCase()}`}>
              {perspectives.map((perspective) => (
                <PerspectiveItem
                  key={perspective.code}
                  perspective={perspective}
                  icon={group.icon}
                  selectable={group.status === "ACTIVE" && Boolean(onSelectPerspective)}
                  selected={selectedPerspective === perspective.code}
                  onSelect={onSelectPerspective}
                />
              ))}
            </ul>
          </div>
        );
      })}

      {session.scopes.length > 0 ? (
        <div className="panel-section">
          <h3 className="section-title">今回の対象画面</h3>
          <ul className="review-scope-list">
            {reviewableScopes.map((scope) => (
              <li key={scope.id}>
                <code>{scope.pageId}</code>
                {scope.description ? <span> — {scope.description}</span> : null}
              </li>
            ))}
          </ul>
          {excludedScopes.length > 0 ? (
            <>
              <h3 className="section-title">対象外の画面</h3>
              <ul className="review-scope-list review-scope-excluded">
                {excludedScopes.map((scope) => (
                  <li key={scope.id}>
                    <code>{scope.pageId}</code>
                    {scope.description ? <span> — {scope.description}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type PerspectiveItemProps = {
  perspective: ReviewPerspective;
  icon: typeof Check;
  selectable: boolean;
  selected: boolean;
  onSelect?: (code: string) => void;
};

function PerspectiveItem({ perspective, icon: Icon, selectable, selected, onSelect }: PerspectiveItemProps) {
  const label = (
    <>
      <Icon size={15} aria-hidden="true" />
      <span className="review-perspective-label">{perspective.label}</span>
      {perspective.guidance ? <span className="review-perspective-guidance">{perspective.guidance}</span> : null}
    </>
  );

  if (!selectable) {
    // 選択できない観点も「表示はする」。disabled なボタンとして出すことで、
    // 存在は分かるが今回は選べないことがスクリーンリーダーにも伝わる
    return (
      <li>
        <button type="button" className="review-perspective" disabled aria-describedby={undefined}>
          {label}
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`review-perspective${selected ? " selected" : ""}`}
        aria-pressed={selected}
        onClick={() => onSelect?.(perspective.code)}
      >
        {label}
      </button>
    </li>
  );
}
