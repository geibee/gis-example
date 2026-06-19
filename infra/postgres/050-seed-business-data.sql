-- Business-domain sample data for the condition-search UI.
-- These records link lands/buildings/parties to seeded GIS features so
-- business filters and business-backed spatial predicates work after a fresh init.

SET client_encoding = 'UTF8';

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
VALUES
    (
        'L-0001',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '千代田区丸の内一丁目1',
        '東京都千代田区丸の内1丁目',
        '商業地',
        1840.5,
        '東京土地ホールディングス',
        '所有権',
        '売買',
        '2023-04-12'::date,
        '調査中',
        '駅前再開発候補地',
        'a6dbb70e-1999-578f-904d-8f5c68513085'::uuid,
        '1'
    ),
    (
        'L-0002',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '中央区銀座四丁目2',
        '東京都中央区銀座4丁目',
        '商業地',
        920.0,
        '銀座開発株式会社',
        '所有権',
        '合併',
        '2022-11-28'::date,
        '交渉中',
        '既存テナントあり',
        'a6dbb70e-1999-578f-904d-8f5c68513085'::uuid,
        '85'
    ),
    (
        'L-0003',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '港区新橋二丁目3',
        '東京都港区新橋2丁目',
        '業務地',
        1265.4,
        '新橋都市管理合同会社',
        '借地権',
        '設定',
        '2021-07-05'::date,
        '保留',
        NULL,
        '54240d3d-0b3d-4d66-9f6d-07af52c6df5a'::uuid,
        '12'
    )
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
VALUES
    (
        'B-0001',
        '00000000-0000-0000-0000-000000000000'::uuid,
        'L-0001',
        '丸の内サンプルビル',
        '東京都千代田区丸の内1丁目',
        '1-1',
        '事務所',
        9,
        8640.2,
        'S造',
        '東京土地ホールディングス',
        '所有権',
        '2023-05-10'::date,
        '現況確認中',
        '建替え余地あり',
        'a6dbb70e-1999-578f-904d-8f5c68513085'::uuid,
        '1'
    ),
    (
        'B-0002',
        '00000000-0000-0000-0000-000000000000'::uuid,
        'L-0002',
        '銀座サンプル店舗',
        '東京都中央区銀座4丁目',
        '4-2',
        '店舗',
        5,
        3120.0,
        'RC造',
        '銀座開発株式会社',
        '所有権',
        '2022-12-15'::date,
        '稼働中',
        NULL,
        'a6dbb70e-1999-578f-904d-8f5c68513085'::uuid,
        '85'
    )
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

INSERT INTO app.parties (
    id,
    project_id,
    name,
    party_type,
    contact,
    address,
    memo
)
VALUES
    (
        'P-0001',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '東京土地ホールディングス',
        '法人',
        'asset@example.com',
        '東京都千代田区丸の内',
        'L-0001所有者'
    ),
    (
        'P-0002',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '銀座開発株式会社',
        '法人',
        'dev@example.com',
        '東京都中央区銀座',
        '売買事業者'
    ),
    (
        'P-0003',
        '00000000-0000-0000-0000-000000000000'::uuid,
        '新橋管理事務所',
        '管理会社',
        '03-0000-0000',
        '東京都港区新橋',
        NULL
    )
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    name = EXCLUDED.name,
    party_type = EXCLUDED.party_type,
    contact = EXCLUDED.contact,
    address = EXCLUDED.address,
    memo = EXCLUDED.memo,
    updated_at = now();

INSERT INTO app.party_relationships (
    id,
    project_id,
    party_id,
    target_type,
    target_id,
    relation_type,
    note
)
VALUES
    (
        '11111111-1111-1111-1111-111111111111'::uuid,
        '00000000-0000-0000-0000-000000000000'::uuid,
        'P-0001',
        'land',
        'L-0001',
        '所有者',
        NULL
    ),
    (
        '22222222-2222-2222-2222-222222222222'::uuid,
        '00000000-0000-0000-0000-000000000000'::uuid,
        'P-0002',
        'land',
        'L-0002',
        '売買事業者',
        '取得交渉窓口'
    ),
    (
        '33333333-3333-3333-3333-333333333333'::uuid,
        '00000000-0000-0000-0000-000000000000'::uuid,
        'P-0003',
        'building',
        'B-0001',
        '管理者',
        NULL
    )
ON CONFLICT (id) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    party_id = EXCLUDED.party_id,
    target_type = EXCLUDED.target_type,
    target_id = EXCLUDED.target_id,
    relation_type = EXCLUDED.relation_type,
    note = EXCLUDED.note;
