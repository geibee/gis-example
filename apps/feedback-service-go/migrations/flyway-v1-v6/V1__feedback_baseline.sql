CREATE SCHEMA IF NOT EXISTS feedback;

CREATE TABLE feedback.tenants (
    id uuid PRIMARY KEY,
    tenant_key varchar(100) NOT NULL UNIQUE,
    display_name varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.applications (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_key varchar(63) NOT NULL UNIQUE,
    display_name varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, application_key)
);

CREATE TABLE feedback.application_environments (
    id uuid PRIMARY KEY,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_key varchar(100) NOT NULL,
    base_url varchar(2000) NOT NULL,
    allowed_origins text[] NOT NULL DEFAULT '{}',
    deep_link_thread_parameter varchar(100) NOT NULL DEFAULT 'feedbackThread',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, environment_key)
);

CREATE TABLE feedback.application_manifests (
    id uuid PRIMARY KEY,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    manifest_version varchar(100) NOT NULL,
    manifest jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, manifest_version)
);
CREATE INDEX application_manifests_latest_idx
    ON feedback.application_manifests(application_id, created_at DESC);

CREATE TABLE feedback.workspaces (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    external_workspace_key varchar(200) NOT NULL,
    display_name varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, external_workspace_key)
);

CREATE TABLE feedback.users (
    id uuid PRIMARY KEY,
    issuer varchar(1000) NOT NULL,
    subject varchar(200) NOT NULL,
    email varchar(320),
    display_name varchar(200),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

CREATE TABLE feedback.workspace_memberships (
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    permissions text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    CHECK (permissions <@ ARRAY['feedback.read', 'feedback.comment', 'feedback.manage', 'feedback.admin']::text[])
);

CREATE TABLE feedback.application_memberships (
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    permissions text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_id, user_id),
    CHECK (permissions <@ ARRAY['feedback.read', 'feedback.comment', 'feedback.manage', 'feedback.admin']::text[])
);

CREATE TABLE feedback.review_sessions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    manifest_version varchar(100) NOT NULL,
    title varchar(200) NOT NULL,
    description varchar(5000),
    status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
    out_of_scope_posting varchar(20) NOT NULL DEFAULT 'warn' CHECK (out_of_scope_posting IN ('allow', 'warn', 'deny')),
    start_at timestamptz,
    end_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_at IS NULL OR start_at IS NULL OR end_at >= start_at)
);
CREATE UNIQUE INDEX review_sessions_one_open_idx
    ON feedback.review_sessions(application_id, environment_id, workspace_id)
    WHERE status = 'open';
CREATE INDEX review_sessions_scope_idx
    ON feedback.review_sessions(application_id, environment_id, workspace_id, created_at DESC);

CREATE TABLE feedback.review_scopes (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES feedback.review_sessions(id) ON DELETE CASCADE,
    page_key varchar(100) NOT NULL,
    route_template varchar(500),
    reviewable boolean NOT NULL,
    UNIQUE NULLS NOT DISTINCT (session_id, page_key, route_template)
);

CREATE TABLE feedback.review_session_perspectives (
    session_id uuid NOT NULL REFERENCES feedback.review_sessions(id) ON DELETE CASCADE,
    code varchar(100) NOT NULL,
    label varchar(200) NOT NULL,
    status varchar(20) NOT NULL CHECK (status IN ('active', 'future', 'out-of-scope')),
    guidance varchar(5000),
    PRIMARY KEY (session_id, code)
);

CREATE TABLE feedback.thread_sequences (
    session_id uuid PRIMARY KEY REFERENCES feedback.review_sessions(id) ON DELETE CASCADE,
    next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0)
);

CREATE TABLE feedback.feedback_threads (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES feedback.review_sessions(id) ON DELETE CASCADE,
    display_number integer NOT NULL CHECK (display_number > 0),
    location jsonb NOT NULL,
    target jsonb NOT NULL,
    perspective_code varchar(100) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    reporter_principal_id varchar(200) NOT NULL,
    reporter_display_name varchar(200),
    reporter_participant_name varchar(100),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, display_number)
);
CREATE INDEX feedback_threads_session_idx
    ON feedback.feedback_threads(session_id, created_at DESC, id DESC);

CREATE TABLE feedback.feedback_messages (
    id uuid PRIMARY KEY,
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    author_principal_id varchar(200) NOT NULL,
    author_display_name varchar(200),
    author_participant_name varchar(100),
    body varchar(20000) NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz
);
CREATE INDEX feedback_messages_thread_idx
    ON feedback.feedback_messages(thread_id, created_at, id);

