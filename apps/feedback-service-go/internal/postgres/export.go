package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const exportEndpoint = "POST /exports"

func (d *Database) CreateExport(
	ctx context.Context,
	scope auth.ResourceScope,
	principal auth.Principal,
	command exportdomain.CreateCommand,
) (exportdomain.Job, error) {
	var saved exportdomain.Job
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		lock := idempotencyLockValue(principal.Subject, exportEndpoint, command.IdempotencyKey)
		if _, err := tx.Exec(txCtx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lock); err != nil {
			return fmt.Errorf("export idempotency lockを取得できません: %w", err)
		}
		var existingHash string
		var existingBody []byte
		err := tx.QueryRow(txCtx, `SELECT request_hash, response_body
FROM feedback.idempotency_records
WHERE tenant_id = $1::uuid AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4
  AND expires_at > now()`, scope.TenantID, principal.Subject, exportEndpoint, command.IdempotencyKey).Scan(
			&existingHash, &existingBody,
		)
		if err == nil {
			if existingHash != command.RequestHash {
				return &usecase.DomainError{
					Kind: usecase.ErrConflict, Code: "idempotency.mismatch",
					Detail: "同じ Idempotency-Key が異なる request に使われました",
				}
			}
			if err := json.Unmarshal(existingBody, &saved); err != nil {
				return fmt.Errorf("export idempotency responseを復元できません: %w", err)
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("export idempotency recordを取得できません: %w", err)
		}
		if err := exportdomain.ValidateRequest(command.Request); err != nil {
			return err
		}
		if command.Request.SessionID != nil {
			var exists bool
			if err := tx.QueryRow(txCtx, `SELECT EXISTS (
    SELECT 1 FROM feedback.review_sessions WHERE id = $1::uuid AND workspace_id = $2::uuid
)`, *command.Request.SessionID, scope.WorkspaceID).Scan(&exists); err != nil {
				return fmt.Errorf("export sessionを確認できません: %w", err)
			}
			if !exists {
				return notFoundError()
			}
		}
		id := uuid.NewString()
		var createdAt time.Time
		if err := tx.QueryRow(txCtx, `INSERT INTO feedback.export_jobs (
    id, tenant_id, application_id, environment_id, workspace_id, session_id,
    requested_by, format, locale, timezone
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10)
RETURNING created_at`, id, scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID,
			optionalString(command.Request.SessionID), principal.Subject, command.Request.Format,
			command.Request.Locale, command.Request.Timezone,
		).Scan(&createdAt); err != nil {
			return fmt.Errorf("export jobを登録できません: %w", err)
		}
		saved = exportdomain.Job{ID: id, Status: "queued", CreatedAt: javaInstant(createdAt)}
		body, err := json.Marshal(saved)
		if err != nil {
			return fmt.Errorf("export idempotency responseを生成できません: %w", err)
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.idempotency_records (
    tenant_id, principal_id, endpoint, idempotency_key, request_hash,
    response_status, response_body, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, 202, $6::jsonb, now() + interval '24 hours')`,
			scope.TenantID, principal.Subject, exportEndpoint, command.IdempotencyKey, command.RequestHash, string(body),
		)
		if err != nil {
			return fmt.Errorf("export idempotency responseを登録できません: %w", err)
		}
		return nil
	})
	return saved, err
}

func (d *Database) ClaimExport(ctx context.Context) (*exportdomain.Claimed, error) {
	var claimed *exportdomain.Claimed
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var value exportdomain.Claimed
		err := tx.QueryRow(txCtx, `SELECT id::text, tenant_id::text, workspace_id::text, format, locale, timezone
FROM feedback.export_jobs
WHERE status = 'queued' OR (status = 'running' AND started_at < now() - interval '5 minutes')
ORDER BY created_at
FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(
			&value.ID, &value.TenantID, &value.WorkspaceID, &value.Format, &value.Locale, &value.Timezone,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("export jobをclaimできません: %w", err)
		}
		value.ClaimToken = uuid.NewString()
		tag, err := tx.Exec(txCtx, `UPDATE feedback.export_jobs
SET status = 'running', started_at = now(), claim_token = $1::uuid, error = NULL
WHERE id = $2::uuid`, value.ClaimToken, value.ID)
		if err != nil {
			return fmt.Errorf("export claimを更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("export claimの更新件数が1ではありません")
		}
		claimed = &value
		return nil
	})
	return claimed, err
}

func (d *Database) PrepareExport(ctx context.Context, claimed exportdomain.Claimed) (exportdomain.Prepared, error) {
	var retentionDays int
	if err := d.QueryRow(ctx, `SELECT COALESCE((
    SELECT export_retention_days FROM feedback.retention_policies WHERE workspace_id = $1::uuid
), 7)`, claimed.WorkspaceID).Scan(&retentionDays); err != nil {
		return exportdomain.Prepared{}, fmt.Errorf("export retentionを取得できません: %w", err)
	}
	rows, err := d.Query(ctx, `SELECT thread.id::text, thread.display_number, thread.session_id::text,
       thread.status, thread.perspective_code, thread.location, thread.target,
       COALESCE(thread.reporter_participant_name, thread.reporter_display_name, thread.reporter_principal_id),
       (SELECT count(*) FROM feedback.feedback_messages message WHERE message.thread_id = thread.id),
       COALESCE((SELECT message.body FROM feedback.feedback_messages message
                 WHERE message.thread_id = thread.id ORDER BY message.created_at DESC, message.id DESC LIMIT 1), ''),
       EXISTS (SELECT 1 FROM feedback.review_evidence evidence WHERE evidence.thread_id = thread.id),
       thread.created_at, thread.updated_at, environment.base_url,
       environment.deep_link_thread_parameter, manifest.manifest
FROM feedback.export_jobs job
JOIN feedback.feedback_threads thread ON thread.workspace_id = job.workspace_id
  AND (job.session_id IS NULL OR thread.session_id = job.session_id)
JOIN feedback.review_sessions session ON session.id = thread.session_id
JOIN feedback.application_environments environment ON environment.id = job.environment_id
JOIN feedback.application_manifests manifest
  ON manifest.application_id = job.application_id AND manifest.manifest_version = session.manifest_version
WHERE job.id = $1::uuid
ORDER BY thread.created_at, thread.id`, claimed.ID)
	if err != nil {
		return exportdomain.Prepared{}, fmt.Errorf("export rowを取得できません: %w", err)
	}
	defer rows.Close()
	result := exportdomain.Prepared{Rows: make([]exportdomain.Row, 0), RetentionDays: retentionDays}
	for rows.Next() {
		var row exportdomain.Row
		var location, target, manifest []byte
		var baseURL, threadParameter string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(
			&row.ThreadID, &row.DisplayNumber, &row.SessionID, &row.Status, &row.PerspectiveCode,
			&location, &target, &row.ReporterName, &row.MessageCount, &row.LatestMessage,
			&row.EvidenceAvailable, &createdAt, &updatedAt, &baseURL, &threadParameter, &manifest,
		); err != nil {
			return exportdomain.Prepared{}, fmt.Errorf("export rowを読み取れません: %w", err)
		}
		var locationFields struct {
			PageKey       string `json:"pageKey"`
			RouteTemplate string `json:"routeTemplate"`
		}
		var targetFields struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(location, &locationFields); err != nil {
			return exportdomain.Prepared{}, fmt.Errorf("export locationを読み取れません: %w", err)
		}
		if err := json.Unmarshal(target, &targetFields); err != nil {
			return exportdomain.Prepared{}, fmt.Errorf("export targetを読み取れません: %w", err)
		}
		row.PageKey, row.RouteTemplate, row.TargetKind = locationFields.PageKey, locationFields.RouteTemplate, targetFields.Kind
		row.DeepLink, err = exportdomain.BuildDeepLink(baseURL, threadParameter, manifest, location, row.ThreadID)
		if err != nil {
			return exportdomain.Prepared{}, fmt.Errorf("export deep linkを生成できません: %w", err)
		}
		row.CreatedAt, row.UpdatedAt = javaInstant(createdAt), javaInstant(updatedAt)
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return exportdomain.Prepared{}, fmt.Errorf("export rowの走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) CompleteExport(
	ctx context.Context, claimed exportdomain.Claimed, objectKey string, retentionDays int,
) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		tag, err := tx.Exec(txCtx, `UPDATE feedback.export_jobs SET
    status = 'completed', object_key = $1, expires_at = now() + ($2 * interval '1 day'),
    completed_at = now(), error = NULL, claim_token = NULL
WHERE id = $3::uuid AND status = 'running' AND claim_token = $4::uuid`,
			objectKey, retentionDays, claimed.ID, claimed.ClaimToken,
		)
		if err != nil {
			return fmt.Errorf("export完了状態を更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("export jobの完了状態を更新できません")
		}
		return nil
	})
}

func (d *Database) FailExport(ctx context.Context, claimed exportdomain.Claimed, message string) error {
	message = truncateUTF16(message, 2000)
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		_, err := tx.Exec(txCtx, `UPDATE feedback.export_jobs
SET status = 'failed', error = $1, completed_at = now(), claim_token = NULL
WHERE id = $2::uuid AND status = 'running' AND claim_token = $3::uuid`,
			message, claimed.ID, claimed.ClaimToken,
		)
		return err
	})
}

