-- Feedback System独立DBの収束済みbaseline。旧consumer移行台帳は含めない。
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
ALTER TABLE feedback.export_jobs
    ADD COLUMN error varchar(2000),
    ADD COLUMN started_at timestamptz,
    ADD COLUMN completed_at timestamptz,
    ADD COLUMN claim_token uuid;

CREATE INDEX export_jobs_claim_idx
    ON feedback.export_jobs(status, created_at)
    WHERE status IN ('queued', 'running');

ALTER TABLE feedback.workspace_memberships
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE feedback.notification_outbox
    ADD COLUMN retry_cycle integer NOT NULL DEFAULT 0 CHECK (retry_cycle >= 0);

ALTER TABLE feedback.notification_deliveries
    ADD COLUMN retry_cycle integer NOT NULL DEFAULT 0 CHECK (retry_cycle >= 0);

ALTER TABLE feedback.notification_deliveries
    DROP CONSTRAINT notification_deliveries_outbox_id_attempt_key;

ALTER TABLE feedback.notification_deliveries
    ADD CONSTRAINT notification_deliveries_outbox_cycle_attempt_key
    UNIQUE (outbox_id, retry_cycle, attempt);
ALTER TABLE feedback.review_sessions
    ADD COLUMN evidence_retention_days integer
        CHECK (evidence_retention_days BETWEEN 1 AND 3650);

ALTER TABLE feedback.review_evidence
    ADD COLUMN expires_at timestamptz;

CREATE INDEX review_evidence_expires_at_idx
    ON feedback.review_evidence(expires_at)
    WHERE expires_at IS NOT NULL;
-- 独立運用の認証境界・rate limit・観測値を追加する。
-- 適用済み V1〜V3 は変更せず、既存行は現在の membership issuer から安全に backfill する。

ALTER TABLE feedback.application_environments
    ADD COLUMN allowed_issuers text[] NOT NULL DEFAULT '{}';

UPDATE feedback.application_environments environment
SET allowed_issuers = issuers.values
FROM (
    SELECT environment_id, array_agg(DISTINCT issuer ORDER BY issuer) AS values
    FROM (
        SELECT e.id AS environment_id, u.issuer
        FROM feedback.application_environments e
        JOIN feedback.workspaces w ON w.application_id = e.application_id
        JOIN feedback.workspace_memberships membership ON membership.workspace_id = w.id
        JOIN feedback.users u ON u.id = membership.user_id
        UNION
        SELECT e.id AS environment_id, u.issuer
        FROM feedback.application_environments e
        JOIN feedback.application_memberships membership ON membership.application_id = e.application_id
        JOIN feedback.users u ON u.id = membership.user_id
    ) source
    GROUP BY environment_id
) issuers
WHERE issuers.environment_id = environment.id;

CREATE TABLE feedback.write_rate_limit_counters (
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    dimension varchar(20) NOT NULL CHECK (dimension IN ('tenant', 'principal', 'ip')),
    subject_hash varchar(64) NOT NULL,
    window_epoch bigint NOT NULL,
    request_count integer NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (tenant_id, dimension, subject_hash, window_epoch)
);

CREATE TABLE feedback.operational_metric_counters (
    metric_name varchar(100) NOT NULL,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (metric_name, tenant_id)
);

COMMENT ON TABLE feedback.write_rate_limit_counters IS
    'tenant/principal/IP の write rate limit。subject は SHA-256 だけを保持する';
COMMENT ON TABLE feedback.operational_metric_counters IS
    'worker と API process をまたいで集計する単調増加 counter';
CREATE SEQUENCE feedback.feedback_change_sequence AS bigint;

