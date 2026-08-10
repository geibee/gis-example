package postgres

import (
	"context"
	"fmt"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/observability"
)

func (d *Database) IsOriginAllowed(ctx context.Context, origin string) (bool, error) {
	var allowed bool
	if err := d.QueryRow(
		ctx,
		`SELECT EXISTS (
    SELECT 1 FROM feedback.application_environments WHERE $1 = ANY(allowed_origins)
)`,
		origin,
	).Scan(&allowed); err != nil {
		return false, fmt.Errorf("CORS origin allowlistを取得できません: %w", err)
	}
	return allowed, nil
}

func (d *Database) NotificationHealth(ctx context.Context) (observability.NotificationHealth, error) {
	var health observability.NotificationHealth
	err := d.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status = 'failed'),
       coalesce(
           extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('pending', 'processing'))),
           0
       )
FROM feedback.notification_outbox`).Scan(&health.FailedDeliveries, &health.OutboxLagSeconds)
	if err != nil {
		return observability.NotificationHealth{}, fmt.Errorf("notification状態を取得できません: %w", err)
	}
	if health.FailedDeliveries > 0 {
		health.Status = "degraded"
	} else {
		health.Status = "available"
	}
	return health, nil
}

func (d *Database) CollectOperationalMetrics(ctx context.Context) ([]observability.OperationalMetric, error) {
	result := make([]observability.OperationalMetric, 0)
	counterRows, err := d.Query(ctx, `SELECT tenant.tenant_key, metric.metric_name, metric.value
FROM feedback.operational_metric_counters metric
JOIN feedback.tenants tenant ON tenant.id = metric.tenant_id
ORDER BY tenant.tenant_key, metric.metric_name`)
	if err != nil {
		return nil, fmt.Errorf("operational counterを取得できません: %w", err)
	}
	for counterRows.Next() {
		var tenantKey, name string
		var rawValue int64
		if err := counterRows.Scan(&tenantKey, &name, &rawValue); err != nil {
			counterRows.Close()
			return nil, fmt.Errorf("operational counterを読み取れません: %w", err)
		}
		result = append(result, observability.OperationalMetric{
			Name: "feedback_" + name, Type: observability.OperationalCounter,
			Value: float64(rawValue), Labels: map[string]string{"tenant": tenantKey},
		})
	}
	if err := counterRows.Err(); err != nil {
		counterRows.Close()
		return nil, fmt.Errorf("operational counterの走査に失敗しました: %w", err)
	}
	counterRows.Close()

	gaugeRows, err := d.Query(ctx, tenantOperationalMetricsSQL)
	if err != nil {
		return nil, fmt.Errorf("tenant metricを取得できません: %w", err)
	}
	defer gaugeRows.Close()
	for gaugeRows.Next() {
		var tenantKey string
		var evidenceBytes, threadCount, exportCount, deliveryFailures, purgeBacklog int64
		var outboxLag float64
		if err := gaugeRows.Scan(
			&tenantKey, &evidenceBytes, &threadCount, &exportCount, &deliveryFailures, &outboxLag, &purgeBacklog,
		); err != nil {
			return nil, fmt.Errorf("tenant metricを読み取れません: %w", err)
		}
		names := [...]string{
			"feedback_tenant_evidence_bytes",
			"feedback_tenant_thread_count",
			"feedback_tenant_export_count",
			"feedback_delivery_failure_count",
			"feedback_outbox_lag_seconds",
			"feedback_purge_backlog",
		}
		values := [...]float64{
			float64(evidenceBytes), float64(threadCount), float64(exportCount),
			float64(deliveryFailures), outboxLag, float64(purgeBacklog),
		}
		for index, name := range names {
			result = append(result, observability.OperationalMetric{
				Name: name, Type: observability.OperationalGauge,
				Value: values[index], Labels: map[string]string{"tenant": tenantKey},
			})
		}
	}
	if err := gaugeRows.Err(); err != nil {
		return nil, fmt.Errorf("tenant metricの走査に失敗しました: %w", err)
	}
	return result, nil
}

const tenantOperationalMetricsSQL = `SELECT tenant.tenant_key,
       (SELECT coalesce(sum(evidence.byte_size), 0)
        FROM feedback.review_evidence evidence
        JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id
        WHERE thread.tenant_id = tenant.id) AS evidence_bytes,
       (SELECT count(*) FROM feedback.feedback_threads thread WHERE thread.tenant_id = tenant.id) AS thread_count,
       (SELECT count(*) FROM feedback.export_jobs export WHERE export.tenant_id = tenant.id) AS export_count,
       (SELECT count(*) FROM feedback.notification_outbox outbox
        WHERE outbox.tenant_id = tenant.id AND outbox.status = 'failed') AS delivery_failures,
       (SELECT coalesce(extract(epoch FROM now() - min(outbox.created_at)), 0)
        FROM feedback.notification_outbox outbox
        WHERE outbox.tenant_id = tenant.id AND outbox.status IN ('pending', 'processing')) AS outbox_lag,
       (SELECT count(*)
        FROM feedback.review_evidence evidence
        JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id
        JOIN feedback.review_sessions session ON session.id = thread.session_id
        LEFT JOIN feedback.retention_policies policy ON policy.workspace_id = thread.workspace_id
        WHERE thread.tenant_id = tenant.id
          AND coalesce(
              evidence.expires_at,
              evidence.created_at + (coalesce(session.evidence_retention_days, policy.evidence_retention_days) * interval '1 day')
          ) <= now()) AS purge_backlog
FROM feedback.tenants tenant
ORDER BY tenant.tenant_key`
