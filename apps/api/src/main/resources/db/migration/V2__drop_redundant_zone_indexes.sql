-- V2: app.zones の UNIQUE 制約 (zone_layer_id, zone_feature_id) と重複していた
-- インデックスを削除する。
--
-- 旧構成では init.sql が UNIQUE 制約を、SchemaSetup.kt が同じ列への
-- zones_zone_feature_unique_idx / zones_zone_feature_idx を別々に作っていた
-- (二重管理によるドリフトの実例)。UNIQUE 制約の裏インデックスだけを残す。
--
-- IF EXISTS を付けるのは、Flyway 導入前の既存 DB (baseline 済み) と
-- V1 から作った DB のどちらにも適用され、同一スキーマへ収束させるため。
DROP INDEX IF EXISTS app.zones_zone_feature_unique_idx;
DROP INDEX IF EXISTS app.zones_zone_feature_idx;
