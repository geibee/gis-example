package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

// ResolveEvidenceScope はthreadの存在を非memberへ漏らさないmembership付きscope queryである。
func (d *Database) ResolveEvidenceScope(
	ctx context.Context,
	userID string,
	threadID string,
) (auth.ResourceScope, error) {
	var scope auth.ResourceScope
	err := d.QueryRow(ctx, `SELECT tenant.id::text, tenant.tenant_key,
       application.id::text, environment.id::text, workspace.id::text,
       application.application_key, environment.environment_key, workspace.external_workspace_key
FROM feedback.feedback_threads thread
JOIN feedback.workspace_memberships membership
  ON membership.workspace_id = thread.workspace_id AND membership.user_id = $1::uuid
JOIN feedback.tenants tenant ON tenant.id = thread.tenant_id
JOIN feedback.applications application ON application.id = thread.application_id
JOIN feedback.application_environments environment ON environment.id = thread.environment_id
JOIN feedback.workspaces workspace ON workspace.id = thread.workspace_id
WHERE thread.id = $2::uuid`, userID, threadID).Scan(
		&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.EnvironmentID, &scope.WorkspaceID,
		&scope.ApplicationKey, &scope.EnvironmentKey, &scope.ExternalWorkspaceKey,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.ResourceScope{}, &evidence.Error{
			Kind: evidence.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません",
		}
	}
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("evidence resource scopeを取得できません: %w", err)
	}
	return scope, nil
}

func (d *Database) GetEvidenceMetadata(ctx context.Context, threadID string) (evidence.Metadata, error) {
	var metadata evidence.Metadata
	err := d.QueryRow(ctx, `SELECT evidence.thread_id::text, evidence.object_key, evidence.content_type,
       evidence.byte_size, evidence.sha256, evidence.viewport_width, evidence.viewport_height,
       evidence.pixel_ratio::double precision, evidence.captured_at
FROM feedback.review_evidence evidence
WHERE evidence.thread_id = $1::uuid`, threadID).Scan(
		&metadata.ThreadID, &metadata.ObjectKey, &metadata.ContentType, &metadata.ByteSize, &metadata.SHA256,
		&metadata.ViewportWidth, &metadata.ViewportHeight, &metadata.PixelRatio, &metadata.CapturedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return evidence.Metadata{}, &evidence.Error{
			Kind: evidence.ErrNotFound, Code: "resource.not_found", Detail: "evidence がありません",
		}
	}
	if err != nil {
		return evidence.Metadata{}, fmt.Errorf("evidence metadataを取得できません: %w", err)
	}
	return metadata, nil
}

func (d *Database) EvidenceObjectExists(ctx context.Context, objectKey string) (bool, error) {
	var exists bool
	if err := d.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.review_evidence WHERE object_key = $1
)`, objectKey).Scan(&exists); err != nil {
		return false, fmt.Errorf("evidence object参照を確認できません: %w", err)
	}
	return exists, nil
}

// DeleteEvidenceMetadata はobject削除後に呼ぶidempotentな単一statementである。
func (d *Database) DeleteEvidenceMetadata(ctx context.Context, objectKey string) error {
	if _, err := d.Exec(ctx, `DELETE FROM feedback.review_evidence WHERE object_key = $1`, objectKey); err != nil {
		return fmt.Errorf("evidence metadataを削除できません: %w", err)
	}
	return nil
}

func (d *Database) RecordEvidenceRead(
	ctx context.Context,
	scope auth.ResourceScope,
	principal auth.Principal,
	threadID string,
	requestID string,
) error {
	return d.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: "evidence.read",
		ResourceType: "thread", ResourceID: threadID, Outcome: "succeeded", RequestID: requestID,
	})
}

func (d *Database) RecordEvidenceAuthorization(
	ctx context.Context,
	scope auth.ResourceScope,
	principal auth.Principal,
	requestID string,
) error {
	return d.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(auth.PermissionRead),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed", RequestID: requestID,
	})
}

func (d *Database) RecordEvidenceStorageFailure(ctx context.Context, tenantID string) error {
	return d.incrementEvidenceMetric(ctx, tenantID, "storage_failures_total")
}

func (d *Database) RecordEvidenceQuotaRejection(ctx context.Context, tenantID string) error {
	return d.incrementEvidenceMetric(ctx, tenantID, "evidence_quota_rejections_total")
}

func (d *Database) incrementEvidenceMetric(ctx context.Context, tenantID string, metricName string) error {
	_, err := d.Exec(ctx, `INSERT INTO feedback.operational_metric_counters (metric_name, tenant_id, value)
VALUES ($1, $2::uuid, 1)
ON CONFLICT (metric_name, tenant_id) DO UPDATE
SET value = feedback.operational_metric_counters.value + 1, updated_at = now()`, metricName, tenantID)
	if err != nil {
		return fmt.Errorf("evidence operational metricを更新できません: %w", err)
	}
	return nil
}

// EnforceEvidenceQuota はthread作成transaction内でquota用advisory lockを取得して件数を検査する。
func (d *Database) EnforceEvidenceQuota(
	ctx context.Context,
	tx Tx,
	workspaceID string,
	maximum int,
) error {
	if tx == nil || maximum <= 0 || uuid.Validate(workspaceID) != nil {
		return &evidence.Error{Kind: evidence.ErrInvalidInput, Code: "request.invalid", Detail: "evidence quota設定が不正です"}
	}
	var lock any
	if err := tx.QueryRow(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"evidence-quota:"+workspaceID,
	).Scan(&lock); err != nil {
		return fmt.Errorf("evidence quota lockを取得できません: %w", err)
	}
	var count int64
	if err := tx.QueryRow(ctx, `SELECT count(*)
FROM feedback.review_evidence evidence
JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id
WHERE thread.workspace_id = $1::uuid`, workspaceID).Scan(&count); err != nil {
		return fmt.Errorf("workspace evidence件数を取得できません: %w", err)
	}
	if count >= int64(maximum) {
		return &evidence.Error{
			Kind: evidence.ErrQuotaExceeded, Code: "evidence.quota_exceeded",
			Detail: "workspace の evidence 件数上限を超えました",
		}
	}
	return nil
}

// InsertEvidenceMetadata はStage後のmetadataだけをthread作成transactionへ保存する。
func (d *Database) InsertEvidenceMetadata(
	ctx context.Context,
	tx Tx,
	threadID string,
	attachment evidence.Attachment,
) error {
	if tx == nil || uuid.Validate(threadID) != nil {
		return &evidence.Error{Kind: evidence.ErrInvalidInput, Code: "request.invalid", Detail: "transactionがありません"}
	}
	if err := evidence.ValidateAttachment(attachment); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO feedback.review_evidence (
    id, thread_id, object_key, content_type, byte_size, sha256,
    viewport_width, viewport_height, pixel_ratio, captured_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)`,
		uuid.NewString(), threadID, attachment.ObjectKey, attachment.ContentType, attachment.ByteSize,
		attachment.SHA256, attachment.ViewportWidth, attachment.ViewportHeight,
		attachment.PixelRatio, attachment.CapturedAt,
	)
	if err != nil {
		return fmt.Errorf("evidence metadataを登録できません: %w", err)
	}
	return nil
}

var _ evidence.Repository = (*Database)(nil)
