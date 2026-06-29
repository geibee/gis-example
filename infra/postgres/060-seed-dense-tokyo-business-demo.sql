-- Dense central Tokyo business demo layers.
-- This seed is deterministic and idempotent. It adds parcel-like land polygons,
-- building footprints, and larger business-zone polygons in the same city area.

SET client_encoding = 'UTF8';

DO $$
DECLARE
    v_land_layer_id uuid := 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid;
    v_building_layer_id uuid := 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1002'::uuid;
    v_zone_layer_id uuid := 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1003'::uuid;
BEGIN
    DELETE FROM app.party_relationships
    WHERE target_id LIKE 'L-DENSE-%' OR target_id LIKE 'B-DENSE-%';

    DELETE FROM app.zones
    WHERE id LIKE 'Z-DENSE-%'
       OR zone_layer_id IN (v_land_layer_id, v_building_layer_id, v_zone_layer_id)
       OR source_layer_id IN (v_land_layer_id, v_building_layer_id, v_zone_layer_id);

    DELETE FROM app.buildings WHERE id LIKE 'B-DENSE-%';
    DELETE FROM app.lands WHERE id LIKE 'L-DENSE-%';
    DELETE FROM app.layer_attributes WHERE layer_id IN (v_land_layer_id, v_building_layer_id, v_zone_layer_id);
    DELETE FROM app.layers WHERE id IN (v_land_layer_id, v_building_layer_id, v_zone_layer_id);

    DROP TABLE IF EXISTS gis_data.layer_demo_moj_parcels_tokyo_core;
    DROP TABLE IF EXISTS gis_data.layer_demo_plateau_buildings_tokyo_core;
    DROP TABLE IF EXISTS gis_data.layer_demo_business_zones_tokyo_core;
END $$;

CREATE TABLE gis_data.layer_demo_moj_parcels_tokyo_core (
    fid integer PRIMARY KEY,
    geom public.geometry(MultiPolygon, 3857),
    source_id text NOT NULL,
    cluster_no integer NOT NULL,
    municipality_name text NOT NULL,
    district_name text NOT NULL,
    lot_number text NOT NULL,
    land_category text NOT NULL,
    source_dataset text NOT NULL,
    note text
);

WITH clusters AS (
    SELECT *
    FROM (VALUES
        (1, '千代田区', '丸の内一丁目', 139.76320::double precision, 35.68115::double precision, '丸の内', 'MOJ-MARU'),
        (2, '中央区', '銀座四丁目', 139.76645::double precision, 35.67195::double precision, '銀座', 'MOJ-GINZA'),
        (3, '港区', '新橋二丁目', 139.75620::double precision, 35.66605::double precision, '新橋', 'MOJ-SHIN'),
        (4, '港区', '虎ノ門一丁目', 139.74895::double precision, 35.67055::double precision, '虎ノ門', 'MOJ-TORA')
    ) AS c(cluster_no, municipality_name, district_name, base_lon, base_lat, block_name, source_prefix)
),
cluster_blocks AS (
    SELECT
        c.*,
        ST_Multi(
            ST_CollectionExtract(
                ST_MakeValid(
                    ST_Intersection(
                        ST_UnaryUnion(ST_Collect(z.geom)),
                        ST_Buffer(ST_Transform(ST_SetSRID(ST_Point(c.base_lon, c.base_lat), 4326), 3857), 180)
                    )
                ),
                3
            )
        ) AS block_geom
    FROM clusters AS c
    JOIN gis_data.layer_a29_tokyo_commercial_zoning_2019 AS z
      ON ST_DWithin(z.geom, ST_Transform(ST_SetSRID(ST_Point(c.base_lon, c.base_lat), 4326), 3857), 650)
    GROUP BY
        c.cluster_no,
        c.municipality_name,
        c.district_name,
        c.base_lon,
        c.base_lat,
        c.block_name,
        c.source_prefix
),
seed_points AS (
    SELECT
        b.*,
        (dumped_point).path[1] AS point_no,
        (dumped_point).geom AS point_geom
    FROM cluster_blocks AS b
    CROSS JOIN LATERAL ST_Dump(ST_GeneratePoints(b.block_geom, 9, b.cluster_no * 101)) AS dumped_point
),
voronoi_cells AS (
    SELECT
        p.*,
        v.cell_geom
    FROM seed_points AS p
    CROSS JOIN LATERAL (
        SELECT (dumped_cell).geom AS cell_geom
        FROM ST_Dump(
            ST_VoronoiPolygons(
                (
                    SELECT ST_Collect(sp.point_geom)
                    FROM seed_points AS sp
                    WHERE sp.cluster_no = p.cluster_no
                ),
                0.0,
                ST_Expand(ST_Envelope(p.block_geom), 50)
            )
        ) AS dumped_cell
    ) AS v
    WHERE ST_Covers(v.cell_geom, p.point_geom)
),
parcels AS (
    SELECT
        row_number() OVER (ORDER BY cluster_no, point_no)::integer AS fid,
        cluster_no,
        municipality_name,
        district_name,
        block_name,
        source_prefix,
        point_no,
        ST_Multi(
            ST_CollectionExtract(
                ST_MakeValid(ST_Intersection(cell_geom, block_geom)),
                3
            )
        ) AS geom
    FROM voronoi_cells
)
INSERT INTO gis_data.layer_demo_moj_parcels_tokyo_core (
    fid,
    geom,
    source_id,
    cluster_no,
    municipality_name,
    district_name,
    lot_number,
    land_category,
    source_dataset,
    note
)
SELECT
    fid,
    geom,
    format('%s-%02s', source_prefix, point_no) AS source_id,
    cluster_no,
    municipality_name,
    district_name,
    format('%s%s', block_name, lpad(point_no::text, 2, '0')) AS lot_number,
    CASE (fid % 4)
        WHEN 0 THEN '宅地'
        WHEN 1 THEN '商業地'
        WHEN 2 THEN '業務地'
        ELSE '雑種地'
    END AS land_category,
    '登記所備付地図データ（デモ抽出）' AS source_dataset,
    '既存の実在用途地域ポリゴンを母材にVoronoi分割した都心デモ用筆ポリゴン' AS note
