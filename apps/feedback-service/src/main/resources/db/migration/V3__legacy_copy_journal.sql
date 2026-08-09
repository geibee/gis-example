-- Phase 4 のコピー移行を追跡し、安全に dry-run / reconcile / rollback するための台帳。
-- 既存 V1/V2 は適用済みのため編集せず、追加 migration で拡張する。

ALTER TABLE feedback.review_sessions
    ADD COLUMN evidence_retention_days integer
        CHECK (evidence_retention_days BETWEEN 1 AND 3650);

ALTER TABLE feedback.review_evidence
    ADD COLUMN expires_at timestamptz;

CREATE INDEX review_evidence_expires_at_idx
    ON feedback.review_evidence(expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE feedback.legacy_migration_runs (
    id uuid PRIMARY KEY,
    source_system varchar(100) NOT NULL,
    source_checksum varchar(64) NOT NULL,
    application_id uuid NOT NULL REFERENCES feedback.applications(id) ON DELETE RESTRICT,
    environment_id uuid NOT NULL REFERENCES feedback.application_environments(id) ON DELETE RESTRICT,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE RESTRICT,
    status varchar(20) NOT NULL CHECK (status IN ('applied', 'rolled-back')),
    summary jsonb NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    rolled_back_at timestamptz
);

CREATE UNIQUE INDEX legacy_migration_runs_active_source_idx
    ON feedback.legacy_migration_runs(source_system, source_checksum, workspace_id)
    WHERE status = 'applied';

CREATE TABLE feedback.legacy_migration_entities (
    run_id uuid NOT NULL REFERENCES feedback.legacy_migration_runs(id) ON DELETE CASCADE,
    entity_type varchar(50) NOT NULL,
    entity_key varchar(1000) NOT NULL,
    PRIMARY KEY (run_id, entity_type, entity_key)
);
