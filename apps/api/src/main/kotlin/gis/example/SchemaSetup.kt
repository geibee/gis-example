// 業務スキーマ (app.*) のテーブル・インデックス定義と初期データ投入 (ensureBusinessSchema)

package gis.example

fun Database.ensureBusinessSchema() {
    dataSource.connection.use { connection ->
        connection.createStatement().use { stmt ->
            stmt.execute(
                """
                CREATE EXTENSION IF NOT EXISTS pg_trgm;

                CREATE TABLE IF NOT EXISTS app.lands (
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

                CREATE TABLE IF NOT EXISTS app.buildings (
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

                CREATE TABLE IF NOT EXISTS app.parties (
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

                CREATE TABLE IF NOT EXISTS app.zones (
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

                CREATE TABLE IF NOT EXISTS app.party_relationships (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                    party_id text NOT NULL REFERENCES app.parties(id) ON DELETE CASCADE,
                    target_type text NOT NULL CHECK (target_type IN ('land', 'building')),
                    target_id text NOT NULL,
                    relation_type text NOT NULL,
                    note text,
                    created_at timestamptz NOT NULL DEFAULT now()
                );

                CREATE TABLE IF NOT EXISTS app.result_sets (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
                    name text NOT NULL,
                    criteria jsonb NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                );

                ALTER TABLE app.layers
                    ADD COLUMN IF NOT EXISTS result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL;
                ALTER TABLE app.layers
                    ADD COLUMN IF NOT EXISTS source_layer_id uuid REFERENCES app.layers(id) ON DELETE SET NULL;
                ALTER TABLE app.layers
                    ADD COLUMN IF NOT EXISTS layer_role text NOT NULL DEFAULT 'generic';
                ALTER TABLE app.import_jobs
                    ADD COLUMN IF NOT EXISTS layer_role text NOT NULL DEFAULT 'generic';
                ALTER TABLE app.analysis_jobs
                    ADD COLUMN IF NOT EXISTS result_set_id uuid REFERENCES app.result_sets(id) ON DELETE SET NULL;
                ALTER TABLE app.zones
                    ADD COLUMN IF NOT EXISTS zone_layer_id uuid REFERENCES app.layers(id) ON DELETE RESTRICT;
                ALTER TABLE app.zones
                    ADD COLUMN IF NOT EXISTS zone_feature_id text;
                UPDATE app.zones
                SET zone_layer_id = COALESCE(zone_layer_id, source_layer_id),
                    zone_feature_id = COALESCE(zone_feature_id, source_feature_id)
                WHERE zone_layer_id IS NULL OR zone_feature_id IS NULL;
                ALTER TABLE app.zones
                    ALTER COLUMN zone_layer_id SET NOT NULL,
                    ALTER COLUMN zone_feature_id SET NOT NULL;
                ALTER TABLE app.lands
                    ADD COLUMN IF NOT EXISTS registered_owner text,
                    ADD COLUMN IF NOT EXISTS right_type text,
                    ADD COLUMN IF NOT EXISTS registration_cause text,
                    ADD COLUMN IF NOT EXISTS registration_accepted_on date;
                ALTER TABLE app.buildings
                    ADD COLUMN IF NOT EXISTS building_location text,
                    ADD COLUMN IF NOT EXISTS house_number text,
                    ADD COLUMN IF NOT EXISTS registered_owner text,
                    ADD COLUMN IF NOT EXISTS right_type text,
                    ADD COLUMN IF NOT EXISTS registration_accepted_on date;
                ALTER TABLE app.parties
                    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

                CREATE INDEX IF NOT EXISTS lands_project_search_idx ON app.lands(project_id, id);
                CREATE INDEX IF NOT EXISTS lands_source_feature_idx ON app.lands(source_layer_id, source_feature_id);
                CREATE INDEX IF NOT EXISTS buildings_project_search_idx ON app.buildings(project_id, id);
                CREATE INDEX IF NOT EXISTS buildings_land_idx ON app.buildings(land_id);
                CREATE INDEX IF NOT EXISTS buildings_source_feature_idx ON app.buildings(source_layer_id, source_feature_id);
                CREATE INDEX IF NOT EXISTS parties_project_search_idx ON app.parties(project_id, id);
                CREATE INDEX IF NOT EXISTS zones_project_search_idx ON app.zones(project_id, id);
                CREATE INDEX IF NOT EXISTS zones_source_feature_idx ON app.zones(source_layer_id, source_feature_id);
                CREATE UNIQUE INDEX IF NOT EXISTS zones_zone_feature_unique_idx ON app.zones(zone_layer_id, zone_feature_id);
                CREATE INDEX IF NOT EXISTS zones_zone_feature_idx ON app.zones(zone_layer_id, zone_feature_id);
                CREATE INDEX IF NOT EXISTS party_relationships_party_idx ON app.party_relationships(party_id);
                CREATE INDEX IF NOT EXISTS party_relationships_target_idx ON app.party_relationships(target_type, target_id);
                CREATE INDEX IF NOT EXISTS result_sets_project_created_idx ON app.result_sets(project_id, created_at);
                CREATE INDEX IF NOT EXISTS layers_result_set_idx ON app.layers(result_set_id, created_at);
                CREATE INDEX IF NOT EXISTS layers_source_layer_idx ON app.layers(source_layer_id);
                CREATE INDEX IF NOT EXISTS layers_role_idx ON app.layers(layer_role, project_id);
                CREATE INDEX IF NOT EXISTS lands_search_text_trgm_idx ON app.lands USING gin (
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
                CREATE INDEX IF NOT EXISTS buildings_search_text_trgm_idx ON app.buildings USING gin (
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
                CREATE INDEX IF NOT EXISTS parties_search_text_trgm_idx ON app.parties USING gin (
                    lower(
                        coalesce(id, '') || ' ' ||
                        coalesce(name, '') || ' ' ||
                        coalesce(party_type, '') || ' ' ||
                        coalesce(contact, '') || ' ' ||
                        coalesce(address, '') || ' ' ||
                        coalesce(memo, '')
                    ) gin_trgm_ops
                );
                CREATE INDEX IF NOT EXISTS zones_search_text_trgm_idx ON app.zones USING gin (
                    lower(
                        coalesce(id, '') || ' ' ||
                        coalesce(name, '') || ' ' ||
                        coalesce(zone_type, '') || ' ' ||
                        coalesce(status, '') || ' ' ||
                        coalesce(memo, '')
                    ) gin_trgm_ops
                );

                INSERT INTO app.projects (id, name)
                VALUES ('00000000-0000-0000-0000-000000000000', 'Default project')
                ON CONFLICT (id) DO NOTHING;
                """.trimIndent()
            )
        }
    }
}
