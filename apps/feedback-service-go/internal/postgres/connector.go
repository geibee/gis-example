package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

func (d *Database) ListConnectorTypes(ctx context.Context) ([]connector.ConnectorType, error) {
	rows, err := d.Query(ctx, `SELECT connector_key, display_name, protocol_version, supported_events, enabled,
       health_status, health_checked_at, health_error
FROM feedback.connector_installations ORDER BY connector_key`)
	if err != nil {
		return nil, fmt.Errorf("connector type一覧を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]connector.ConnectorType, 0)
	for rows.Next() {
		var item connector.ConnectorType
		var healthCheckedAt *time.Time
		if err := rows.Scan(
			&item.Key, &item.DisplayName, &item.ProtocolVersion, &item.SupportedEvents,
			&item.Enabled, &item.HealthStatus, &healthCheckedAt, &item.HealthError,
		); err != nil {
			return nil, fmt.Errorf("connector typeを読み取れません: %w", err)
		}
		item.HealthCheckedAt = instantPointer(healthCheckedAt)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("connector type一覧の走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) ListNotificationConnectors(
	ctx context.Context,
	scope auth.ResourceScope,
) ([]connector.NotificationConnector, error) {
	rows, err := d.Query(ctx, connectorSelect+`
WHERE connector.workspace_id = $1::uuid AND connector.deleted_at IS NULL
ORDER BY connector.created_at, connector.id`, scope.WorkspaceID)
	if err != nil {
		return nil, fmt.Errorf("通知connector一覧を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]connector.NotificationConnector, 0)
	for rows.Next() {
		item, err := scanNotificationConnector(rows)
		if err != nil {
			return nil, fmt.Errorf("通知connectorを読み取れません: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("通知connector一覧の走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) CreateNotificationConnector(
	ctx context.Context,
	scope auth.ResourceScope,
	request connector.CreateRequest,
) (connector.NotificationConnector, error) {
	var result connector.NotificationConnector
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var installationID string
		err := tx.QueryRow(txCtx, `SELECT id::text
FROM feedback.connector_installations WHERE connector_key = $1 AND enabled`, request.ConnectorType).Scan(&installationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return connectorBadRequest("有効なconnectorTypeではありません")
		}
		if err != nil {
			return fmt.Errorf("connector installationを取得できません: %w", err)
		}
		id := uuid.NewString()
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.notification_connectors (
    id, workspace_id, installation_id, name, destination_ref, enabled, include_body
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`, id, scope.WorkspaceID, installationID,
			strings.TrimSpace(request.Name), strings.TrimSpace(request.DestinationRef), request.Enabled, request.IncludeBody)
		if connectorUniqueViolation(err) {
			return &connector.Error{Kind: connector.ErrorConflict, Code: "connector.name_conflict", Detail: "同じnameの通知connectorがあります"}
		}
		if err != nil {
			return fmt.Errorf("通知connectorを作成できません: %w", err)
		}
		result, err = readNotificationConnector(txCtx, tx, id)
		return err
	})
	return result, err
}

func (d *Database) PatchNotificationConnector(
	ctx context.Context,
	scope auth.ResourceScope,
	id string,
	expectedVersion int,
	request connector.PatchRequest,
) (connector.NotificationConnector, error) {
	var result connector.NotificationConnector
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		tag, err := tx.Exec(txCtx, `UPDATE feedback.notification_connectors SET
    name = $1, destination_ref = $2, enabled = $3, include_body = $4,
    version = version + 1, updated_at = now()
WHERE id = $5::uuid AND workspace_id = $6::uuid AND version = $7 AND deleted_at IS NULL`,
			strings.TrimSpace(request.Name), strings.TrimSpace(request.DestinationRef), request.Enabled,
			request.IncludeBody, id, scope.WorkspaceID, expectedVersion)
		if connectorUniqueViolation(err) {
			return &connector.Error{Kind: connector.ErrorConflict, Code: "connector.name_conflict", Detail: "同じnameの通知connectorがあります"}
		}
		if err != nil {
			return fmt.Errorf("通知connectorを更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return connectorMissingOrVersion(txCtx, tx, scope.WorkspaceID, id)
		}
		if !request.Enabled {
			if err := failPendingConnectorDeliveries(txCtx, tx, id, "connector configuration was disabled"); err != nil {
				return err
			}
		}
		result, err = readNotificationConnector(txCtx, tx, id)
		return err
	})
	return result, err
}

func (d *Database) DeleteNotificationConnector(
	ctx context.Context,
	scope auth.ResourceScope,
	id string,
	expectedVersion int,
) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		tag, err := tx.Exec(txCtx, `UPDATE feedback.notification_connectors
SET enabled = false, deleted_at = now(), updated_at = now(), version = version + 1
WHERE id = $1::uuid AND workspace_id = $2::uuid AND version = $3 AND deleted_at IS NULL`,
			id, scope.WorkspaceID, expectedVersion)
		if err != nil {
			return fmt.Errorf("通知connectorを削除できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return connectorMissingOrVersion(txCtx, tx, scope.WorkspaceID, id)
		}
		return failPendingConnectorDeliveries(txCtx, tx, id, "connector configuration was deleted")
	})
}

func (d *Database) RegisterConnectorInstallation(
	ctx context.Context,
	input connector.ValidatedInstallation,
	cipher *cryptoutil.Cipher,
) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var installationID string
		err := tx.QueryRow(txCtx, `INSERT INTO feedback.connector_installations (
    id, connector_key, display_name, manifest_url, delivery_url, health_url, allowed_hosts,
    signing_secret_ciphertext, signing_secret_nonce, supported_events, enabled
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (connector_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    manifest_url = EXCLUDED.manifest_url,
    delivery_url = EXCLUDED.delivery_url,
    health_url = EXCLUDED.health_url,
    allowed_hosts = EXCLUDED.allowed_hosts,
    signing_secret_ciphertext = EXCLUDED.signing_secret_ciphertext,
    signing_secret_nonce = EXCLUDED.signing_secret_nonce,
    supported_events = EXCLUDED.supported_events,
    enabled = EXCLUDED.enabled,
    version = feedback.connector_installations.version + 1,
    updated_at = now()
RETURNING id::text`, input.ID, input.ConnectorKey, input.DisplayName, input.ManifestURL,
			input.DeliveryURL, input.HealthURL, input.AllowedHosts, input.EncryptedSecret.Ciphertext,
			input.EncryptedSecret.Nonce, input.SupportedEvents, input.Enabled).Scan(&installationID)
		if err != nil {
			return fmt.Errorf("connector installationを登録できません: %w", err)
		}
		if input.ConnectorKey == "webhook" {
			return backfillLegacyWebhookSettings(txCtx, tx, installationID, input.LegacyDestinationRefs, cipher)
		}
		return nil
	})
}

type legacyWebhookSetting struct {
	workspaceID string
	mappingKey  string
	enabled     bool
	includeBody bool
	endpointSHA string
}

func backfillLegacyWebhookSettings(
	ctx context.Context,
	tx Tx,
	installationID string,
	destinationRefs map[string]string,
	cipher *cryptoutil.Cipher,
) error {
	rows, err := tx.Query(ctx, `SELECT settings.workspace_id::text, application.application_key,
       workspace.external_workspace_key, settings.webhook_enabled, settings.include_body,
       settings.webhook_endpoint_ciphertext, settings.webhook_endpoint_nonce
FROM feedback.notification_settings settings
JOIN feedback.workspaces workspace ON workspace.id = settings.workspace_id
JOIN feedback.applications application ON application.id = workspace.application_id
WHERE settings.webhook_endpoint_ciphertext IS NOT NULL
ORDER BY application.application_key, workspace.external_workspace_key
FOR UPDATE OF settings`)
	if err != nil {
		return fmt.Errorf("legacy webhook設定を取得できません: %w", err)
	}
	settings := make([]legacyWebhookSetting, 0)
	for rows.Next() {
		var setting legacyWebhookSetting
		var applicationKey, workspaceKey string
		var ciphertext, nonce []byte
		if err := rows.Scan(&setting.workspaceID, &applicationKey, &workspaceKey, &setting.enabled,
			&setting.includeBody, &ciphertext, &nonce); err != nil {
			rows.Close()
			return fmt.Errorf("legacy webhook設定を読み取れません: %w", err)
		}
		endpoint, err := cipher.Decrypt(ciphertext, nonce)
		if err != nil {
			rows.Close()
			return err
		}
		digest := sha256.Sum256(endpoint)
		setting.endpointSHA = hex.EncodeToString(digest[:])
		setting.mappingKey = applicationKey + "/" + workspaceKey
		settings = append(settings, setting)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("legacy webhook設定の走査に失敗しました: %w", err)
	}
	rows.Close()
	for _, setting := range settings {
		destinationRef, ok := destinationRefs[setting.endpointSHA]
		if !ok {
			destinationRef, ok = destinationRefs[setting.mappingKey]
		}
		if !ok {
			destinationRef, ok = destinationRefs[setting.workspaceID]
		}
		if setting.enabled && !ok {
			return fmt.Errorf("enabled legacy webhook %sのdestinationRef mappingがありません", setting.mappingKey)
		}
		if !ok {
			destinationRef = "legacy-disabled-" + setting.workspaceID
		}
		var connectorID string
		err := tx.QueryRow(ctx, `SELECT id::text FROM feedback.notification_connectors
WHERE workspace_id = $1::uuid AND legacy_settings AND deleted_at IS NULL FOR UPDATE`, setting.workspaceID).Scan(&connectorID)
		if errors.Is(err, pgx.ErrNoRows) {
			connectorID = uuid.NewString()
			_, err = tx.Exec(ctx, `INSERT INTO feedback.notification_connectors (
    id, workspace_id, installation_id, name, destination_ref, enabled, include_body, legacy_settings
) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Legacy Webhook (compatibility)', $4, $5, $6, true)`,
				connectorID, setting.workspaceID, installationID, destinationRef, setting.enabled, setting.includeBody)
		} else if err == nil {
			_, err = tx.Exec(ctx, `UPDATE feedback.notification_connectors SET
    installation_id = $1::uuid, destination_ref = $2, enabled = $3, include_body = $4,
    version = version + 1, updated_at = now()
WHERE id = $5::uuid`, installationID, destinationRef, setting.enabled, setting.includeBody, connectorID)
		}
		if err != nil {
			return fmt.Errorf("legacy webhook connectorを同期できません: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO feedback.connector_delivery_queue (id, outbox_id, connector_id)
SELECT gen_random_uuid(), outbox.id, $1::uuid
FROM feedback.notification_outbox outbox
JOIN feedback.connector_installations installation ON installation.id = $2::uuid
WHERE outbox.workspace_id = $3::uuid
  AND outbox.status IN ('pending', 'processing', 'failed')
  AND outbox.event_type = ANY(installation.supported_events)
ON CONFLICT (outbox_id, connector_id) DO NOTHING`, connectorID, installationID, setting.workspaceID)
		if err != nil {
			return fmt.Errorf("legacy webhook delivery queueを同期できません: %w", err)
		}
	}
	return nil
}

const connectorSelect = `SELECT connector.id::text, installation.connector_key, installation.display_name,
       connector.name, connector.destination_ref, connector.enabled, connector.include_body,
       installation.health_status, installation.health_checked_at, installation.health_error,
       connector.version, connector.created_at, connector.updated_at
FROM feedback.notification_connectors connector
JOIN feedback.connector_installations installation ON installation.id = connector.installation_id`

func readNotificationConnector(ctx context.Context, querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (connector.NotificationConnector, error) {
	item, err := scanNotificationConnector(querier.QueryRow(ctx, connectorSelect+`
WHERE connector.id = $1::uuid AND connector.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return connector.NotificationConnector{}, connectorNotFound()
	}
	if err != nil {
		return connector.NotificationConnector{}, fmt.Errorf("通知connectorを取得できません: %w", err)
	}
	return item, nil
}

type rowScanner interface{ Scan(...any) error }

func scanNotificationConnector(row rowScanner) (connector.NotificationConnector, error) {
	var result connector.NotificationConnector
	var healthCheckedAt *time.Time
	var createdAt, updatedAt time.Time
	err := row.Scan(&result.ID, &result.ConnectorType, &result.DisplayName, &result.Name,
		&result.DestinationRef, &result.Enabled, &result.IncludeBody, &result.HealthStatus,
		&healthCheckedAt, &result.HealthError, &result.Version, &createdAt, &updatedAt)
	if err != nil {
		return connector.NotificationConnector{}, err
	}
	result.HealthCheckedAt = instantPointer(healthCheckedAt)
	result.CreatedAt, result.UpdatedAt = javaInstant(createdAt), javaInstant(updatedAt)
	return result, nil
}

func connectorMissingOrVersion(ctx context.Context, tx Tx, workspaceID, id string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.notification_connectors
    WHERE id = $1::uuid AND workspace_id = $2::uuid AND deleted_at IS NULL
)`, id, workspaceID).Scan(&exists); err != nil {
		return fmt.Errorf("通知connectorの存在を確認できません: %w", err)
	}
	if !exists {
		return connectorNotFound()
	}
	return &connector.Error{Kind: connector.ErrorPreconditionFailed, Code: "resource.version_mismatch", Detail: "versionが一致しません"}
}

func failPendingConnectorDeliveries(ctx context.Context, tx Tx, connectorID, reason string) error {
	if _, err := tx.Exec(ctx, `UPDATE feedback.connector_delivery_queue
SET status = 'failed', claimed_at = NULL, last_error = $1
WHERE connector_id = $2::uuid AND status IN ('pending', 'processing')`, reason, connectorID); err != nil {
		return fmt.Errorf("connector deliveryを停止できません: %w", err)
	}
	_, err := tx.Exec(ctx, refreshOutboxForConnectorSQL, connectorID)
	if err != nil {
		return fmt.Errorf("notification outbox集約を更新できません: %w", err)
	}
	return nil
}

const refreshOutboxForConnectorSQL = `UPDATE feedback.notification_outbox outbox SET
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
WHERE EXISTS (SELECT 1 FROM feedback.connector_delivery_queue affected
              WHERE affected.outbox_id = outbox.id AND affected.connector_id = $1::uuid)`

func connectorBadRequest(detail string) error {
	return &connector.Error{Kind: connector.ErrorBadRequest, Code: "request.invalid", Detail: detail}
}

func connectorNotFound() error {
	return &connector.Error{Kind: connector.ErrorNotFound, Code: "resource.not_found", Detail: "対象resourceが見つかりません"}
}

func connectorUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}