CREATE TABLE feedback.feedback_message_versions (
    message_id uuid NOT NULL REFERENCES feedback.feedback_messages(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    author_principal_id varchar(200) NOT NULL,
    author_display_name varchar(200),
    author_participant_name varchar(100),
    body varchar(20000) NOT NULL,
    created_at timestamptz NOT NULL,
    edited_at timestamptz,
    PRIMARY KEY (message_id, version)
);

CREATE TABLE feedback.review_evidence (
    id uuid PRIMARY KEY,
    thread_id uuid NOT NULL UNIQUE REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    object_key varchar(1000) NOT NULL UNIQUE,
    content_type varchar(50) NOT NULL CHECK (content_type IN ('image/png', 'image/webp')),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    sha256 varchar(64) NOT NULL,
    viewport_width integer NOT NULL CHECK (viewport_width > 0),
    viewport_height integer NOT NULL CHECK (viewport_height > 0),
    pixel_ratio numeric(4,2) NOT NULL CHECK (pixel_ratio >= 0.1 AND pixel_ratio <= 8),
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.retention_policies (
    workspace_id uuid PRIMARY KEY REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    evidence_retention_days integer CHECK (evidence_retention_days BETWEEN 1 AND 3650),
    export_retention_days integer NOT NULL DEFAULT 7 CHECK (export_retention_days BETWEEN 1 AND 365),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.notification_settings (
    workspace_id uuid PRIMARY KEY REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    webhook_enabled boolean NOT NULL DEFAULT false,
    webhook_endpoint_ciphertext bytea,
    webhook_endpoint_nonce bytea,
    include_body boolean NOT NULL DEFAULT false,
    include_evidence boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT webhook_enabled OR (webhook_endpoint_ciphertext IS NOT NULL AND webhook_endpoint_nonce IS NOT NULL)),
    CHECK ((webhook_endpoint_ciphertext IS NULL) = (webhook_endpoint_nonce IS NULL))
);

CREATE TABLE feedback.notification_outbox (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    event_type varchar(100) NOT NULL,
    payload jsonb NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    delivered_at timestamptz,
    last_error varchar(2000),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_outbox_claim_idx
    ON feedback.notification_outbox(status, available_at, created_at);

CREATE TABLE feedback.notification_deliveries (
    id uuid PRIMARY KEY,
    outbox_id uuid NOT NULL REFERENCES feedback.notification_outbox(id) ON DELETE CASCADE,
    attempt integer NOT NULL CHECK (attempt > 0),
    status varchar(20) NOT NULL CHECK (status IN ('delivered', 'failed')),
    response_status integer,
    error varchar(2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outbox_id, attempt)
);

CREATE TABLE feedback.export_jobs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    session_id uuid REFERENCES feedback.review_sessions(id) ON DELETE SET NULL,
    requested_by varchar(200) NOT NULL,
    format varchar(10) NOT NULL CHECK (format IN ('csv', 'xlsx')),
    locale varchar(35) NOT NULL,
    timezone varchar(100) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    object_key varchar(1000),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.idempotency_records (
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    principal_id varchar(200) NOT NULL,
    endpoint varchar(500) NOT NULL,
    idempotency_key varchar(200) NOT NULL,
    request_hash varchar(64) NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, endpoint, idempotency_key)
);

CREATE TABLE feedback.rate_limit_counters (
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    principal_id varchar(200) NOT NULL,
    window_epoch bigint NOT NULL,
    request_count integer NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (tenant_id, principal_id, window_epoch)
);

CREATE TABLE feedback.audit_logs (
    id uuid PRIMARY KEY,
    tenant_id uuid REFERENCES feedback.tenants(id) ON DELETE SET NULL,
    application_id uuid REFERENCES feedback.applications(id) ON DELETE SET NULL,
    workspace_id uuid REFERENCES feedback.workspaces(id) ON DELETE SET NULL,
    principal_id varchar(200),
    action varchar(100) NOT NULL,
    resource_type varchar(100),
    resource_id varchar(200),
    outcome varchar(20) NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
    request_id varchar(200) NOT NULL,
    changes jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_scope_idx
    ON feedback.audit_logs(tenant_id, workspace_id, occurred_at DESC);

COMMENT ON SCHEMA feedback IS 'Web GIS から独立した Feedback Service 専用スキーマ';
