import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewSession } from "./contracts";
import { useFeedbackPluginContext } from "./plugin-context";
import { resolveReviewPageScope, type ReviewPageScopeState } from "./review-scope";

export const defaultReviewIntroductionStorageKey = "web-gis.feedback.review-introduction";

type ReviewSessionIntroductionProps = {
  session: ReviewSession;
  storageKey?: string;
  visible?: boolean;
};

const perspectiveGroups = [
  { status: "ACTIVE", heading: "今回確認してほしいこと" },
  { status: "FUTURE", heading: "今後確認予定" },
  { status: "OUT_OF_SCOPE", heading: "今回対象外" }
] as const;

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

            {perspectiveGroups.map((group) => {
              const perspectives = session.perspectives.filter((item) => item.status === group.status);
              if (perspectives.length === 0) return null;
              return (
                <section className={`wfg-feedback-review-section is-${group.status.toLowerCase()}`} key={group.status}>
                  <h3>{group.heading}</h3>
                  <ul>
                    {perspectives.map((perspective) => (
                      <li key={perspective.code}>
                        <strong>{perspective.label}</strong>
                        {perspective.guidance ? <span>{perspective.guidance}</span> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {session.scopes.length > 0 ? (
              <section className="wfg-feedback-review-section">
                <h3>今回の対象画面</h3>
                <ul className="wfg-feedback-review-scope-list">
                  {reviewableScopes.map((scope) => (
                    <li key={scope.id}>
                      <ReviewScopeLink
                        label={scope.description ?? scope.pageId}
                        routeLabel={scope.route ?? `${scope.pageId}（すべて）`}
                        href={reviewScopeHref(scope.pageId, scope.route, currentPageId, currentPath)}
                      />
                    </li>
                  ))}
                </ul>
                {session.scopes.some((scope) => !scope.reviewable) ? (
                  <>
                    <h3 className="wfg-feedback-review-excluded-heading">対象外の画面</h3>
                    <ul className="wfg-feedback-review-scope-list is-excluded">
                      {session.scopes.filter((scope) => !scope.reviewable).map((scope) => (
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

function ReviewScopeLink({ label, routeLabel, href }: { label: string; routeLabel: string; href: string | null }) {
  const content = <><strong>{label}</strong><code>{routeLabel}</code></>;
  return href ? <a href={href}>{content}</a> : content;
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
