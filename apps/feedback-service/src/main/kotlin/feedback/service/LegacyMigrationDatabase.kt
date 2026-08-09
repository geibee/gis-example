package feedback.service

import org.flywaydb.core.Flyway

/** 旧Web GISコピーCLIだけが所有するschemaとFlyway履歴。 */
object LegacyMigrationDatabase {
    const val targetFeedbackSchemaVersion = "4"

    fun prepare(database: FeedbackDatabase) {
        requireFeedbackSchemaVersion(database)
        Flyway.configure()
            .dataSource(database.dataSource.jdbcUrl, database.dataSource.username, database.dataSource.password)
            .locations("classpath:db/feedback-migration")
            .defaultSchema("feedback_migration")
            .schemas("feedback_migration")
            .createSchemas(true)
            .table("flyway_schema_history")
            .load()
            .migrate()
    }

    private fun requireFeedbackSchemaVersion(database: FeedbackDatabase) {
        val actual = database.dataSource.connection.use { connection ->
            connection.prepareStatement(
                """
                SELECT version
                FROM feedback.flyway_schema_history
                WHERE success AND version IS NOT NULL
                ORDER BY installed_rank DESC
                LIMIT 1
                """.trimIndent()
            ).use { statement ->
                statement.executeQuery().use { result -> if (result.next()) result.getString(1) else null }
            }
        }
        require(actual == targetFeedbackSchemaVersion) {
            "feedback-legacy-migration の対象Feedback schema versionは " +
                "$targetFeedbackSchemaVersion です (検出: ${actual ?: "未適用"})"
        }
    }
}