CREATE TABLE feedback.feedback_change_journal (
    sequence bigint PRIMARY KEY DEFAULT nextval('feedback.feedback_change_sequence'),
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    event_type varchar(100) NOT NULL,
    resource_type varchar(100) NOT NULL,
    resource_id varchar(200) NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_change_journal_workspace_sequence_idx
    ON feedback.feedback_change_journal(workspace_id, sequence);

CREATE SEQUENCE feedback.audit_log_sequence AS bigint;
ALTER TABLE feedback.audit_logs ADD COLUMN sequence bigint;
UPDATE feedback.audit_logs SET sequence = nextval('feedback.audit_log_sequence') WHERE sequence IS NULL;
ALTER TABLE feedback.audit_logs
    ALTER COLUMN sequence SET DEFAULT nextval('feedback.audit_log_sequence'),
    ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX audit_logs_sequence_idx ON feedback.audit_logs(sequence);

CREATE TABLE feedback.system_metadata (
    key varchar(100) PRIMARY KEY,
    recorded_at timestamptz NOT NULL
);
INSERT INTO feedback.system_metadata (key, recorded_at)
VALUES ('backup_history_coverage_started_at', now());

CREATE TABLE feedback.backup_policies (
    workspace_id uuid PRIMARY KEY REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    timezone varchar(100) NOT NULL DEFAULT 'Asia/Tokyo',
    full_backup_at time NOT NULL DEFAULT '02:00:00',
    incremental_interval_minutes integer NOT NULL DEFAULT 60
        CHECK (incremental_interval_minutes BETWEEN 15 AND 1440),
    include_evidence boolean NOT NULL DEFAULT true,
    retention_days integer CHECK (retention_days BETWEEN 1 AND 3650),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.backup_runs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES feedback.tenants(id) ON DELETE CASCADE,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    kind varchar(20) NOT NULL CHECK (kind IN ('full', 'incremental')),
    scheduled_for timestamptz NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
    from_change_sequence bigint NOT NULL DEFAULT 0 CHECK (from_change_sequence >= 0),
    to_change_sequence bigint CHECK (to_change_sequence >= 0),
    from_audit_sequence bigint NOT NULL DEFAULT 0 CHECK (from_audit_sequence >= 0),
    to_audit_sequence bigint CHECK (to_audit_sequence >= 0),
    include_evidence boolean NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    claim_token uuid,
    claimed_at timestamptz,
    object_key varchar(1000),
    archive_sha256 varchar(64),
    archive_bytes bigint CHECK (archive_bytes >= 0),
    entry_counts jsonb,
    history_coverage_started_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    completed_at timestamptz,
    error varchar(2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, kind, scheduled_for)
);
CREATE INDEX backup_runs_claim_idx
    ON feedback.backup_runs(status, available_at, scheduled_for);
CREATE INDEX backup_runs_workspace_idx
    ON feedback.backup_runs(workspace_id, created_at DESC, id DESC);

CREATE TABLE feedback.connector_installations (
    id uuid PRIMARY KEY,
    connector_key varchar(100) NOT NULL UNIQUE,
    display_name varchar(200) NOT NULL,
    protocol_version varchar(20) NOT NULL DEFAULT '1',
    manifest_url varchar(2000) NOT NULL,
    delivery_url varchar(2000) NOT NULL,
    health_url varchar(2000) NOT NULL,
    allowed_hosts text[] NOT NULL,
    signing_secret_ciphertext bytea NOT NULL,
    signing_secret_nonce bytea NOT NULL,
    supported_events text[] NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    health_status varchar(20) NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
    health_checked_at timestamptz,
    health_error varchar(2000),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback.notification_connectors (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL REFERENCES feedback.connector_installations(id) ON DELETE RESTRICT,
    name varchar(200) NOT NULL,
    destination_ref varchar(200) NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    include_body boolean NOT NULL DEFAULT false,
    legacy_settings boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX notification_connectors_workspace_name_idx
    ON feedback.notification_connectors(workspace_id, name)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX notification_connectors_legacy_settings_idx
    ON feedback.notification_connectors(workspace_id)
    WHERE legacy_settings AND deleted_at IS NULL;

CREATE TABLE feedback.connector_delivery_queue (
    id uuid PRIMARY KEY,
    outbox_id uuid NOT NULL REFERENCES feedback.notification_outbox(id) ON DELETE CASCADE,
    connector_id uuid NOT NULL REFERENCES feedback.notification_connectors(id) ON DELETE CASCADE,
    status varchar(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
    retry_cycle integer NOT NULL DEFAULT 0 CHECK (retry_cycle >= 0),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    delivered_at timestamptz,
    last_error varchar(2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outbox_id, connector_id)
);
CREATE INDEX connector_delivery_queue_claim_idx
    ON feedback.connector_delivery_queue(status, available_at, created_at);

CREATE TABLE feedback.connector_delivery_attempts (
    id uuid PRIMARY KEY,
    queue_id uuid NOT NULL REFERENCES feedback.connector_delivery_queue(id) ON DELETE CASCADE,
    retry_cycle integer NOT NULL CHECK (retry_cycle >= 0),
    attempt integer NOT NULL CHECK (attempt > 0),
    status varchar(20) NOT NULL CHECK (status IN ('delivered', 'failed')),
    response_status integer,
    error varchar(2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (queue_id, retry_cycle, attempt)
);

COMMENT ON TABLE feedback.feedback_change_journal IS
    'バックアップ差分の単調増加カーソル。V5適用後のフィードバック変更を同一transactionで記録する';
COMMENT ON TABLE feedback.system_metadata IS
    '収束済みbaselineでも失われない、機能保証開始時点などのsystem metadata';
COMMENT ON TABLE feedback.connector_installations IS
    'platform operatorが登録する別プロセス通知コネクタのcatalog';
-- Go migratorへの所有権移管marker。
--
-- このmigrationは既存の業務tableを変更しない。Go版default化とKotlin撤去が完了するまで
-- 業務DDLはV6のまま凍結し、V7以降はGo migratorだけが適用する。
CREATE TABLE feedback.go_schema_migrations (
    version bigint PRIMARY KEY CHECK (version >= 6),
    description varchar(200) NOT NULL,
    kind varchar(20) NOT NULL CHECK (kind IN ('baseline', 'migration')),
    checksum_sha256 varchar(64),
    schema_fingerprint_sha256 varchar(64),
    state varchar(20) NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT go_schema_migrations_checksum_format CHECK (
        checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT go_schema_migrations_fingerprint_format CHECK (
        schema_fingerprint_sha256 IS NULL OR schema_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT go_schema_migrations_completion_state CHECK (
        (state = 'started' AND completed_at IS NULL) OR
        (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    ),
    CONSTRAINT go_schema_migrations_kind_contract CHECK (
        (
            kind = 'baseline' AND
            version = 6 AND
            checksum_sha256 IS NULL AND
            schema_fingerprint_sha256 IS NOT NULL AND
            state = 'succeeded'
        ) OR
        (
            kind = 'migration' AND
            version >= 7 AND
            checksum_sha256 IS NOT NULL
        )
    )
);

INSERT INTO feedback.go_schema_migrations (
    version,
    description,
    kind,
    checksum_sha256,
    schema_fingerprint_sha256,
    state,
    completed_at
) VALUES (
    6,
    'Flyway V1-V6 to Go migrator handoff',
    'baseline',
    NULL,
    'de8ba8a564a39b533e92b37ebffd32bc1a6fbfb66addaad4f56dbd78cb934259',
    'succeeded',
    now()
);

COMMENT ON TABLE feedback.go_schema_migrations IS
    'V6はFlyway handoff marker、V7以降はGo migratorのSHA-256・開始・完了状態を記録する';
COMMENT ON COLUMN feedback.go_schema_migrations.schema_fingerprint_sha256 IS
    'V1〜V5業務schemaのcolumn・constraint・indexをrestore安定化してcanonical化したSHA-256。Flyway/Go履歴tableは対象外';
