CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS gis_data;

CREATE TABLE IF NOT EXISTS app.projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.layers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    schema_name text NOT NULL DEFAULT 'gis_data',
    table_name text NOT NULL,
    geometry_column text NOT NULL DEFAULT 'geom',
    geometry_type text NOT NULL DEFAULT 'GEOMETRY',
    source_srid integer,
    display_srid integer NOT NULL DEFAULT 3857,
    feature_id_column text NOT NULL DEFAULT 'fid',
    bbox_4326 jsonb,
    row_count bigint NOT NULL DEFAULT 0,
    is_result boolean NOT NULL DEFAULT false,
    tile_source_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS app.layer_attributes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE CASCADE,
    name text NOT NULL,
    data_type text NOT NULL,
    ordinal_position integer NOT NULL,
    is_geometry boolean NOT NULL DEFAULT false,
    UNIQUE (layer_id, name)
);

CREATE TABLE IF NOT EXISTS app.import_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    filename text NOT NULL,
    format text NOT NULL,
    source_srid integer,
    upload_path text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    error_message text,
    layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS app.analysis_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    criteria jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    error_message text,
    result_layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL,
    result_count bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS import_jobs_status_idx ON app.import_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx ON app.analysis_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS layers_project_idx ON app.layers(project_id, created_at);

INSERT INTO app.projects (id, name)
VALUES ('00000000-0000-0000-0000-000000000000', 'Default project')
ON CONFLICT (id) DO NOTHING;
