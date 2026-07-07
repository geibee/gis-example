-- 開発用 Keycloak realm (infra/keycloak/realm-gis.json) の固定ユーザー ID に対応する
-- ユーザーとメンバーシップ。compose 起動直後からロール別の動作確認ができるようにする。
-- 本番環境ではこのシードを投入しないこと (ユーザーは JIT 登録、メンバーは管理 API で付与する)

INSERT INTO app.users (id, subject, email, display_name, system_role)
VALUES
    ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'admin@gis.example', 'Admin GIS', 'admin'),
    ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'editor@gis.example', 'Editor GIS', 'user'),
    ('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'viewer@gis.example', 'Viewer GIS', 'user')
ON CONFLICT (subject) DO NOTHING;

INSERT INTO app.project_members (user_id, project_id, role)
VALUES
    ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'editor'),
    ('a0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'viewer')
ON CONFLICT (user_id, project_id) DO NOTHING;