func (d *Database) GetExport(ctx context.Context, id string) (exportdomain.Job, error) {
	var result exportdomain.Job
	var expiresAt *time.Time
	var createdAt time.Time
	err := d.QueryRow(ctx, `SELECT id::text, status, expires_at, created_at, error
FROM feedback.export_jobs WHERE id = $1::uuid`, id).Scan(
		&result.ID, &result.Status, &expiresAt, &createdAt, &result.Error,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return exportdomain.Job{}, notFoundError()
	}
	if err != nil {
		return exportdomain.Job{}, fmt.Errorf("export jobを取得できません: %w", err)
	}
	result.CreatedAt = javaInstant(createdAt)
	result.ExpiresAt = instantPointer(expiresAt)
	if result.Status == "completed" && expiresAt != nil && expiresAt.After(time.Now()) {
		download := "/feedback/v1/exports/" + result.ID + "/download"
		result.DownloadURL = &download
	}
	return result, nil
}

func (d *Database) GetStoredExport(ctx context.Context, id string) (exportdomain.StoredMetadata, error) {
	var result exportdomain.StoredMetadata
	err := d.QueryRow(ctx, `SELECT object_key, format FROM feedback.export_jobs
WHERE id = $1::uuid AND status = 'completed' AND expires_at > now() AND object_key IS NOT NULL`, id).Scan(
		&result.ObjectKey, &result.Format,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return exportdomain.StoredMetadata{}, &usecase.DomainError{
			Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "export file がないか期限切れです",
		}
	}
	if err != nil {
		return exportdomain.StoredMetadata{}, fmt.Errorf("stored exportを取得できません: %w", err)
	}
	return result, nil
}
