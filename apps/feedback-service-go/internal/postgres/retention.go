package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
)

func (d *Database) ResolveRetentionWorkspaceScope(
	ctx context.Context, userID, applicationKey, externalWorkspaceKey string,
) (auth.ResourceScope, error) {
	return d.ResolveBackupWorkspaceScope(ctx, userID, applicationKey, externalWorkspaceKey)
}

func (d *Database) GetRetentionPolicy(
	ctx context.Context, scope auth.ResourceScope,
) (retention.Policy, int, error) {
	var policy retention.Policy
	var version int
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureRetentionPolicy(txCtx, tx, scope.WorkspaceID); err != nil {
			return err
		}
		if err := tx.QueryRow(txCtx, `SELECT evidence_retention_days, export_retention_days, version
FROM feedback.retention_policies WHERE workspace_id = $1::uuid`, scope.WorkspaceID).Scan(
			&policy.EvidenceRetentionDays, &policy.ExportRetentionDays, &version,
		); err != nil {
			return fmt.Errorf("retention policyを取得できません: %w", err)
		}
		return nil
	})
	return policy, version, err
}

func (d *Database) PatchRetentionPolicy(
	ctx context.Context, scope auth.ResourceScope, expectedVersion int, policy retention.Policy,
) (retention.Policy, int, error) {
	if err := retention.ValidatePolicy(policy); err != nil {
		return retention.Policy{}, 0, err
	}
	var version int
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureRetentionPolicy(txCtx, tx, scope.WorkspaceID); err != nil {
			return err
		}
		err := tx.QueryRow(txCtx, `UPDATE feedback.retention_policies
SET evidence_retention_days = $1, export_retention_days = $2,
    version = version + 1, updated_at = now()
WHERE workspace_id = $3::uuid AND version = $4 RETURNING version`,
			optionalInt(policy.EvidenceRetentionDays), policy.ExportRetentionDays,
			scope.WorkspaceID, expectedVersion,
		).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return versionMismatchError()
		}
		if err != nil {
			return fmt.Errorf("retention policyを更新できません: %w", err)
		}
		return nil
	})
	return policy, version, err
}

func ensureRetentionPolicy(ctx context.Context, queryer sessionQueryer, workspaceID string) error {
	if _, err := queryer.Exec(ctx, `INSERT INTO feedback.retention_policies (workspace_id)
VALUES ($1::uuid) ON CONFLICT DO NOTHING`, workspaceID); err != nil {
		return fmt.Errorf("retention policyを初期化できません: %w", err)
	}
	return nil
}

func (d *Database) DeleteExpiredInternalRecords(ctx context.Context) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if _, err := tx.Exec(txCtx, `DELETE FROM feedback.idempotency_records WHERE expires_at <= now()`); err != nil {
			return fmt.Errorf("期限切れidempotency recordを削除できません: %w", err)
		}
		if _, err := tx.Exec(txCtx, `DELETE FROM feedback.rate_limit_counters
WHERE window_epoch < floor(extract(epoch FROM now()) / 60)::bigint - 2`); err != nil {
			return fmt.Errorf("期限切れrate limit counterを削除できません: %w", err)
		}
		if _, err := tx.Exec(txCtx, `DELETE FROM feedback.write_rate_limit_counters
WHERE window_epoch < floor(extract(epoch FROM now()) / 60)::bigint - 2`); err != nil {
			return fmt.Errorf("期限切れwrite rate limit counterを削除できません: %w", err)
		}
		return nil
	})
}

type expiredObject struct {
	ID            string
	ObjectKey     string
	TenantID      string
	ApplicationID string
	WorkspaceID   string
}

