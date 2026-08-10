package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
)

func (d *Database) GetNotificationSettings(
	ctx context.Context,
	scope auth.ResourceScope,
) (notification.StoredSettings, error) {
	var result notification.StoredSettings
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureNotificationSettings(txCtx, tx, scope.WorkspaceID); err != nil {
			return err
		}
		return scanStoredNotificationSettings(tx.QueryRow(txCtx, `SELECT webhook_enabled,
       webhook_endpoint_ciphertext, webhook_endpoint_nonce, include_body, include_evidence, version
FROM feedback.notification_settings WHERE workspace_id = $1::uuid`, scope.WorkspaceID), &result)
	})
	if err != nil {
		return notification.StoredSettings{}, fmt.Errorf("notification settingsを取得できません: %w", err)
	}
	return result, nil
}

func (d *Database) PatchNotificationSettings(
	ctx context.Context,
	scope auth.ResourceScope,
	expectedVersion int,
	update notification.SettingsUpdate,
) (notification.StoredSettings, error) {
	var result notification.StoredSettings
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureNotificationSettings(txCtx, tx, scope.WorkspaceID); err != nil {
			return err
		}
		tag, err := tx.Exec(txCtx, `UPDATE feedback.notification_connectors SET
    enabled = $1, include_body = $2, version = version + 1, updated_at = now()
WHERE workspace_id = $3::uuid AND legacy_settings AND deleted_at IS NULL
  AND (NOT $1 OR destination_ref NOT LIKE 'legacy-disabled-%')`,
			update.WebhookEnabled, update.IncludeBody, scope.WorkspaceID)
		if err != nil {
			return fmt.Errorf("legacy webhook connectorを同期できません: %w", err)
		}
		if update.WebhookEnabled && tag.RowsAffected() != 1 {
			return &notification.Error{
				Kind: notification.ErrorConflict, Code: "notification.webhook_connector_required",
				Detail: "Webhook connectorを登録してlegacy destinationRefを構成してから有効化してください",
			}
		}
		var version int
		err = tx.QueryRow(txCtx, `UPDATE feedback.notification_settings SET
    webhook_enabled = $1, webhook_endpoint_ciphertext = $2, webhook_endpoint_nonce = $3,
    include_body = $4, include_evidence = $5, version = version + 1, updated_at = now()
WHERE workspace_id = $6::uuid AND version = $7 RETURNING version`,
			update.WebhookEnabled, nullableBytes(update.EndpointCiphertext), nullableBytes(update.EndpointNonce),
			update.IncludeBody, update.IncludeEvidence, scope.WorkspaceID, expectedVersion).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationVersionMismatch()
		}
		if err != nil {
			return fmt.Errorf("notification settingsを更新できません: %w", err)
		}
		result = notification.StoredSettings{
			WebhookEnabled: update.WebhookEnabled, EndpointCiphertext: append([]byte(nil), update.EndpointCiphertext...),
			EndpointNonce: append([]byte(nil), update.EndpointNonce...), IncludeBody: update.IncludeBody,
			IncludeEvidence: update.IncludeEvidence, Version: version,
		}
		return nil
	})
	return result, err
}

