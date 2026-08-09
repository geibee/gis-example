-- プロトタイプレビュー管理基盤 Phase 2 (docs/prototype-review.md)。
--
-- コメント投稿時点の画面を証跡として固定化し、指摘 1 件を FeedbackThread として残す。
-- 「将来画面を再現する」のではなく「投稿時点のレンダリング結果を固める」方針のため、
-- 保存するのは状態 JSON ではなく PNG + 再現に必要な最小メタデータ。

-- コメント投稿時点の証跡。画像本体は Blob (UploadStorage) に置き、DB は参照とメタデータのみ持つ
CREATE TABLE app.review_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- UploadStorage の参照文字列 (ローカル絶対パス または s3://bucket/key)。
    -- 公開 URL ではない: 取得は必ず API の認可を通す (docs/prototype-review.md 第 7 章)
    screenshot_path text NOT NULL,
    content_type text NOT NULL DEFAULT 'image/png',
    byte_size bigint NOT NULL,
    viewport_width integer NOT NULL,
    viewport_height integer NOT NULL,
    scroll_x integer NOT NULL DEFAULT 0,
    scroll_y integer NOT NULL DEFAULT 0,
    pixel_ratio numeric(4, 2) NOT NULL DEFAULT 1,
    -- どのプロトタイプへの指摘かを後から追跡するための識別子 (VITE_APP_VERSION)
    frontend_version text NOT NULL,
    route text NOT NULL,
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 1 つの指摘・質問のスレッド
CREATE TABLE app.feedback_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 認可 (ProjectResourceType.FEEDBACK_THREAD) が 1 回の参照で解決できるよう非正規化して持つ
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    review_session_id uuid NOT NULL REFERENCES app.review_sessions(id) ON DELETE CASCADE,
    -- 投稿時の画面に対応する ReviewScope (対象外の画面からの投稿もあり得るので NULL 許容)
    review_scope_id uuid REFERENCES app.review_scopes(id) ON DELETE SET NULL,
    perspective_code text NOT NULL REFERENCES app.review_perspectives(code) ON DELETE RESTRICT,
    target_type text NOT NULL
        CHECK (target_type IN ('UI_ELEMENT', 'SCREEN_POSITION', 'MAP_FEATURE', 'MAP_POSITION')),
    -- FeedbackTarget (apps/web/src/review/types.ts) をそのまま格納する
    target_metadata jsonb NOT NULL,
    -- 証跡の生成に失敗しても指摘自体は残せるようにする (証跡なしを許容)
    evidence_id uuid REFERENCES app.review_evidence(id) ON DELETE SET NULL,
    -- MVP は 2 値から始める (docs/prototype-review.md 6.2)
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
    created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- スレッドに属するコメント・返信 (Phase 2 では投稿時の初回コメントのみ作られる)
CREATE TABLE app.feedback_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id uuid NOT NULL REFERENCES app.feedback_threads(id) ON DELETE CASCADE,
    author_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz
);

CREATE INDEX feedback_threads_session_idx ON app.feedback_threads(review_session_id, created_at);
CREATE INDEX feedback_threads_project_status_idx ON app.feedback_threads(project_id, status, created_at);
CREATE INDEX feedback_messages_thread_idx ON app.feedback_messages(thread_id, created_at);
