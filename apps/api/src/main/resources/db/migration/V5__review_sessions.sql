-- プロトタイプレビュー管理基盤 Phase 1 (docs/prototype-review.md)。
--
-- 中心概念は個々のコメントではなく ReviewSession:「何を・どの画面を・どの観点で
-- レビューしてほしいか」と「今回は見なくてよいか」をレビュー開始前に確定させる。
--
-- app.review_perspectives は dev シードではなくマスタデータ (レビュー観点の語彙) なので、
-- compose の seed ではなくマイグレーションで投入する。組織ごとに観点を足す場合も
-- 行の追加であり、コード変更を伴わない。

-- レビュー活動の単位
CREATE TABLE app.review_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text,
    -- draft: 準備中 / open: レビュー受付中 / closed: 受付終了
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
    start_at timestamptz,
    end_at timestamptz,
    -- 作成者が退職等で削除されてもセッションと証跡は残す
    created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_sessions_period_check CHECK (start_at IS NULL OR end_at IS NULL OR end_at >= start_at)
);

-- レビュー観点のマスタ。code は API・UI が参照する安定識別子
CREATE TABLE app.review_perspectives (
    code text PRIMARY KEY,
    label text NOT NULL,
    description text,
    display_order integer NOT NULL DEFAULT 0
);

-- セッションごとの観点状態。
-- FUTURE / OUT_OF_SCOPE を「行として持つ」ことが要点で、UI にはグレーアウトして表示する。
-- 行が無い観点は非表示 = 「そもそも今回の語彙に入っていない」を意味する
CREATE TABLE app.review_session_perspectives (
    review_session_id uuid NOT NULL REFERENCES app.review_sessions(id) ON DELETE CASCADE,
    perspective_code text NOT NULL REFERENCES app.review_perspectives(code) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'FUTURE', 'OUT_OF_SCOPE')),
    -- 「次回のデザインレビューで確認します」等、顧客へ見せる補足
    guidance text,
    PRIMARY KEY (review_session_id, perspective_code)
);

-- セッション内でレビュー対象となる画面・機能
CREATE TABLE app.review_scopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_session_id uuid NOT NULL REFERENCES app.review_sessions(id) ON DELETE CASCADE,
    -- フロントのルート識別子 (証跡の route と突合する)
    page_id text NOT NULL,
    description text,
    reviewable boolean NOT NULL DEFAULT true,
    display_order integer NOT NULL DEFAULT 0,
    UNIQUE (review_session_id, page_id)
);

CREATE INDEX review_sessions_project_idx ON app.review_sessions(project_id, created_at);
CREATE INDEX review_scopes_session_idx ON app.review_scopes(review_session_id, display_order);

INSERT INTO app.review_perspectives (code, label, description, display_order) VALUES
    ('BUSINESS_FLOW',  '業務フロー',        '一連の業務が想定どおりの流れで進められるか', 10),
    ('INFORMATION',    '項目・情報の過不足', '画面に表示・入力する情報が足りているか、余計でないか', 20),
    ('USABILITY',      '操作性',            '操作の分かりやすさ・手数', 30),
    ('MAP_OPERATION',  '地図操作',          '地図と業務情報の連動、地図上の操作', 40),
    ('UI_DESIGN',      'デザイン・配色',    '画面の見た目・配色・文言', 50),
    ('PERFORMANCE',    '性能',              '表示・検索の速度', 60),
    ('AUTHORIZATION',  '権限制御',          'ロールごとの参照・操作可否', 70),
    ('ERROR_HANDLING', 'エラー処理',        '入力誤り・例外時の挙動', 80);