func ensureNotificationSettings(ctx context.Context, tx Tx, workspaceID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback.notification_settings (workspace_id)
VALUES ($1::uuid) ON CONFLICT (workspace_id) DO NOTHING`, workspaceID)
	if err != nil {
		return fmt.Errorf("notification settingsを初期化できません: %w", err)
	}
	return nil
}

func scanStoredNotificationSettings(row pgx.Row, result *notification.StoredSettings) error {
	return row.Scan(&result.WebhookEnabled, &result.EndpointCiphertext, &result.EndpointNonce,
		&result.IncludeBody, &result.IncludeEvidence, &result.Version)
}

func (d *Database) ListNotificationDeliveries(
	ctx context.Context,
	input notification.ListInput,
) ([]notification.Delivery, error) {
	connectorDeliveries, err := listConnectorDeliveries(ctx, d, input)
	if err != nil {
		return nil, err
	}
	if input.ConnectorID != nil {
		return connectorDeliveries, nil
	}
	legacy, err := listLegacyDeliveries(ctx, d, input)
	if err != nil {
		return nil, err
	}
	result := append(legacy, connectorDeliveries...)
	sort.SliceStable(result, func(left, right int) bool {
		leftAt, _ := time.Parse(time.RFC3339Nano, result[left].CreatedAt)
		rightAt, _ := time.Parse(time.RFC3339Nano, result[right].CreatedAt)
		return leftAt.After(rightAt)
	})
	if len(result) > input.Limit {
		result = result[:input.Limit]
	}
	return result, nil
}

func listConnectorDeliveries(
	ctx context.Context,
	querier interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	input notification.ListInput,
) ([]notification.Delivery, error) {
	query := `SELECT queue.id::text, connector.id::text, connector.name, outbox.event_type,
       queue.status, queue.retry_cycle, queue.attempt_count, queue.available_at,
       queue.delivered_at, queue.last_error, queue.created_at
FROM feedback.connector_delivery_queue queue
JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
WHERE connector.workspace_id = $1::uuid`
	arguments := []any{input.Scope.WorkspaceID}
	if input.Status != nil {
		arguments = append(arguments, *input.Status)
		query += fmt.Sprintf(" AND queue.status = $%d", len(arguments))
	}
	if input.ConnectorID != nil {
		arguments = append(arguments, *input.ConnectorID)
		query += fmt.Sprintf(" AND connector.id = $%d::uuid", len(arguments))
	}
	arguments = append(arguments, input.Limit)
	query += fmt.Sprintf(" ORDER BY queue.created_at DESC LIMIT $%d", len(arguments))
	rows, err := querier.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("connector delivery一覧を取得できません: %w", err)
	}
	result := make([]notification.Delivery, 0)
	for rows.Next() {
		item, err := scanConnectorDelivery(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("connector deliveryを読み取れません: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("connector delivery一覧の走査に失敗しました: %w", err)
	}
	rows.Close()
	// pool size 1でもdeadlockしないよう、一覧Rowsを閉じてから履歴を読む。
	for index := range result {
		result[index].Attempts, err = readConnectorAttempts(ctx, querier, result[index].ID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func listLegacyDeliveries(
	ctx context.Context,
	querier interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	input notification.ListInput,
) ([]notification.Delivery, error) {
	query := `SELECT outbox.id::text, outbox.event_type, outbox.status, outbox.retry_cycle,
       outbox.attempt_count, outbox.available_at, outbox.delivered_at, outbox.last_error, outbox.created_at
FROM feedback.notification_outbox outbox
WHERE outbox.workspace_id = $1::uuid
  AND NOT EXISTS (SELECT 1 FROM feedback.connector_delivery_queue queue WHERE queue.outbox_id = outbox.id)`
	arguments := []any{input.Scope.WorkspaceID}
	if input.Status != nil {
		arguments = append(arguments, *input.Status)
		query += fmt.Sprintf(" AND outbox.status = $%d", len(arguments))
	}
	arguments = append(arguments, input.Limit)
	query += fmt.Sprintf(" ORDER BY outbox.created_at DESC LIMIT $%d", len(arguments))
	rows, err := querier.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("legacy delivery一覧を取得できません: %w", err)
	}
	result := make([]notification.Delivery, 0)
	for rows.Next() {
		item, err := scanLegacyDelivery(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("legacy deliveryを読み取れません: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("legacy delivery一覧の走査に失敗しました: %w", err)
	}
	rows.Close()
	for index := range result {
		result[index].Attempts, err = readLegacyAttempts(ctx, querier, result[index].ID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (d *Database) RetryNotificationDelivery(
	ctx context.Context,
	scope auth.ResourceScope,
	id string,
) (notification.Delivery, error) {
	var result notification.Delivery
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		tag, err := tx.Exec(txCtx, `UPDATE feedback.connector_delivery_queue SET
    status = 'pending', retry_cycle = retry_cycle + 1, attempt_count = 0,
    available_at = now(), claimed_at = NULL, delivered_at = NULL, last_error = NULL
WHERE id = $1::uuid AND status = 'failed' AND connector_id IN (
    SELECT connector.id FROM feedback.notification_connectors connector
    JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
    WHERE connector.workspace_id = $2::uuid AND connector.deleted_at IS NULL
      AND connector.enabled AND installation.enabled
)`, id, scope.WorkspaceID)
		if err != nil {
			return fmt.Errorf("connector deliveryを再送状態へ更新できません: %w", err)
		}
		if tag.RowsAffected() == 1 {
			result, err = readConnectorDelivery(ctx, tx, scope.WorkspaceID, id)
			return err
		}

		tag, err = tx.Exec(txCtx, `UPDATE feedback.notification_outbox SET
    status = 'pending', retry_cycle = retry_cycle + 1, attempt_count = 0,
    available_at = now(), claimed_at = NULL, delivered_at = NULL, last_error = NULL
WHERE id = $1::uuid AND workspace_id = $2::uuid AND status = 'failed'`, id, scope.WorkspaceID)
		if err != nil {
			return fmt.Errorf("legacy deliveryを再送状態へ更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			var exists bool
			if err := tx.QueryRow(txCtx, `SELECT EXISTS (
    SELECT 1 FROM feedback.notification_outbox WHERE id = $1::uuid AND workspace_id = $2::uuid
)`, id, scope.WorkspaceID).Scan(&exists); err != nil {
				return fmt.Errorf("legacy deliveryの存在を確認できません: %w", err)
			}
			if !exists {
				return notificationNotFound()
			}
			return &notification.Error{Kind: notification.ErrorConflict, Code: "notification.not_failed", Detail: "failed deliveryだけを再送できます"}
		}
		var queueID string
		err = tx.QueryRow(txCtx, `INSERT INTO feedback.connector_delivery_queue (id, outbox_id, connector_id)
SELECT gen_random_uuid(), outbox.id, connector.id
FROM feedback.notification_outbox outbox
JOIN feedback.notification_connectors connector
  ON connector.workspace_id = outbox.workspace_id AND connector.enabled AND connector.deleted_at IS NULL
JOIN feedback.connector_installations installation
  ON installation.id = connector.installation_id AND installation.enabled
WHERE outbox.id = $1::uuid AND outbox.workspace_id = $2::uuid
  AND outbox.event_type = ANY(installation.supported_events)
ON CONFLICT (outbox_id, connector_id) DO UPDATE SET
    status = 'pending', retry_cycle = feedback.connector_delivery_queue.retry_cycle + 1,
    attempt_count = 0, available_at = now(), claimed_at = NULL,
    delivered_at = NULL, last_error = NULL
RETURNING id::text`, id, scope.WorkspaceID).Scan(&queueID)
		if errors.Is(err, pgx.ErrNoRows) {
			return &notification.Error{Kind: notification.ErrorConflict, Code: "notification.connector_unavailable", Detail: "有効な通知connectorがありません"}
		}
		if err != nil {
			return fmt.Errorf("connector delivery queueを再作成できません: %w", err)
		}
		result, err = readConnectorDelivery(txCtx, tx, scope.WorkspaceID, queueID)
		return err
	})
	return result, err
}

func readConnectorDelivery(ctx context.Context, tx Tx, workspaceID, id string) (notification.Delivery, error) {
	item, err := scanConnectorDelivery(tx.QueryRow(ctx, `SELECT queue.id::text, connector.id::text,
       connector.name, outbox.event_type, queue.status, queue.retry_cycle, queue.attempt_count,
       queue.available_at, queue.delivered_at, queue.last_error, queue.created_at
FROM feedback.connector_delivery_queue queue
JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
WHERE queue.id = $1::uuid AND connector.workspace_id = $2::uuid`, id, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return notification.Delivery{}, notificationNotFound()
	}
	if err != nil {
		return notification.Delivery{}, fmt.Errorf("connector deliveryを取得できません: %w", err)
	}
	item.Attempts, err = readConnectorAttempts(ctx, tx, item.ID)
	return item, err
}

func scanConnectorDelivery(row rowScanner) (notification.Delivery, error) {
	var item notification.Delivery
	var connectorID, connectorName string
	var availableAt, createdAt time.Time
	var deliveredAt *time.Time
	err := row.Scan(&item.ID, &connectorID, &connectorName, &item.EventType, &item.Status,
		&item.RetryCycle, &item.AttemptCount, &availableAt, &deliveredAt, &item.LastError, &createdAt)
	if err != nil {
		return notification.Delivery{}, err
	}
	item.ConnectorID, item.ConnectorName = &connectorID, &connectorName
	item.AvailableAt, item.DeliveredAt, item.CreatedAt = javaInstant(availableAt), instantPointer(deliveredAt), javaInstant(createdAt)
	item.Attempts = make([]notification.Attempt, 0)
	return item, nil
}

func scanLegacyDelivery(row rowScanner) (notification.Delivery, error) {
	var item notification.Delivery
	var availableAt, createdAt time.Time
	var deliveredAt *time.Time
	err := row.Scan(&item.ID, &item.EventType, &item.Status, &item.RetryCycle, &item.AttemptCount,
		&availableAt, &deliveredAt, &item.LastError, &createdAt)
	if err != nil {
		return notification.Delivery{}, err
	}
	item.AvailableAt, item.DeliveredAt, item.CreatedAt = javaInstant(availableAt), instantPointer(deliveredAt), javaInstant(createdAt)
	item.Attempts = make([]notification.Attempt, 0)
	return item, nil
}

func readConnectorAttempts(ctx context.Context, querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, id string) ([]notification.Attempt, error) {
	return readAttempts(ctx, querier, `SELECT retry_cycle, attempt, status, response_status, error, created_at
FROM feedback.connector_delivery_attempts WHERE queue_id = $1::uuid ORDER BY retry_cycle, attempt`, id)
}

func readLegacyAttempts(ctx context.Context, querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, id string) ([]notification.Attempt, error) {
	return readAttempts(ctx, querier, `SELECT retry_cycle, attempt, status, response_status, error, created_at
FROM feedback.notification_deliveries WHERE outbox_id = $1::uuid ORDER BY retry_cycle, attempt`, id)
}

func readAttempts(ctx context.Context, querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, query, id string) ([]notification.Attempt, error) {
	rows, err := querier.Query(ctx, query, id)
	if err != nil {
		return nil, fmt.Errorf("notification attempt履歴を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]notification.Attempt, 0)
	for rows.Next() {
		var item notification.Attempt
		var createdAt time.Time
		if err := rows.Scan(&item.RetryCycle, &item.Attempt, &item.Status, &item.ResponseStatus, &item.Error, &createdAt); err != nil {
			return nil, fmt.Errorf("notification attemptを読み取れません: %w", err)
		}
		item.CreatedAt = javaInstant(createdAt)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("notification attempt履歴の走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) ClaimConnectorHealth(ctx context.Context) (*connector.HealthTarget, error) {
	var result *connector.HealthTarget
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var target connector.HealthTarget
		var hosts []string
		err := tx.QueryRow(txCtx, `WITH candidate AS (
    SELECT id FROM feedback.connector_installations
    WHERE enabled AND (health_checked_at IS NULL OR health_checked_at < now() - interval '1 minute')
    ORDER BY health_checked_at NULLS FIRST, connector_key
    FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE feedback.connector_installations installation SET
    health_status = 'unknown', health_checked_at = now(), health_error = NULL
FROM candidate WHERE installation.id = candidate.id
RETURNING installation.id::text, installation.health_url, installation.allowed_hosts`).Scan(
			&target.ID, &target.HealthURL, &hosts,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("connector health targetをclaimできません: %w", err)
		}
		target.AllowedHosts = stringSet(hosts)
		result = &target
		return nil
	})
	return result, err
}

func (d *Database) CompleteConnectorHealth(
	ctx context.Context,
	id string,
	result connector.HealthResult,
) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		status := "unhealthy"
		if result.Healthy {
			status = "healthy"
		}
		_, err := tx.Exec(txCtx, `UPDATE feedback.connector_installations SET
    health_status = $1, health_checked_at = now(), health_error = $2
WHERE id = $3::uuid`, status, nullableString(truncateText(result.Error, 2000)), id)
		if err != nil {
			return fmt.Errorf("connector health結果を保存できません: %w", err)
		}
		return nil
	})
}

func (d *Database) ClaimConnectorDelivery(
	ctx context.Context,
	cipher *cryptoutil.Cipher,
) (*connector.ClaimedDelivery, error) {
	var result *connector.ClaimedDelivery
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var delivery connector.ClaimedDelivery
		var payload, location, manifest []byte
		var attemptCount int
		var includeBody bool
		var ciphertext, nonce []byte
		var baseURL, parameter string
		var hosts []string
		err := tx.QueryRow(txCtx, `SELECT queue.id::text, queue.outbox_id::text, outbox.payload,
       queue.attempt_count, queue.retry_cycle, connector.destination_ref, connector.include_body,
       installation.delivery_url, installation.signing_secret_ciphertext,
       installation.signing_secret_nonce, outbox.tenant_id::text,
       thread.location, environment.base_url, environment.deep_link_thread_parameter,
       manifest.manifest, installation.allowed_hosts
FROM feedback.connector_delivery_queue queue
JOIN feedback.notification_outbox outbox ON outbox.id = queue.outbox_id
JOIN feedback.notification_connectors connector ON connector.id = queue.connector_id
JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
LEFT JOIN feedback.feedback_threads thread ON thread.id = NULLIF(outbox.payload->>'threadId', '')::uuid
LEFT JOIN feedback.review_sessions session ON session.id = thread.session_id
LEFT JOIN feedback.application_environments environment ON environment.id = thread.environment_id
LEFT JOIN feedback.application_manifests manifest
  ON manifest.application_id = thread.application_id AND manifest.manifest_version = session.manifest_version
WHERE ((queue.status = 'pending' AND queue.available_at <= now())
    OR (queue.status = 'processing' AND queue.claimed_at < now() - interval '2 minutes'))
  AND connector.enabled AND installation.enabled
ORDER BY queue.created_at
FOR UPDATE OF queue SKIP LOCKED LIMIT 1`).Scan(
			&delivery.ID, &delivery.EventID, &payload, &attemptCount, &delivery.RetryCycle,
			&delivery.DestinationRef, &includeBody, &delivery.DeliveryURL, &ciphertext, &nonce,
			&delivery.TenantID, &location, &baseURL, &parameter, &manifest, &hosts,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("connector deliveryをclaimできません: %w", err)
		}
		var event map[string]json.RawMessage
		if err := json.Unmarshal(payload, &event); err != nil {
			return fmt.Errorf("connector event payloadを解釈できません: %w", err)
		}
		var threadID string
		if err := json.Unmarshal(event["threadId"], &threadID); err != nil || threadID == "" {
			return errors.New("connector eventのthreadIdがありません")
		}
		if len(location) == 0 || len(manifest) == 0 || baseURL == "" || parameter == "" {
			return errors.New("connector eventのdeep link情報がありません")
		}
		deepLink, err := discussion.BuildDeepLink(baseURL, parameter, manifest, location, threadID)
		if err != nil {
			return fmt.Errorf("connector event deep linkを構築できません: %w", err)
		}
		event["deepLink"], _ = json.Marshal(deepLink)
		delivery.Event, err = json.Marshal(event)
		if err != nil {
			return fmt.Errorf("connector eventを構築できません: %w", err)
		}
		delivery.SigningSecret, err = cipher.DecryptString(ciphertext, nonce)
		if err != nil {
			return err
		}
		delivery.Attempt = attemptCount + 1
		delivery.IncludeBody = includeBody
		delivery.AllowedHosts = stringSet(hosts)
		_, err = tx.Exec(txCtx, `UPDATE feedback.connector_delivery_queue SET
    status = 'processing', claimed_at = now(), attempt_count = $1,
    available_at = now() + interval '2 minutes'
WHERE id = $2::uuid`, delivery.Attempt, delivery.ID)
		if err != nil {
			return fmt.Errorf("connector delivery claimを保存できません: %w", err)
		}
		result = &delivery
		return nil
	})
	return result, err
}

func (d *Database) CompleteConnectorDelivery(
	ctx context.Context,
	delivery connector.ClaimedDelivery,
	result connector.DispatchResult,
	maxAttempts int,
) error {
	success := result.Error == "" && result.ResponseStatus != nil && *result.ResponseStatus >= 200 && *result.ResponseStatus <= 299
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		status := "failed"
		if success {
			status = "delivered"
		}
		_, err := tx.Exec(txCtx, `INSERT INTO feedback.connector_delivery_attempts (
    id, queue_id, retry_cycle, attempt, status, response_status, error
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`, uuid.NewString(), delivery.ID,
			delivery.RetryCycle, delivery.Attempt, status, result.ResponseStatus,
			nullableString(truncateText(result.Error, 2000)))
		if err != nil {
			return fmt.Errorf("connector delivery attemptを保存できません: %w", err)
		}
		terminal := !connector.IsRetryableResponse(result.ResponseStatus) || delivery.Attempt >= maxAttempts
		queueStatus := "pending"
		if success {
			queueStatus = "delivered"
		} else if terminal {
			queueStatus = "failed"
		}
		delaySeconds := 1 << min(delivery.Attempt, 10)
		if delaySeconds > 3600 {
			delaySeconds = 3600
		}
		_, err = tx.Exec(txCtx, `UPDATE feedback.connector_delivery_queue SET
    status = $1, available_at = now() + ($2 * interval '1 second'),
    delivered_at = CASE WHEN $3 THEN now() ELSE delivered_at END,
    last_error = $4, claimed_at = NULL
WHERE id = $5::uuid`, queueStatus, delaySeconds, success,
			nullableString(truncateText(result.Error, 2000)), delivery.ID)
		if err != nil {
			return fmt.Errorf("connector delivery結果を更新できません: %w", err)
		}
		if !success {
			_, err = tx.Exec(txCtx, `INSERT INTO feedback.operational_metric_counters (metric_name, tenant_id, value)
VALUES ('delivery_failures_total', $1::uuid, 1)
ON CONFLICT (metric_name, tenant_id) DO UPDATE SET
    value = feedback.operational_metric_counters.value + EXCLUDED.value, updated_at = now()`, delivery.TenantID)
			if err != nil {
				return fmt.Errorf("delivery failure metricを更新できません: %w", err)
			}
		}
		_, err = tx.Exec(txCtx, `UPDATE feedback.notification_outbox outbox SET
    status = CASE
        WHEN EXISTS (SELECT 1 FROM feedback.connector_delivery_queue queue
                     WHERE queue.outbox_id = outbox.id AND queue.status IN ('pending', 'processing')) THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM feedback.connector_delivery_queue queue
                     WHERE queue.outbox_id = outbox.id AND queue.status = 'failed') THEN 'failed'
        ELSE 'delivered'
    END,
    delivered_at = CASE WHEN NOT EXISTS (
        SELECT 1 FROM feedback.connector_delivery_queue queue
        WHERE queue.outbox_id = outbox.id AND queue.status <> 'delivered'
    ) THEN now() ELSE NULL END,
    last_error = (SELECT max(queue.last_error) FROM feedback.connector_delivery_queue queue
                  WHERE queue.outbox_id = outbox.id AND queue.status = 'failed')
WHERE outbox.id = $1::uuid`, delivery.EventID)
		if err != nil {
			return fmt.Errorf("notification outbox集約を更新できません: %w", err)
		}
		return nil
	})
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func truncateText(value string, maximum int) string {
	length := 0
	for index, character := range value {
		width := 1
		if character > 0xffff {
			width = 2
		}
		if length+width > maximum {
			return value[:index]
		}
		length += width
	}
	return value
}

func stringSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[strings.ToLower(value)] = struct{}{}
	}
	return result
}

func notificationNotFound() error {
	return &notification.Error{Kind: notification.ErrorNotFound, Code: "resource.not_found", Detail: "対象resourceが見つかりません"}
}

func notificationVersionMismatch() error {
	return &notification.Error{Kind: notification.ErrorPreconditionFailed, Code: "resource.version_mismatch", Detail: "versionが一致しません"}
}
