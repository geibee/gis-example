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
