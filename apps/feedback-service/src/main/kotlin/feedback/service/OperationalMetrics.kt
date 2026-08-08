package feedback.service

import java.util.concurrent.atomic.AtomicLong

class FeedbackServiceMetrics(private val database: FeedbackDatabase) {
    private val requestCount = AtomicLong()
    private val errorCount = AtomicLong()
    private val latencyNanos = AtomicLong()

    fun recordRequest(elapsedNanos: Long, status: Int) {
        requestCount.incrementAndGet()
        latencyNanos.addAndGet(elapsedNanos.coerceAtLeast(0))
        if (status >= 400) errorCount.incrementAndGet()
    }

    fun render(): String = buildString {
        metric("feedback_api_requests_total", requestCount.get())
        metric("feedback_api_errors_total", errorCount.get())
        metric("feedback_api_latency_seconds_count", requestCount.get())
        metric("feedback_api_latency_seconds_sum", latencyNanos.get().toDouble() / 1_000_000_000.0)
        append(database.renderOperationalMetrics())
    }

    private fun StringBuilder.metric(name: String, value: Number) {
        append(name).append(' ').append(value).append('\n')
    }
}

fun FeedbackDatabase.renderOperationalMetrics(): String = dataSource.connection.use { connection ->
    val output = StringBuilder()
    connection.prepareStatement(
        """
        SELECT t.tenant_key, m.metric_name, m.value
        FROM feedback.operational_metric_counters m
        JOIN feedback.tenants t ON t.id = m.tenant_id
        ORDER BY t.tenant_key, m.metric_name
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            while (result.next()) {
                output.append("feedback_").append(result.getString(2))
                    .append("{tenant=\"").append(prometheusEscape(result.getString(1))).append("\"} ")
                    .append(result.getLong(3)).append('\n')
            }
        }
    }
    connection.prepareStatement(
        """
        SELECT t.tenant_key,
               (SELECT coalesce(sum(e.byte_size), 0)
                FROM feedback.review_evidence e
                JOIN feedback.feedback_threads thread ON thread.id = e.thread_id
                WHERE thread.tenant_id = t.id) AS evidence_bytes,
               (SELECT count(*) FROM feedback.feedback_threads thread WHERE thread.tenant_id = t.id) AS thread_count,
               (SELECT count(*) FROM feedback.export_jobs export WHERE export.tenant_id = t.id) AS export_count,
               (SELECT count(*) FROM feedback.notification_outbox outbox
                WHERE outbox.tenant_id = t.id AND outbox.status = 'failed') AS delivery_failures,
               (SELECT coalesce(extract(epoch FROM now() - min(outbox.created_at)), 0)
                FROM feedback.notification_outbox outbox
                WHERE outbox.tenant_id = t.id AND outbox.status IN ('pending', 'processing')) AS outbox_lag,
               (SELECT count(*)
                FROM feedback.review_evidence e
                JOIN feedback.feedback_threads thread ON thread.id = e.thread_id
                JOIN feedback.review_sessions session ON session.id = thread.session_id
                LEFT JOIN feedback.retention_policies policy ON policy.workspace_id = thread.workspace_id
                WHERE thread.tenant_id = t.id
                  AND coalesce(
                      e.expires_at,
                      e.created_at + (coalesce(session.evidence_retention_days, policy.evidence_retention_days) * interval '1 day')
                  ) <= now()) AS purge_backlog
        FROM feedback.tenants t
        ORDER BY t.tenant_key
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            while (result.next()) {
                val label = "{tenant=\"${prometheusEscape(result.getString(1))}\"}"
                output.append("feedback_tenant_evidence_bytes").append(label).append(' ').append(result.getLong(2)).append('\n')
                output.append("feedback_tenant_thread_count").append(label).append(' ').append(result.getLong(3)).append('\n')
                output.append("feedback_tenant_export_count").append(label).append(' ').append(result.getLong(4)).append('\n')
                output.append("feedback_delivery_failure_count").append(label).append(' ').append(result.getLong(5)).append('\n')
                output.append("feedback_outbox_lag_seconds").append(label).append(' ').append(result.getDouble(6)).append('\n')
                output.append("feedback_purge_backlog").append(label).append(' ').append(result.getLong(7)).append('\n')
            }
        }
    }
    output.toString()
}

data class DependencyHealth(val notification: String, val failedDeliveries: Long, val outboxLagSeconds: Double)

fun FeedbackDatabase.dependencyHealth(): DependencyHealth = dataSource.connection.use { connection ->
    connection.prepareStatement(
        """
        SELECT count(*) FILTER (WHERE status = 'failed'),
               coalesce(
                   extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('pending', 'processing'))),
                   0
               )
        FROM feedback.notification_outbox
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { result ->
            result.next()
            val failed = result.getLong(1)
            DependencyHealth(if (failed > 0) "degraded" else "available", failed, result.getDouble(2))
        }
    }
}

private fun prometheusEscape(value: String): String = value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
