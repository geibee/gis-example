-- 統合テスト用の極小合成フィクスチャ (3857 の平面座標で境界条件を厳密に制御する)
--
-- parcels: P1 (0..100, 商業地域) / P2 (200..300, 住居地域) / P3 (1000..1100, 商業地域・孤立)
-- points:  駅A (P1 内部) / 駅B (P2 内部) / 駅C (P1 の縁 x=100 から東へちょうど 50m)
CREATE TABLE gis_data.it_parcels (
    fid bigint PRIMARY KEY,
    zoning_name text,
    geom geometry(MultiPolygon, 3857)
);
INSERT INTO gis_data.it_parcels VALUES
  (1, '商業地域',       ST_Multi(ST_GeomFromText('POLYGON((0 0, 100 0, 100 100, 0 100, 0 0))', 3857))),
  (2, '第一種住居地域', ST_Multi(ST_GeomFromText('POLYGON((200 0, 300 0, 300 100, 200 100, 200 0))', 3857))),
  (3, '商業地域',       ST_Multi(ST_GeomFromText('POLYGON((1000 1000, 1100 1000, 1100 1100, 1000 1100, 1000 1000))', 3857)));
CREATE INDEX ON gis_data.it_parcels USING GIST (geom);

CREATE TABLE gis_data.it_points (
    fid bigint PRIMARY KEY,
    station_name text,
    geom geometry(Point, 3857)
);
INSERT INTO gis_data.it_points VALUES
  (1, '駅A', ST_GeomFromText('POINT(50 50)', 3857)),
  (2, '駅B', ST_GeomFromText('POINT(250 50)', 3857)),
  (3, '駅C', ST_GeomFromText('POINT(150 50)', 3857));
CREATE INDEX ON gis_data.it_points USING GIST (geom);

-- P1 と東辺 (x=100) を共有して接する隣接ポリゴン (touch は intersects に含まれることの検証用)
CREATE TABLE gis_data.it_adjacent (
    fid bigint PRIMARY KEY,
    geom geometry(MultiPolygon, 3857)
);
INSERT INTO gis_data.it_adjacent VALUES
  (1, ST_Multi(ST_GeomFromText('POLYGON((100 0, 200 0, 200 100, 100 100, 100 0))', 3857)));
CREATE INDEX ON gis_data.it_adjacent USING GIST (geom);

INSERT INTO app.layers (id, project_id, name, table_name, geometry_type, source_srid, bbox_4326, row_count, is_result, tile_source_id)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'テスト筆', 'it_parcels', 'MULTIPOLYGON', 3857, '[0,0,0.01,0.01]', 3, false, 'it_parcels'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'テスト駅', 'it_points', 'POINT', 3857, '[0,0,0.01,0.01]', 3, false, 'it_points'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'テスト隣接', 'it_adjacent', 'MULTIPOLYGON', 3857, '[0,0,0.01,0.01]', 1, false, 'it_adjacent');

INSERT INTO app.layer_attributes (layer_id, name, data_type, ordinal_position, is_geometry) VALUES
  ('11111111-1111-1111-1111-111111111111', 'fid', 'bigint', 1, false),
  ('11111111-1111-1111-1111-111111111111', 'zoning_name', 'text', 2, false),
  ('11111111-1111-1111-1111-111111111111', 'geom', 'geometry', 3, true),
  ('22222222-2222-2222-2222-222222222222', 'fid', 'bigint', 1, false),
  ('22222222-2222-2222-2222-222222222222', 'station_name', 'text', 2, false),
  ('22222222-2222-2222-2222-222222222222', 'geom', 'geometry', 3, true),
  ('33333333-3333-3333-3333-333333333333', 'fid', 'bigint', 1, false),
  ('33333333-3333-3333-3333-333333333333', 'geom', 'geometry', 2, true);

-- 業務データ: P1 に紐づく土地 + 「銀座開発株式会社」が売買事業者
INSERT INTO app.lands (id, project_id, lot_number, address, land_use, status, source_layer_id, source_feature_id)
VALUES ('L-IT-1', '00000000-0000-0000-0000-000000000000', '1-1-1', '中央区テスト1丁目', '宅地', '調査中',
        '11111111-1111-1111-1111-111111111111', '1');

INSERT INTO app.parties (id, project_id, name, party_type)
VALUES ('P-IT-1', '00000000-0000-0000-0000-000000000000', '銀座開発株式会社', '法人');

INSERT INTO app.party_relationships (project_id, party_id, target_type, target_id, relation_type)
VALUES ('00000000-0000-0000-0000-000000000000', 'P-IT-1', 'land', 'L-IT-1', '売買事業者');
