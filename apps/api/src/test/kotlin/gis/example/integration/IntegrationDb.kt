// 統合テスト共通の DB 接続情報と Flyway マイグレーション適用。
// init.sql (拡張・スキーマ作成のみ) の適用後にテーブル定義を作るために使う
package gis.example.integration

import gis.example.migrateSchema

object IntegrationDb {
    val url: String = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/gis"
    val user: String = System.getenv("DATABASE_USER") ?: System.getenv("PGUSER") ?: "gis"
    val password: String = System.getenv("DATABASE_PASSWORD") ?: System.getenv("PGPASSWORD") ?: "gis"

    // アプリ起動時と同じ入口 (SchemaMigration.kt) で db/migration/V*.sql を適用する
    fun migrate() = migrateSchema(url, user, password)
}
