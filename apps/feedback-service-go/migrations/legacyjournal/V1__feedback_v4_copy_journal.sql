-- 旧Web GISコピーCLI専用。Feedback Service本体のschema履歴から分離する。
CREATE TABLE feedback_migration.legacy_migration_runs (
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
    ON feedback_migration.legacy_migration_runs(source_system, source_checksum, workspace_id)
    WHERE status = 'applied';

CREATE TABLE feedback_migration.legacy_migration_entities (
    run_id uuid NOT NULL REFERENCES feedback_migration.legacy_migration_runs(id) ON DELETE CASCADE,
    entity_type varchar(50) NOT NULL,
    entity_key varchar(1000) NOT NULL,
    PRIMARY KEY (run_id, entity_type, entity_key)
);
