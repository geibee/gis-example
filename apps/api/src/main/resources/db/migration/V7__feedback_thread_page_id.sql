-- Phase 3 (docs/prototype-review.md): コメントピンを「その画面」にだけ出すための投稿元画面。
--
-- review_scope_id では代用できない: レビュー対象に入っていない画面からの投稿では NULL に
-- なるため、「どの画面で付いたコメントか」を必ず持つ列を別に置く。
-- (V6 は適用済みのため編集せず、列の追加で行う — AGENTS.md のマイグレーション規約)
ALTER TABLE app.feedback_threads
    ADD COLUMN page_id text;

CREATE INDEX feedback_threads_page_idx ON app.feedback_threads(review_session_id, page_id);
