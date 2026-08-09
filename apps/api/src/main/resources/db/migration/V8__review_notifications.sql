-- プロトタイプレビュー管理基盤 Phase 7 (docs/prototype-review.md)。
-- 外部サービスを正本にせず、レビュー更新と同じトランザクションで outbox を作り、
-- Email / Teams / Issue へ一方向に配信する。

CREATE TABLE app.review_notification_settings (
    project_id uuid PRIMARY KEY REFERENCES app.projects(id) ON DELETE CASCADE,
    email_enabled boolean NOT NULL DEFAULT false,
    teams_enabled boolean NOT NULL DEFAULT false,
    issue_enabled boolean NOT NULL DEFAULT false,
    updated_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.review_notification_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    review_session_id uuid NOT NULL REFERENCES app.review_sessions(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES app.feedback_threads(id) ON DELETE CASCADE,
    message_id uuid REFERENCES app.feedback_messages(id) ON DELETE SET NULL,
    event_type text NOT NULL CHECK (
        event_type IN ('THREAD_CREATED', 'MESSAGE_CREATED', 'THREAD_RESOLVED', 'THREAD_REOPENED')
    ),
    actor_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
    -- 証跡画像・保存先・対象画面の状態は外部へ渡さない。通知表示に必要な最小項目だけを固定する
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.review_notification_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id uuid NOT NULL REFERENCES app.review_notification_outbox(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('EMAIL', 'TEAMS', 'ISSUE')),
    -- EMAIL は 1 宛先 1 行にして、途中失敗時に送信済みの宛先へ再送しない
    destination text,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'DELIVERING', 'SUCCEEDED', 'FAILED')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_attempt_at timestamptz,
    delivered_at timestamptz,
    last_error text,
    external_reference text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX review_notification_delivery_unique_idx
    ON app.review_notification_deliveries(outbox_id, channel, coalesce(destination, ''));
CREATE INDEX review_notification_delivery_claim_idx
    ON app.review_notification_deliveries(next_attempt_at, created_at)
    WHERE status IN ('PENDING', 'DELIVERING', 'FAILED');
CREATE INDEX review_notification_outbox_project_idx
    ON app.review_notification_outbox(project_id, created_at DESC);
