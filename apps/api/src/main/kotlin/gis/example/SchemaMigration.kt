// スキーママイグレーション: Flyway による versioned migration の適用。
// DDL の SSoT は src/main/resources/db/migration/V*.sql (運用ルールは docs/db-migrations.md)。
// アプリは起動時に migrate を呼ぶだけで、コードから DDL を直接発行しない (issue #12)

package gis.example

import org.flywaydb.core.Flyway

// Flyway 導入前にテーブルが作成済みの既存 DB は、初回 migrate 時に
// baselineOnMigrate によってこのバージョンを「適用済み」として記録し、
// それより新しいマイグレーションだけを適用する (V1 = 導入時点の到達スキーマ)
private const val BASELINE_VERSION = "1"

fun Database.migrateSchema() {
    // Hikari プールを使わず接続情報だけを渡す。プール経由だと connectionInitSql の
    // statement_timeout (既定 30 秒) が長時間のインデックス作成を殺し、逆に Flyway が
    // タイムアウトを緩めた接続がプールに戻って業務クエリへ漏れるため
    migrateSchema(
        url = dataSource.jdbcUrl,
        user = dataSource.username,
        password = dataSource.password
    )
}

// 統合テストからも同じ入口を使う (テストは init.sql 適用後にこの関数でスキーマを作る)
fun migrateSchema(url: String, user: String, password: String) {
    Flyway.configure()
        .dataSource(url, user, password)
        .locations("classpath:db/migration")
        // 履歴テーブル (flyway_schema_history) も app スキーマに置く。
        // 統合テストの DROP SCHEMA app CASCADE で履歴ごと作り直せる
        .defaultSchema("app")
        .baselineOnMigrate(true)
        .baselineVersion(BASELINE_VERSION)
        .load()
        .migrate()
}