FROM parcels
WHERE NOT ST_IsEmpty(geom);

CREATE INDEX layer_demo_moj_parcels_tokyo_core_geom_gix
    ON gis_data.layer_demo_moj_parcels_tokyo_core USING gist (geom);
ANALYZE gis_data.layer_demo_moj_parcels_tokyo_core;

CREATE TABLE gis_data.layer_demo_plateau_buildings_tokyo_core (
    fid integer PRIMARY KEY,
    geom public.geometry(MultiPolygon, 3857),
    source_id text NOT NULL,
    cluster_no integer NOT NULL,
    municipality_name text NOT NULL,
    district_name text NOT NULL,
    building_name text NOT NULL,
    measured_height_m double precision,
    usage text NOT NULL,
    source_dataset text NOT NULL,
    note text
);

WITH parcel_src AS (
    SELECT
        fid,
        source_id,
        cluster_no,
        municipality_name,
        district_name,
        lot_number,
        geom AS parcel_geom,
        ST_PointOnSurface(geom) AS center_geom,
        least(greatest(sqrt(ST_Area(geom)) * 0.42, 22), 78) AS footprint_width_m,
        least(greatest(sqrt(ST_Area(geom)) * 0.30, 16), 54) AS footprint_depth_m,
        radians(((fid % 9) - 4) * 7.0) AS rotation_angle
    FROM gis_data.layer_demo_moj_parcels_tokyo_core
),
raw_footprints AS (
    SELECT
        fid,
        source_id,
        cluster_no,
        municipality_name,
        district_name,
        lot_number,
        parcel_geom,
        ST_Translate(
            ST_Rotate(
                ST_SetSRID(
                    ST_MakePolygon(
                        ST_MakeLine(
                            ARRAY[
                                ST_MakePoint(-footprint_width_m / 2, -footprint_depth_m / 2),
                                ST_MakePoint(footprint_width_m * 0.25, -footprint_depth_m / 2),
                                ST_MakePoint(footprint_width_m / 2, -footprint_depth_m * 0.18),
                                ST_MakePoint(footprint_width_m / 2, footprint_depth_m * 0.38),
                                ST_MakePoint(footprint_width_m * 0.18, footprint_depth_m / 2),
                                ST_MakePoint(-footprint_width_m / 2, footprint_depth_m / 2),
                                ST_MakePoint(-footprint_width_m / 2, -footprint_depth_m / 2)
                            ]
                        )
                    ),
                    3857
                ),
                rotation_angle
            ),
            ST_X(center_geom),
            ST_Y(center_geom)
        ) AS raw_geom
    FROM parcel_src
),
building_footprints AS (
    SELECT
        fid,
        source_id,
        cluster_no,
        municipality_name,
        district_name,
        lot_number,
        ST_Multi(
            ST_CollectionExtract(
                ST_MakeValid(
                    CASE
                        WHEN ST_IsEmpty(ST_Intersection(raw_geom, ST_Buffer(parcel_geom, -3, 'join=mitre'))) THEN
                            ST_Intersection(ST_Buffer(ST_PointOnSurface(parcel_geom), 10, 'quad_segs=2'), parcel_geom)
                        ELSE
                            ST_Intersection(raw_geom, ST_Buffer(parcel_geom, -3, 'join=mitre'))
                    END
                ),
                3
            )
        ) AS geom
    FROM raw_footprints
)
INSERT INTO gis_data.layer_demo_plateau_buildings_tokyo_core (
    fid,
    geom,
    source_id,
    cluster_no,
    municipality_name,
    district_name,
    building_name,
    measured_height_m,
    usage,
    source_dataset,
    note
)
SELECT
    fid,
    geom,
    replace(source_id, 'MOJ', 'PLATEAU-BLDG') AS source_id,
    cluster_no,
    municipality_name,
    district_name,
    CASE
        WHEN district_name LIKE '丸の内%' THEN format('丸の内業務ビル %s', lot_number)
        WHEN district_name LIKE '銀座%' THEN format('銀座商業ビル %s', lot_number)
        WHEN district_name LIKE '新橋%' THEN format('新橋複合ビル %s', lot_number)
        ELSE format('虎ノ門業務ビル %s', lot_number)
    END AS building_name,
    (24 + (fid % 9) * 4)::double precision AS measured_height_m,
    CASE (fid % 5)
        WHEN 0 THEN '事務所'
        WHEN 1 THEN '店舗'
        WHEN 2 THEN '事務所・店舗'
        WHEN 3 THEN 'ホテル'
        ELSE '複合用途'
    END AS usage,
    'PLATEAU 建築物モデル（デモ抽出）' AS source_dataset,
    '筆形状内に生成した面取り付き建物フットプリント' AS note
