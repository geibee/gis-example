# Upgrade

Feedback API v1とSDK majorを揃え、SDK起動時のcapabilities negotiationを維持する。Flyway migrationは適用後に
編集・削除せず、新しいversionでforward fixする。破壊的DDLはexpand、両対応/backfill、contractの複数releaseへ分ける。

更新前にDBとEvidence/Export bucketをbackupし、stagingでAPI、worker、Admin、直接OIDC、token exchange経路を検証する。
