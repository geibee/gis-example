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