FROM building_footprints
WHERE NOT ST_IsEmpty(geom);

CREATE INDEX layer_demo_plateau_buildings_tokyo_core_geom_gix
    ON gis_data.layer_demo_plateau_buildings_tokyo_core USING gist (geom);
ANALYZE gis_data.layer_demo_plateau_buildings_tokyo_core;

CREATE TABLE gis_data.layer_demo_business_zones_tokyo_core (
    fid integer PRIMARY KEY,
    geom public.geometry(MultiPolygon, 3857),
    zone_code text NOT NULL,
    name text NOT NULL,
    zone_type text NOT NULL,
    source_dataset text NOT NULL,
    note text
);

WITH zone_names AS (
    SELECT *
    FROM (VALUES
        (1, 'ZC-MARUNOUCHI', '丸の内周辺業務区域', '重点調査'),
        (2, 'ZC-GINZA', '銀座周辺業務区域', '商業調査'),
        (3, 'ZC-SHIMBASHI', '新橋周辺業務区域', '再開発候補'),
        (4, 'ZC-TORANOMON', '虎ノ門周辺業務区域', '重点調査')
    ) AS c(fid, zone_code, name, zone_type)
),
zone_geoms AS (
    SELECT
        z.fid,
        z.zone_code,
        z.name,
        z.zone_type,
        ST_Multi(
            ST_CollectionExtract(
                ST_MakeValid(
                    ST_Buffer(
                        ST_UnaryUnion(ST_Collect(p.geom)),
                        35,
                        'join=mitre'
                    )
                ),
                3
            )
        ) AS geom
    FROM zone_names AS z
    JOIN gis_data.layer_demo_moj_parcels_tokyo_core AS p
      ON p.cluster_no = z.fid
    GROUP BY z.fid, z.zone_code, z.name, z.zone_type
)
INSERT INTO gis_data.layer_demo_business_zones_tokyo_core (
    fid,
    geom,
    zone_code,
    name,
    zone_type,
    source_dataset,
    note
)
SELECT
    fid,
    geom,
    zone_code,
    name,
    zone_type,
    '都心業務区域v1（デモ生成）' AS source_dataset,
    '土地・建物を複数件含む筆群から生成した不整形MultiPolygon区域' AS note
