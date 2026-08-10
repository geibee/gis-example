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
    '01d03abc057749179777853ca970bc220f1ee79d8b6fa98d0e0801ba5788e36d',
    'succeeded',
    now()
);

COMMENT ON TABLE feedback.go_schema_migrations IS
    'V6はFlyway handoff marker、V7以降はGo migratorのSHA-256・開始・完了状態を記録する';
COMMENT ON COLUMN feedback.go_schema_migrations.schema_fingerprint_sha256 IS
    'V1〜V5業務schemaのcolumn・constraint・indexをrestore安定化してcanonical化したSHA-256。Flyway/Go履歴tableは対象外';
