package feedback.service

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.serialization.json.Json
import org.flywaydb.core.Flyway
import java.sql.Connection

internal val serviceJson = Json {
    ignoreUnknownKeys = false
    encodeDefaults = true
    explicitNulls = true
}

class FeedbackDatabase(val dataSource: HikariDataSource) : AutoCloseable {
    companion object {
        fun create(settings: DatabaseSettings): FeedbackDatabase {
            val config = HikariConfig().apply {
                jdbcUrl = settings.url
                username = settings.user
                password = settings.password
                maximumPoolSize = settings.poolSize
                poolName = "feedback-service"
                connectionTimeout = settings.connectionTimeoutMillis
                connectionInitSql = "SET statement_timeout = ${settings.statementTimeoutMillis}"
            }
            return FeedbackDatabase(HikariDataSource(config))
        }
    }

    fun migrate() {
        Flyway.configure()
            .dataSource(dataSource.jdbcUrl, dataSource.username, dataSource.password)
            .locations("classpath:db/migration")
            .defaultSchema("feedback")
            .schemas("feedback")
            .createSchemas(true)
            .table("flyway_schema_history")
            .load()
            .migrate()
    }

    fun ping() {
        dataSource.connection.use { connection ->
            connection.prepareStatement("SELECT 1").use { statement ->
                statement.executeQuery().use { result -> check(result.next()) }
            }
        }
    }

    fun <T> transaction(block: (Connection) -> T): T = dataSource.connection.use { connection ->
        val previous = connection.autoCommit
        connection.autoCommit = false
        try {
            val result = block(connection)
            connection.commit()
            result
        } catch (exception: Exception) {
            connection.rollback()
            throw exception
        } finally {
            if (!connection.isClosed) connection.autoCommit = previous
        }
    }

    override fun close() = dataSource.close()
}
