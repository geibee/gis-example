-- V1: ベースライン。Flyway 導入時点 (issue #12) の到達スキーマを凍結したもの
-- (旧 infra/postgres/init.sql の DDL + 旧 SchemaSetup.kt ensureBusinessSchema() の到達状態)。
--
-- Flyway 導入前にテーブルが作成済みの既存 DB では、この V1 は実行されず
-- baselineOnMigrate によって「適用済み」として記録される (docs/db-migrations.md)。
--
-- 注意: このファイルは適用済みのため編集禁止。スキーマ変更は V2 以降を追加する。

-- pg_trgm は全文検索インデックス (gin_trgm_ops) に必要。
-- 開発 compose では infra/postgres/init.sql が superuser として作成済みのため no-op。
-- アプリユーザーに CREATE EXTENSION 権限が無い環境では、事前に DBA が作成しておくこと
-- (作成済みであれば IF NOT EXISTS は権限チェックなしでスキップされる)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gis_data は worker (GDAL 取込) が作るレイヤテーブルの置き場。
-- app スキーマは Flyway (createSchemas) が作成する
CREATE SCHEMA IF NOT EXISTS gis_data;

CREATE TABLE app.projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 認証済みユーザー (OIDC の subject と突合)。初回アクセス時に JIT 登録される
CREATE TABLE app.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject text NOT NULL UNIQUE,
    email text,
    display_name text,
    system_role text NOT NULL DEFAULT 'user' CHECK (system_role IN ('admin', 'user')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- プロジェクト単位のメンバーシップ (認可の可変データ)。
-- ロールが何をできるかは API コード側の権限マトリクスが定義する
CREATE TABLE app.project_members (
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, project_id)
);

-- 監査ログ: 変更系操作の成功と認証失敗・認可拒否を記録する (追記のみ、更新しない)
CREATE TABLE app.audit_logs (
    id bigserial PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    user_id uuid,
    subject text,
    action text,
    decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
    project_id uuid,
    http_method text NOT NULL,
    path text NOT NULL,
    status_code integer NOT NULL,
    detail jsonb
);

CREATE TABLE app.result_sets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    criteria jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.layers (
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
    layer_role text NOT NULL DEFAULT 'generic',
    result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL,
    source_layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL,
    tile_source_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schema_name, table_name)
);

CREATE TABLE app.layer_attributes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE CASCADE,
    name text NOT NULL,
    data_type text NOT NULL,
    ordinal_position integer NOT NULL,
    is_geometry boolean NOT NULL DEFAULT false,
    UNIQUE (layer_id, name)
);

CREATE TABLE app.import_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    filename text NOT NULL,
    format text NOT NULL,
    source_srid integer,
    upload_path text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    error_message text,
    layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL,
    layer_role text NOT NULL DEFAULT 'generic',
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);

CREATE TABLE app.analysis_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    criteria jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    error_message text,
    result_layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL,
    result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL,
    result_count bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);

