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