func (d *Database) PurgeExpiredEvidence(
	ctx context.Context, limit int, deleteObject retention.DeleteObjectFunc,
) (int, error) {
	if err := validatePurgeInput(limit, deleteObject); err != nil {
		return 0, err
	}
	var items []expiredObject
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		rows, err := tx.Query(txCtx, `SELECT evidence.id::text, evidence.object_key,
       thread.tenant_id::text, thread.application_id::text, thread.workspace_id::text
FROM feedback.review_evidence evidence
JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id
JOIN feedback.review_sessions session ON session.id = thread.session_id
LEFT JOIN LATERAL (
    SELECT evidence_retention_days FROM feedback.retention_policies policy
    WHERE policy.workspace_id = thread.workspace_id FOR UPDATE
) policy ON true
WHERE COALESCE(
    evidence.expires_at,
    evidence.created_at + (COALESCE(session.evidence_retention_days, policy.evidence_retention_days) * interval '1 day')
) <= now()
ORDER BY evidence.created_at
FOR UPDATE OF evidence, session SKIP LOCKED
LIMIT $1`, limit)
		if err != nil {
			return fmt.Errorf("期限切れevidenceをclaimできません: %w", err)
		}
		items, err = scanExpiredObjects(rows)
		if err != nil {
			return err
		}
		for _, item := range items {
			tag, err := tx.Exec(txCtx, `DELETE FROM feedback.review_evidence WHERE id = $1::uuid`, item.ID)
			if err != nil {
				return fmt.Errorf("期限切れevidence metadataを削除できません: %w", err)
			}
			if tag.RowsAffected() != 1 {
				return errors.New("期限切れevidence metadataの削除件数が一致しません")
			}
			if err := recordRetentionPurge(txCtx, tx, item, "evidence.purge", "evidence"); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return deletePurgedObjects(ctx, items, deleteObject, "evidence")
}

func (d *Database) PurgeExpiredExports(
	ctx context.Context, limit int, deleteObject retention.DeleteObjectFunc,
) (int, error) {
	return d.purgeExpiredStoredRun(ctx, limit, deleteObject, "export_jobs", "export.purge", "export")
}

func (d *Database) PurgeExpiredBackups(
	ctx context.Context, limit int, deleteObject retention.DeleteObjectFunc,
) (int, error) {
	return d.purgeExpiredStoredRun(ctx, limit, deleteObject, "backup_runs", "backup.purge", "backup")
}

func (d *Database) purgeExpiredStoredRun(
	ctx context.Context,
	limit int,
	deleteObject retention.DeleteObjectFunc,
	table string,
	action string,
	resourceType string,
) (int, error) {
	if err := validatePurgeInput(limit, deleteObject); err != nil {
		return 0, err
	}
	if table != "export_jobs" && table != "backup_runs" {
		return 0, errors.New("retention対象tableが不正です")
	}
	var items []expiredObject
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		query := fmt.Sprintf(`SELECT id::text, object_key, tenant_id::text, application_id::text, workspace_id::text
FROM feedback.%s
WHERE status = 'completed' AND expires_at <= now() AND object_key IS NOT NULL
ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1`, table)
		rows, err := tx.Query(txCtx, query, limit)
		if err != nil {
			return fmt.Errorf("期限切れ%sをclaimできません: %w", resourceType, err)
		}
		items, err = scanExpiredObjects(rows)
		if err != nil {
			return err
		}
		for _, item := range items {
			update := fmt.Sprintf(`UPDATE feedback.%s SET object_key = NULL WHERE id = $1::uuid`, table)
			tag, err := tx.Exec(txCtx, update, item.ID)
			if err != nil {
				return fmt.Errorf("期限切れ%s metadataを更新できません: %w", resourceType, err)
			}
			if tag.RowsAffected() != 1 {
				return fmt.Errorf("期限切れ%s metadataの更新件数が一致しません", resourceType)
			}
			if err := recordRetentionPurge(txCtx, tx, item, action, resourceType); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return deletePurgedObjects(ctx, items, deleteObject, resourceType)
}

func deletePurgedObjects(
	ctx context.Context,
	items []expiredObject,
	deleteObject retention.DeleteObjectFunc,
	resourceType string,
) (int, error) {
	var deleteErrors []error
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			deleteErrors = append(deleteErrors, err)
			break
		}
		if err := deleteObject(ctx, item.ObjectKey); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf("%s %s: %w", resourceType, item.ID, err))
		}
	}
	if len(deleteErrors) != 0 {
		return len(items), fmt.Errorf("期限切れ%s objectを削除できません（orphan sweepで再試行します）: %w",
			resourceType, errors.Join(deleteErrors...))
	}
	return len(items), nil
}

func (d *Database) ExportObjectExists(ctx context.Context, objectKey string) (bool, error) {
	var exists bool
	if err := d.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.export_jobs WHERE object_key = $1
)`, objectKey).Scan(&exists); err != nil {
		return false, fmt.Errorf("export object参照を確認できません: %w", err)
	}
	return exists, nil
}

func (d *Database) BackupObjectExists(ctx context.Context, objectKey string) (bool, error) {
	var exists bool
	if err := d.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.backup_runs WHERE object_key = $1
)`, objectKey).Scan(&exists); err != nil {
		return false, fmt.Errorf("backup object参照を確認できません: %w", err)
	}
	return exists, nil
}

func scanExpiredObjects(rows pgx.Rows) ([]expiredObject, error) {
	defer rows.Close()
	items := make([]expiredObject, 0)
	for rows.Next() {
		var item expiredObject
		if err := rows.Scan(
			&item.ID, &item.ObjectKey, &item.TenantID, &item.ApplicationID, &item.WorkspaceID,
		); err != nil {
			return nil, fmt.Errorf("retention対象を読み取れません: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("retention対象を列挙できません: %w", err)
	}
	return items, nil
}

func recordRetentionPurge(
	ctx context.Context, tx Tx, item expiredObject, action string, resourceType string,
) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback.audit_logs (
    id, tenant_id, application_id, workspace_id, action, resource_type,
    resource_id, outcome, request_id, changes
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
          'succeeded', $8, '{"reason":"retention-policy"}'::jsonb)`,
		uuid.NewString(), item.TenantID, item.ApplicationID, item.WorkspaceID,
		action, resourceType, item.ID, "retention:"+uuid.NewString(),
	)
	if err != nil {
		return fmt.Errorf("%s監査を記録できません: %w", resourceType, err)
	}
	return nil
}

func validatePurgeInput(limit int, deleteObject retention.DeleteObjectFunc) error {
	if limit < 1 || limit > 1000 || deleteObject == nil {
		return errors.New("retention purge入力が不正です")
	}
	return nil
}

var (
	_ retention.Store       = (*Database)(nil)
	_ retention.WorkerStore = (*Database)(nil)
)