CREATE TABLE app.lands (
    id text PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    lot_number text NOT NULL,
    address text NOT NULL,
    land_use text,
    area_sqm double precision,
    registered_owner text,
    right_type text,
    registration_cause text,
    registration_accepted_on date,
    status text NOT NULL DEFAULT '調査中',
    memo text,
    source_layer_id uuid,
    source_feature_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.buildings (
    id text PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    land_id text REFERENCES app.lands(id) ON DELETE SET NULL,
    name text NOT NULL,
    building_location text,
    house_number text,
    building_use text,
    floors integer,
    total_floor_area_sqm double precision,
    structure text,
    registered_owner text,
    right_type text,
    registration_accepted_on date,
    status text NOT NULL DEFAULT '調査中',
    memo text,
    source_layer_id uuid,
    source_feature_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.parties (
    id text PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    party_type text NOT NULL,
    contact text,
    address text,
    memo text,
    tags text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.zones (
    id text PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    zone_type text,
    status text NOT NULL DEFAULT '有効',
    memo text,
    zone_layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE RESTRICT,
    zone_feature_id text NOT NULL,
    source_layer_id uuid NOT NULL REFERENCES app.layers(id) ON DELETE RESTRICT,
    source_feature_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (zone_layer_id, zone_feature_id)
);

CREATE TABLE app.party_relationships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
    party_id text NOT NULL REFERENCES app.parties(id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('land', 'building')),
    target_id text NOT NULL,
    relation_type text NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_members_project_idx ON app.project_members(project_id);
CREATE INDEX audit_logs_occurred_idx ON app.audit_logs(occurred_at);
CREATE INDEX audit_logs_user_idx ON app.audit_logs(user_id, occurred_at);
CREATE INDEX import_jobs_status_idx ON app.import_jobs(status, created_at);
CREATE INDEX analysis_jobs_status_idx ON app.analysis_jobs(status, created_at);
CREATE INDEX layers_project_idx ON app.layers(project_id, created_at);
CREATE INDEX result_sets_project_created_idx ON app.result_sets(project_id, created_at);
CREATE INDEX layers_result_set_idx ON app.layers(result_set_id, created_at);
CREATE INDEX layers_source_layer_idx ON app.layers(source_layer_id);
CREATE INDEX layers_role_idx ON app.layers(layer_role, project_id);
CREATE INDEX lands_project_search_idx ON app.lands(project_id, id);
CREATE INDEX lands_source_feature_idx ON app.lands(source_layer_id, source_feature_id);
CREATE INDEX buildings_project_search_idx ON app.buildings(project_id, id);
CREATE INDEX buildings_land_idx ON app.buildings(land_id);
CREATE INDEX buildings_source_feature_idx ON app.buildings(source_layer_id, source_feature_id);
CREATE INDEX parties_project_search_idx ON app.parties(project_id, id);
CREATE INDEX zones_project_search_idx ON app.zones(project_id, id);
CREATE INDEX zones_source_feature_idx ON app.zones(source_layer_id, source_feature_id);
CREATE INDEX zones_zone_feature_idx ON app.zones(zone_layer_id, zone_feature_id);
-- 旧 SchemaSetup.kt が UNIQUE 制約と別に作成していた重複インデックス (到達状態の凍結)。
-- V2 で削除される
CREATE UNIQUE INDEX zones_zone_feature_unique_idx ON app.zones(zone_layer_id, zone_feature_id);
CREATE INDEX party_relationships_party_idx ON app.party_relationships(party_id);
CREATE INDEX party_relationships_target_idx ON app.party_relationships(target_type, target_id);
CREATE INDEX lands_search_text_trgm_idx ON app.lands USING gin (
    lower(
        coalesce(id, '') || ' ' ||
        coalesce(lot_number, '') || ' ' ||
        coalesce(address, '') || ' ' ||
        coalesce(land_use, '') || ' ' ||
        coalesce(status, '') || ' ' ||
        coalesce(memo, '') || ' ' ||
        coalesce(registered_owner, '') || ' ' ||
        coalesce(right_type, '') || ' ' ||
        coalesce(registration_cause, '')
    ) gin_trgm_ops
);
CREATE INDEX buildings_search_text_trgm_idx ON app.buildings USING gin (
    lower(
        coalesce(id, '') || ' ' ||
        coalesce(name, '') || ' ' ||
        coalesce(building_location, '') || ' ' ||
        coalesce(house_number, '') || ' ' ||
        coalesce(building_use, '') || ' ' ||
        coalesce(structure, '') || ' ' ||
        coalesce(status, '') || ' ' ||
        coalesce(memo, '') || ' ' ||
        coalesce(registered_owner, '') || ' ' ||
        coalesce(right_type, '')
    ) gin_trgm_ops
);
CREATE INDEX parties_search_text_trgm_idx ON app.parties USING gin (
    lower(
        coalesce(id, '') || ' ' ||
        coalesce(name, '') || ' ' ||
        coalesce(party_type, '') || ' ' ||
        coalesce(contact, '') || ' ' ||
        coalesce(address, '') || ' ' ||
        coalesce(memo, '')
    ) gin_trgm_ops
);
CREATE INDEX zones_search_text_trgm_idx ON app.zones USING gin (
    lower(
        coalesce(id, '') || ' ' ||
        coalesce(name, '') || ' ' ||
        coalesce(zone_type, '') || ' ' ||
        coalesce(status, '') || ' ' ||
        coalesce(memo, '')
    ) gin_trgm_ops
);

-- ブートストラップ用の既定プロジェクト (シードではなくスキーマと不可分の参照データ)
INSERT INTO app.projects (id, name)
VALUES ('00000000-0000-0000-0000-000000000000', 'Default project')
ON CONFLICT (id) DO NOTHING;