FROM zone_geoms
WHERE NOT ST_IsEmpty(geom);

CREATE INDEX layer_demo_business_zones_tokyo_core_geom_gix
    ON gis_data.layer_demo_business_zones_tokyo_core USING gist (geom);
ANALYZE gis_data.layer_demo_business_zones_tokyo_core;

WITH stats AS (
    SELECT
        count(*)::bigint AS row_count,
        jsonb_build_array(
            ST_XMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_XMax(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMax(ST_Extent(ST_Transform(geom, 4326)))
        ) AS bbox_4326
    FROM gis_data.layer_demo_moj_parcels_tokyo_core
)
INSERT INTO app.layers (
    id,
    project_id,
    name,
    schema_name,
    table_name,
    geometry_column,
    geometry_type,
    source_srid,
    display_srid,
    feature_id_column,
    bbox_4326,
    row_count,
    is_result,
    layer_role,
    tile_source_id
)
SELECT
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '登記所備付地図 土地筆（都心サンプル）',
    'gis_data',
    'layer_demo_moj_parcels_tokyo_core',
    'geom',
    'MULTIPOLYGON',
    4326,
    3857,
    'fid',
    bbox_4326,
    row_count,
    false,
    'generic',
    'layer_demo_moj_parcels_tokyo_core'
FROM stats
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    bbox_4326 = EXCLUDED.bbox_4326,
    row_count = EXCLUDED.row_count,
    layer_role = EXCLUDED.layer_role,
    tile_source_id = EXCLUDED.tile_source_id;

WITH stats AS (
    SELECT
        count(*)::bigint AS row_count,
        jsonb_build_array(
            ST_XMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_XMax(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMax(ST_Extent(ST_Transform(geom, 4326)))
        ) AS bbox_4326
    FROM gis_data.layer_demo_plateau_buildings_tokyo_core
)
INSERT INTO app.layers (
    id,
    project_id,
    name,
    schema_name,
    table_name,
    geometry_column,
    geometry_type,
    source_srid,
    display_srid,
    feature_id_column,
    bbox_4326,
    row_count,
    is_result,
    layer_role,
    tile_source_id
)
SELECT
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1002'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'PLATEAU 建物（都心サンプル）',
    'gis_data',
    'layer_demo_plateau_buildings_tokyo_core',
    'geom',
    'MULTIPOLYGON',
    4326,
    3857,
    'fid',
    bbox_4326,
    row_count,
    false,
    'generic',
    'layer_demo_plateau_buildings_tokyo_core'
FROM stats
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    bbox_4326 = EXCLUDED.bbox_4326,
    row_count = EXCLUDED.row_count,
    layer_role = EXCLUDED.layer_role,
    tile_source_id = EXCLUDED.tile_source_id;

WITH stats AS (
    SELECT
        count(*)::bigint AS row_count,
        jsonb_build_array(
            ST_XMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMin(ST_Extent(ST_Transform(geom, 4326))),
            ST_XMax(ST_Extent(ST_Transform(geom, 4326))),
            ST_YMax(ST_Extent(ST_Transform(geom, 4326)))
        ) AS bbox_4326
    FROM gis_data.layer_demo_business_zones_tokyo_core
)
INSERT INTO app.layers (
    id,
    project_id,
    name,
    schema_name,
    table_name,
    geometry_column,
    geometry_type,
    source_srid,
    display_srid,
    feature_id_column,
    bbox_4326,
    row_count,
    is_result,
    layer_role,
    tile_source_id
)
SELECT
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1003'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '都心業務区域v1',
    'gis_data',
    'layer_demo_business_zones_tokyo_core',
    'geom',
    'MULTIPOLYGON',
    4326,
    3857,
    'fid',
    bbox_4326,
    row_count,
    false,
    'zone',
    'layer_demo_business_zones_tokyo_core'
FROM stats
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    bbox_4326 = EXCLUDED.bbox_4326,
    row_count = EXCLUDED.row_count,
    layer_role = EXCLUDED.layer_role,
    tile_source_id = EXCLUDED.tile_source_id;

INSERT INTO app.layer_attributes (
    layer_id,
    name,
    data_type,
    ordinal_position,
    is_geometry
)
SELECT
    layer_meta.layer_id,
    cols.column_name,
    CASE WHEN cols.udt_name = 'geometry' THEN 'geometry' ELSE cols.data_type END,
    cols.ordinal_position,
    cols.udt_name = 'geometry'
FROM (
    VALUES
        ('d0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid, 'layer_demo_moj_parcels_tokyo_core'),
        ('d0f5f841-0a8d-4ff5-a2c4-94cf5c5d1002'::uuid, 'layer_demo_plateau_buildings_tokyo_core'),
        ('d0f5f841-0a8d-4ff5-a2c4-94cf5c5d1003'::uuid, 'layer_demo_business_zones_tokyo_core')
) AS layer_meta(layer_id, table_name)
JOIN information_schema.columns AS cols
  ON cols.table_schema = 'gis_data'
 AND cols.table_name = layer_meta.table_name
ON CONFLICT (layer_id, name) DO UPDATE SET
    data_type = EXCLUDED.data_type,
    ordinal_position = EXCLUDED.ordinal_position,
    is_geometry = EXCLUDED.is_geometry;

INSERT INTO app.lands (
    id,
    project_id,
    lot_number,
    address,
    land_use,
    area_sqm,
    registered_owner,
    right_type,
    registration_cause,
    registration_accepted_on,
    status,
    memo,
    source_layer_id,
    source_feature_id
)
SELECT
    'L-DENSE-' || lpad(fid::text, 3, '0') AS id,
    '00000000-0000-0000-0000-000000000000'::uuid AS project_id,
    lot_number,
    format('東京都%s%s %s', municipality_name, district_name, lot_number) AS address,
    CASE
        WHEN land_category = '商業地' THEN '商業地'
        WHEN land_category = '業務地' THEN '業務地'
        ELSE '宅地'
    END AS land_use,
    round(ST_Area(geom)::numeric, 1)::double precision AS area_sqm,
    CASE (fid % 4)
        WHEN 0 THEN '丸の内都市開発株式会社'
        WHEN 1 THEN '銀座アセットマネジメント合同会社'
        WHEN 2 THEN '東京都心不動産信託'
        ELSE '首都圏プロパティホールディングス'
    END AS registered_owner,
    CASE WHEN fid % 6 = 0 THEN '借地権' ELSE '所有権' END AS right_type,
    CASE (fid % 3)
        WHEN 0 THEN '売買'
        WHEN 1 THEN '合併'
        ELSE '設定'
    END AS registration_cause,
    ('2024-01-15'::date + (fid % 240))::date AS registration_accepted_on,
    CASE (fid % 5)
        WHEN 0 THEN '交渉中'
        WHEN 1 THEN '調査中'
        WHEN 2 THEN '現況確認中'
        WHEN 3 THEN '保留'
        ELSE '稼働中'
    END AS status,
    '都心デモ区域の含有確認用に自動生成した土地業務レコード' AS memo,
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid AS source_layer_id,
    fid::text AS source_feature_id
FROM gis_data.layer_demo_moj_parcels_tokyo_core
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    lot_number = EXCLUDED.lot_number,
    address = EXCLUDED.address,
    land_use = EXCLUDED.land_use,
    area_sqm = EXCLUDED.area_sqm,
    registered_owner = EXCLUDED.registered_owner,
    right_type = EXCLUDED.right_type,
    registration_cause = EXCLUDED.registration_cause,
    registration_accepted_on = EXCLUDED.registration_accepted_on,
    status = EXCLUDED.status,
    memo = EXCLUDED.memo,
    source_layer_id = EXCLUDED.source_layer_id,
    source_feature_id = EXCLUDED.source_feature_id,
    updated_at = now();

INSERT INTO app.buildings (
    id,
    project_id,
    land_id,
    name,
    building_location,
    house_number,
    building_use,
    floors,
    total_floor_area_sqm,
    structure,
    registered_owner,
    right_type,
    registration_accepted_on,
    status,
    memo,
    source_layer_id,
    source_feature_id
)
SELECT
    'B-DENSE-' || lpad(b.fid::text, 3, '0') AS id,
    '00000000-0000-0000-0000-000000000000'::uuid AS project_id,
    l.id AS land_id,
    b.building_name AS name,
    format('東京都%s%s', b.municipality_name, b.district_name) AS building_location,
    p.lot_number AS house_number,
    b.usage AS building_use,
    greatest(3, round(b.measured_height_m / 4.2)::integer) AS floors,
    round((ST_Area(b.geom) * greatest(3, round(b.measured_height_m / 4.2)::integer) * 0.82)::numeric, 1)::double precision AS total_floor_area_sqm,
    CASE (b.fid % 4)
        WHEN 0 THEN 'S造'
        WHEN 1 THEN 'SRC造'
        WHEN 2 THEN 'RC造'
        ELSE 'S・RC造'
    END AS structure,
    l.registered_owner,
    CASE WHEN b.fid % 7 = 0 THEN '区分所有権' ELSE '所有権' END AS right_type,
    ('2024-03-01'::date + (b.fid % 210))::date AS registration_accepted_on,
    CASE (b.fid % 5)
        WHEN 0 THEN '稼働中'
        WHEN 1 THEN '現況確認中'
        WHEN 2 THEN '調査中'
        WHEN 3 THEN '交渉中'
        ELSE '保留'
    END AS status,
    '建物形状はPLATEAU建築物モデル相当、業務属性はデモ用に生成' AS memo,
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1002'::uuid AS source_layer_id,
    b.fid::text AS source_feature_id
FROM gis_data.layer_demo_plateau_buildings_tokyo_core AS b
JOIN gis_data.layer_demo_moj_parcels_tokyo_core AS p
  ON ST_Contains(p.geom, ST_PointOnSurface(b.geom))
JOIN app.lands AS l
  ON l.source_layer_id = 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid
 AND l.source_feature_id = p.fid::text
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    land_id = EXCLUDED.land_id,
    name = EXCLUDED.name,
    building_location = EXCLUDED.building_location,
    house_number = EXCLUDED.house_number,
    building_use = EXCLUDED.building_use,
    floors = EXCLUDED.floors,
    total_floor_area_sqm = EXCLUDED.total_floor_area_sqm,
    structure = EXCLUDED.structure,
    registered_owner = EXCLUDED.registered_owner,
    right_type = EXCLUDED.right_type,
    registration_accepted_on = EXCLUDED.registration_accepted_on,
    status = EXCLUDED.status,
    memo = EXCLUDED.memo,
    source_layer_id = EXCLUDED.source_layer_id,
    source_feature_id = EXCLUDED.source_feature_id,
    updated_at = now();

INSERT INTO app.zones (
    id,
    project_id,
    name,
    zone_type,
    status,
    memo,
    zone_layer_id,
    zone_feature_id,
    source_layer_id,
    source_feature_id
)
SELECT
    'Z-DENSE-' || lpad(fid::text, 3, '0') AS id,
    '00000000-0000-0000-0000-000000000000'::uuid AS project_id,
    name,
    zone_type,
    '有効' AS status,
    '土地・建物を複数件含む都心業務区域デモ' AS memo,
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1003'::uuid AS zone_layer_id,
    fid::text AS zone_feature_id,
    'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1003'::uuid AS source_layer_id,
    fid::text AS source_feature_id
FROM gis_data.layer_demo_business_zones_tokyo_core
ON CONFLICT (zone_layer_id, zone_feature_id) DO UPDATE SET
    id = EXCLUDED.id,
    name = EXCLUDED.name,
    zone_type = EXCLUDED.zone_type,
    status = EXCLUDED.status,
    memo = EXCLUDED.memo,
    source_layer_id = EXCLUDED.source_layer_id,
    source_feature_id = EXCLUDED.source_feature_id,
    updated_at = now();

INSERT INTO app.parties (
    id,
    project_id,
    name,
    party_type,
    contact,
    address,
    memo,
    tags
)
VALUES
    (
        'P-DENSE-001',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '丸の内都市開発株式会社',
        '法人',
        'marunouchi-owner@example.com',
        '東京都千代田区丸の内一丁目',
        '都心DENSEデモの丸の内系地権者',
        ARRAY['地権者', '重点交渉']
    ),
    (
        'P-DENSE-002',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '銀座アセットマネジメント合同会社',
        '法人',
        'ginza-asset@example.com',
        '東京都中央区銀座四丁目',
        '都心DENSEデモの銀座系地権者',
        ARRAY['地権者', '競合']
    ),
    (
        'P-DENSE-003',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '東京都心不動産信託',
        '金融機関',
        'trust@example.com',
        '東京都千代田区大手町',
        '信託受益権を含む権利関係の確認先',
        ARRAY['信託', '要確認']
    ),
    (
        'P-DENSE-004',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '首都圏プロパティホールディングス',
        '法人',
        'property-hd@example.com',
        '東京都港区虎ノ門',
        '都心DENSEデモの広域地権者',
        ARRAY['地権者']
    ),
    (
        'P-DENSE-005',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '都心ビル管理株式会社',
        '管理会社',
        'pm-east@example.com',
        '東京都中央区日本橋',
        '偶数建物を中心に管理するPM会社',
        ARRAY['管理会社']
    ),
    (
        'P-DENSE-006',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '東京コアPM株式会社',
        '管理会社',
        'pm-core@example.com',
        '東京都港区新橋',
        '奇数建物を中心に管理するPM会社',
        ARRAY['管理会社', '要確認']
    ),
    (
        'P-DENSE-007',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '国際投資パートナーズ',
        '金融機関',
        'global-invest@example.com',
        'Singapore',
        '借地権・区分所有権を横断して確認する投資家',
        ARRAY['外国人', '投資家']
    ),
    (
        'P-DENSE-008',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '丸の内再開発準備組合',
        '法人',
        'marunouchi-redev@example.com',
        '東京都千代田区丸の内一丁目',
        '丸の内周辺区域の取得・再開発調整先',
        ARRAY['再開発', '重点交渉']
    ),
    (
        'P-DENSE-009',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '銀座商業テナント会',
        '法人',
        'ginza-tenant@example.com',
        '東京都中央区銀座四丁目',
        '銀座商業区域の既存テナント調整先',
        ARRAY['テナント', '要調整']
    ),
    (
        'P-DENSE-010',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '新橋まちづくり協議会',
        '法人',
        'shimbashi-area@example.com',
        '東京都港区新橋二丁目',
        '新橋周辺区域の地元協議先',
        ARRAY['再開発', '地元調整']
    ),
    (
        'P-DENSE-011',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '虎ノ門業務街区LLP',
        '法人',
        'toranomon-llp@example.com',
        '東京都港区虎ノ門一丁目',
        '虎ノ門周辺区域の複合用途開発主体',
        ARRAY['再開発', '競合']
    )
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    name = EXCLUDED.name,
    party_type = EXCLUDED.party_type,
    contact = EXCLUDED.contact,
    address = EXCLUDED.address,
    memo = EXCLUDED.memo,
    tags = EXCLUDED.tags,
    updated_at = now();

WITH relationship_rows AS (
    SELECT
        CASE l.registered_owner
            WHEN '丸の内都市開発株式会社' THEN 'P-DENSE-001'
            WHEN '銀座アセットマネジメント合同会社' THEN 'P-DENSE-002'
            WHEN '東京都心不動産信託' THEN 'P-DENSE-003'
            ELSE 'P-DENSE-004'
        END AS party_id,
        'land' AS target_type,
        l.id AS target_id,
        '所有者' AS relation_type,
        '土地登記名義人としてseed生成' AS note
    FROM app.lands AS l
    WHERE l.id LIKE 'L-DENSE-%'

    UNION ALL

    SELECT
        CASE b.registered_owner
            WHEN '丸の内都市開発株式会社' THEN 'P-DENSE-001'
            WHEN '銀座アセットマネジメント合同会社' THEN 'P-DENSE-002'
            WHEN '東京都心不動産信託' THEN 'P-DENSE-003'
            ELSE 'P-DENSE-004'
        END AS party_id,
        'building' AS target_type,
        b.id AS target_id,
        '登記名義人' AS relation_type,
        '建物登記名義人としてseed生成' AS note
    FROM app.buildings AS b
    WHERE b.id LIKE 'B-DENSE-%'

    UNION ALL

    SELECT
        CASE WHEN (b.source_feature_id)::integer % 2 = 0 THEN 'P-DENSE-005' ELSE 'P-DENSE-006' END AS party_id,
        'building' AS target_type,
        b.id AS target_id,
        '管理者' AS relation_type,
        '建物管理会社としてseed生成' AS note
    FROM app.buildings AS b
    WHERE b.id LIKE 'B-DENSE-%'

    UNION ALL

    SELECT
        'P-DENSE-007' AS party_id,
        'land' AS target_type,
        l.id AS target_id,
        '借地権者' AS relation_type,
        '借地権ありの土地に投資家関係者をseed生成' AS note
    FROM app.lands AS l
    WHERE l.id LIKE 'L-DENSE-%'
      AND l.right_type = '借地権'

    UNION ALL

    SELECT
        'P-DENSE-007' AS party_id,
        'building' AS target_type,
        b.id AS target_id,
        '抵当権者' AS relation_type,
        '区分所有権建物の金融関係者としてseed生成' AS note
    FROM app.buildings AS b
    WHERE b.id LIKE 'B-DENSE-%'
      AND b.right_type = '区分所有権'

    UNION ALL

    SELECT
        CASE p.cluster_no
            WHEN 1 THEN 'P-DENSE-008'
            WHEN 2 THEN 'P-DENSE-009'
            WHEN 3 THEN 'P-DENSE-010'
            ELSE 'P-DENSE-011'
        END AS party_id,
        'land' AS target_type,
        l.id AS target_id,
        '売買事業者' AS relation_type,
        '地区別の取得・調整候補としてseed生成' AS note
    FROM app.lands AS l
    JOIN gis_data.layer_demo_moj_parcels_tokyo_core AS p
      ON l.source_layer_id = 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1001'::uuid
     AND l.source_feature_id = p.fid::text
    WHERE l.id LIKE 'L-DENSE-%'
      AND (((p.fid - 1) % 9) + 1) IN (2, 5, 8)

    UNION ALL

    SELECT
        CASE p.cluster_no
            WHEN 1 THEN 'P-DENSE-008'
            WHEN 2 THEN 'P-DENSE-009'
            WHEN 3 THEN 'P-DENSE-010'
            ELSE 'P-DENSE-011'
        END AS party_id,
        'building' AS target_type,
        b.id AS target_id,
        CASE WHEN p.cluster_no = 2 THEN '賃借人' ELSE '連絡先' END AS relation_type,
        '区域別の建物関係者としてseed生成' AS note
    FROM app.buildings AS b
    JOIN gis_data.layer_demo_plateau_buildings_tokyo_core AS pb
      ON b.source_layer_id = 'd0f5f841-0a8d-4ff5-a2c4-94cf5c5d1002'::uuid
     AND b.source_feature_id = pb.fid::text
    JOIN gis_data.layer_demo_moj_parcels_tokyo_core AS p
      ON ST_Contains(p.geom, ST_PointOnSurface(pb.geom))
    WHERE b.id LIKE 'B-DENSE-%'
      AND (((p.fid - 1) % 9) + 1) IN (3, 6, 9)
),
stable_relationship_rows AS (
    SELECT
        (
            substr(md5('dense-party-relationship:' || party_id || ':' || target_type || ':' || target_id || ':' || relation_type), 1, 8) || '-' ||
            substr(md5('dense-party-relationship:' || party_id || ':' || target_type || ':' || target_id || ':' || relation_type), 9, 4) || '-' ||
            substr(md5('dense-party-relationship:' || party_id || ':' || target_type || ':' || target_id || ':' || relation_type), 13, 4) || '-' ||
            substr(md5('dense-party-relationship:' || party_id || ':' || target_type || ':' || target_id || ':' || relation_type), 17, 4) || '-' ||
            substr(md5('dense-party-relationship:' || party_id || ':' || target_type || ':' || target_id || ':' || relation_type), 21, 12)
        )::uuid AS id,
        party_id,
        target_type,
        target_id,
        relation_type,
        note
    FROM relationship_rows
)
INSERT INTO app.party_relationships (
    id,
    project_id,
    party_id,
    target_type,
    target_id,
    relation_type,
    note
)
SELECT
    id,
    '00000000-0000-0000-0000-000000000000'::uuid AS project_id,
    party_id,
    target_type,
    target_id,
    relation_type,
    note
FROM stable_relationship_rows
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    party_id = EXCLUDED.party_id,
    target_type = EXCLUDED.target_type,
    target_id = EXCLUDED.target_id,
    relation_type = EXCLUDED.relation_type,
    note = EXCLUDED.note;
