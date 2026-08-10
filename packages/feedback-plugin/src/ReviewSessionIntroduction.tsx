import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSession } from "./contracts";
import { useFeedbackPluginContext } from "./plugin-context";
import { resolveCurrentReviewScope, resolveReviewPageScope, type ReviewPageScopeState } from "./review-scope";

export const defaultReviewIntroductionStorageKey = "web-gis.feedback.review-introduction";

type ReviewSessionIntroductionProps = {
  session: ReviewSession;
  storageKey?: string;
  visible?: boolean;
};

const scopeStateLabels: Record<ReviewPageScopeState, string> = {
  reviewable: "この画面は対象",
  excluded: "この画面は対象外",
  unscoped: "この画面は対象外"
};

/** 受付中レビューの初回案内と、再表示用の常設導線。 */
export function ReviewSessionIntroduction({
  session,
  storageKey = defaultReviewIntroductionStorageKey,
  visible = true
}: ReviewSessionIntroductionProps) {
  const { currentPageId, currentPath, projectId } = useFeedbackPluginContext();
  const dismissedKey = `${storageKey}.${projectId}.${session.id}`;
  const [open, setOpen] = useState(() => !isDismissed(dismissedKey));
  const dialogRef = useRef<HTMLElement>(null);
  const period = formatReviewPeriod(session.startAt, session.endAt);
  const scopeState = useMemo(
    () => resolveReviewPageScope(session, currentPageId, currentPath),
    [currentPageId, currentPath, session]
  );
  const reviewableScopes = session.scopes.filter((scope) => scope.reviewable);
  const excludedScopes = session.scopes.filter((scope) => !scope.reviewable);
  const currentScope = useMemo(
    () => resolveCurrentReviewScope(session, currentPageId, currentPath),
    [currentPageId, currentPath, session]
  );
  const globallyActivePerspectives = session.perspectives.filter((item) => item.status === "ACTIVE");
  const assignedCodes = currentScope?.perspectiveCodes?.length ? new Set(currentScope.perspectiveCodes) : null;
  const activePerspectives = globallyActivePerspectives.filter((item) => !assignedCodes || assignedCodes.has(item.code));
  const inactivePerspectives = session.perspectives.filter((item) =>
    item.status !== "ACTIVE" || Boolean(assignedCodes && !assignedCodes.has(item.code))
  );

  useEffect(() => {
    setOpen(!isDismissed(dismissedKey));
  }, [dismissedKey]);

  useEffect(() => {
    if (!open || !visible) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        markDismissed(dismissedKey);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismissedKey, open, visible]);

  const dismiss = () => {
    setOpen(false);
    markDismissed(dismissedKey);
  };

  if (!visible) return null;

  return (
    <>
      <button
        type="button"
        className={`wfg-feedback-review-guide-button is-${scopeState}`}
        aria-label={`レビュー通知：${session.title}（${scopeStateLabels[scopeState]}、対象${reviewableScopes.length}画面）`}
        onClick={() => setOpen(true)}
      >
        <svg className="wfg-feedback-review-bell" aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
        <span className="wfg-feedback-review-guide-copy"><strong>レビュー受付中</strong><small>{session.title}・{scopeStateLabels[scopeState]}</small></span>
        <span className="wfg-feedback-review-count" aria-hidden="true">{reviewableScopes.length}</span>
      </button>
      {open ? (
        <div
          className="wfg-feedback-review-guide-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <section
            ref={dialogRef}
            className="wfg-feedback-review-guide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wfg-feedback-review-guide-title"
            tabIndex={-1}
          >
            <header className="wfg-feedback-review-guide-header">
              <div>
                <p className="wfg-feedback-eyebrow">レビュー受付中</p>
                <h2 id="wfg-feedback-review-guide-title">{session.title}</h2>
              </div>
              <button type="button" className="wfg-feedback-icon-button" aria-label="レビュー案内を閉じる" onClick={dismiss}>
                ×
              </button>
            </header>

            {period ? <p className="wfg-feedback-review-period">{period}</p> : null}
            {session.description ? <p className="wfg-feedback-review-description">{session.description}</p> : null}
            <p className={`wfg-feedback-current-scope is-${scopeState}`}>
              {scopeStateLabels[scopeState]}
            </p>

            <div className="wfg-feedback-review-focus-grid">
              <section className="wfg-feedback-review-focus is-active">
                <header><span aria-hidden="true">✓</span><div><h3>今回確認してほしいこと</h3><small>{activePerspectives.length}項目</small></div></header>
                {activePerspectives.length > 0 ? <ul>{activePerspectives.map((perspective) => (
                  <li key={perspective.code}>
                    <strong>{perspective.label}</strong>
                    {perspective.guidance ? <span>{perspective.guidance}</span> : null}
                  </li>
                ))}</ul> : <p>具体的な確認観点は設定されていません。</p>}
              </section>
              <section className="wfg-feedback-review-focus is-inactive">
                <header><span aria-hidden="true">−</span><div><h3>今回は確認しなくてよいこと</h3><small>{inactivePerspectives.length}項目</small></div></header>
                {inactivePerspectives.length > 0 ? <ul>{inactivePerspectives.map((perspective) => (
                  <li key={perspective.code}>
                    <span className="wfg-feedback-review-status-label">{perspective.status === "FUTURE" ? "今後確認" : "今回対象外"}</span>
                    <strong>{perspective.label}</strong>
                    {perspective.guidance ? <span>{perspective.guidance}</span> : null}
                  </li>
                ))}</ul> : <p>確認不要として指定された観点はありません。</p>}
              </section>
            </div>

            {session.scopes.length > 0 ? (
              <section className="wfg-feedback-review-section">
                <div className="wfg-feedback-review-section-heading"><div><h3>今回の対象画面</h3><p>確認する画面へ移動する場合は、各カードのボタンを押してください。</p></div><strong>{reviewableScopes.length}画面</strong></div>
                <ul className="wfg-feedback-review-scope-list">
                  {reviewableScopes.map((scope) => (
                    <li key={scope.id}>
                      <ReviewScopeCard
                        label={scope.description ?? scope.pageId}
                        routeLabel={scope.route ?? `${scope.pageId}（すべて）`}
                        perspectiveLabels={scopePerspectiveLabels(scope.perspectiveCodes, globallyActivePerspectives)}
                        href={reviewScopeHref(scope.pageId, scope.route, currentPageId, currentPath)}
                        current={scope.pageId === currentPageId}
                      />
                    </li>
                  ))}
                </ul>
                {excludedScopes.length > 0 ? (
                  <>
                    <h3 className="wfg-feedback-review-excluded-heading">対象外の画面</h3>
                    <ul className="wfg-feedback-review-scope-list is-excluded">
                      {excludedScopes.map((scope) => (
                        <li key={scope.id}>
                          <strong>{scope.description ?? scope.pageId}</strong>
                          <code>{scope.route ?? `${scope.pageId}（すべて）`}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
            ) : null}

            <div className="wfg-feedback-review-guide-actions">
              <button type="button" className="wfg-feedback-button-primary" onClick={dismiss}>
                確認してレビューを始める
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ReviewScopeCard({
  label,
  routeLabel,
  perspectiveLabels,
  href,
  current
}: {
  label: string;
  routeLabel: string;
  perspectiveLabels: string[];
  href: string | null;
  current: boolean;
}) {
  return <div className={`wfg-feedback-review-scope-card${current ? " is-current" : ""}`}>
    <span className="wfg-feedback-review-scope-icon" aria-hidden="true">▣</span>
    <span className="wfg-feedback-review-scope-copy"><strong>{label}</strong><small>{current ? "現在表示中の画面" : routeLabel}</small>{perspectiveLabels.length > 0 ? <em>{perspectiveLabels.join("・")}</em> : null}</span>
    {href ? <a className="wfg-feedback-review-scope-action" href={href}>{current ? "この画面で確認" : "画面を開く"}<span aria-hidden="true">→</span></a> : <span className="wfg-feedback-review-scope-unavailable">直接移動できません</span>}
  </div>;
}

function scopePerspectiveLabels(
  codes: string[] | undefined,
  activePerspectives: ReviewSession["perspectives"]
): string[] {
  if (!codes?.length) return activePerspectives.map((item) => item.label);
  const selected = new Set(codes);
  return activePerspectives.filter((item) => selected.has(item.code)).map((item) => item.label);
}

function reviewScopeHref(
  pageId: string,
  route: string | null | undefined,
  currentPageId: string | undefined,
  currentPath: string
): string | null {
  if (pageId === currentPageId) return currentPath;
  if (!route) return null;
  if (!route.includes("{")) return route;
  const listRoute = route.replace(/\/\{[^/{}]+\}/g, "").replace(/\/$/, "");
  return listRoute || "/";
}

function formatReviewPeriod(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt && !endAt) return null;
  const format = (value?: string | null) => {
    if (!value) return "未設定";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
  };
  return `${format(startAt)} 〜 ${format(endAt)}`;
}

function isDismissed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "dismissed";
  } catch {
    return false;
  }
}

function markDismissed(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, "dismissed");
  } catch {
    // localStorageが無効でも、現在のマウント中はstateで閉じた状態を保持する。
  }
}
