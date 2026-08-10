package postgres

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/legacymigration"
)

func (d *Database) ValidateLegacyMigrationSchema(ctx context.Context) error {
	if err := d.ValidateMigrationHandoff(ctx); err != nil {
		return legacySchemaMismatch("legacy migration対象Feedback schemaがV6 handoff契約と一致しません: " + err.Error())
	}
	var runs, entities *string
	if err := d.QueryRow(ctx, `SELECT to_regclass('feedback_migration.legacy_migration_runs')::text,
       to_regclass('feedback_migration.legacy_migration_entities')::text`).Scan(&runs, &entities); err != nil {
		return fmt.Errorf("legacy migration journalを確認できません: %w", err)
	}
	if runs == nil || entities == nil {
		return &legacymigration.Error{
			Kind: legacymigration.ErrSchemaMismatch, Code: "legacy.journal_missing",
			Detail: "feedback_migration journalがprovisionされていません",
		}
	}
	return nil
}

func (d *Database) ResolveLegacyMigrationScope(
	ctx context.Context,
	snapshot legacymigration.Snapshot,
) (legacymigration.Scope, error) {
	rows, err := d.Query(ctx, `SELECT tenant.id::text, application.id::text, environment.id::text,
       workspace.id::text, manifest.manifest
FROM feedback.applications application
JOIN feedback.tenants tenant ON tenant.id = application.tenant_id
JOIN feedback.application_environments environment
  ON environment.application_id = application.id AND environment.environment_key = $1
JOIN feedback.workspaces workspace
  ON workspace.application_id = application.id AND workspace.external_workspace_key = $2
JOIN feedback.application_manifests manifest
  ON manifest.application_id = application.id AND manifest.manifest_version = $3
WHERE application.application_key = $4`, snapshot.EnvironmentKey, snapshot.ExternalWorkspaceKey,
		snapshot.ManifestVersion, snapshot.ApplicationKey)
	if err != nil {
		return legacymigration.Scope{}, fmt.Errorf("legacy migration scopeを取得できません: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return legacymigration.Scope{}, &legacymigration.Error{
			Kind: legacymigration.ErrInvalidInput, Code: "legacy.scope_not_provisioned",
			Detail: "対象application/environment/workspace/manifestがprovision済みではありません",
		}
	}
	var scope legacymigration.Scope
	if err := rows.Scan(&scope.TenantID, &scope.ApplicationID, &scope.EnvironmentID, &scope.WorkspaceID, &scope.Manifest); err != nil {
		return legacymigration.Scope{}, fmt.Errorf("legacy migration scopeを読み取れません: %w", err)
	}
	if rows.Next() {
		return legacymigration.Scope{}, &legacymigration.Error{
			Kind: legacymigration.ErrConflict, Code: "legacy.scope_ambiguous",
			Detail: "legacy migration scopeが複数あります",
		}
	}
	if err := rows.Err(); err != nil {
		return legacymigration.Scope{}, fmt.Errorf("legacy migration scopeを走査できません: %w", err)
	}
	return scope, nil
}

func (d *Database) FindLegacyMigrationRun(ctx context.Context, runID string) (legacymigration.Run, bool, error) {
	var run legacymigration.Run
	err := d.QueryRow(ctx, `SELECT id::text, source_checksum, status
FROM feedback_migration.legacy_migration_runs WHERE id = $1::uuid`, runID).Scan(
		&run.ID, &run.SourceChecksum, &run.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return legacymigration.Run{}, false, nil
	}
	if err != nil {
		return legacymigration.Run{}, false, fmt.Errorf("legacy migration runを取得できません: %w", err)
	}
	return run, true, nil
}

func (d *Database) CheckLegacyMigrationCollisions(
	ctx context.Context,
	input legacymigration.CollisionInput,
) error {
	targets := []struct {
		table string
		ids   []string
	}{
		{"feedback.review_sessions", collectLegacyIDs(input.Snapshot.Sessions, func(value legacymigration.SessionSnapshot) string { return value.ID })},
		{"feedback.review_scopes", collectLegacyScopeIDs(input.Snapshot)},
		{"feedback.feedback_threads", collectLegacyIDs(input.Snapshot.Threads, func(value legacymigration.ThreadSnapshot) string { return value.ID })},
		{"feedback.feedback_messages", collectLegacyIDs(input.Snapshot.Messages, func(value legacymigration.MessageSnapshot) string { return value.ID })},
		{"feedback.review_evidence", collectLegacyIDs(input.Snapshot.Evidence, func(value legacymigration.EvidenceSnapshot) string { return value.ID })},
		{"feedback.audit_logs", collectLegacyIDs(input.Snapshot.Audits, func(value legacymigration.AuditSnapshot) string { return value.ID })},
		{"feedback.notification_outbox", collectLegacyIDs(input.Snapshot.Outbox, func(value legacymigration.OutboxSnapshot) string { return value.ID })},
	}
	for _, target := range targets {
		count, err := legacyCountIDs(ctx, d, target.table, "id", target.ids)
		if err != nil {
			return fmt.Errorf("legacy collisionを確認できません: %w", err)
		}
		if count != 0 {
			return &legacymigration.Error{
				Kind: legacymigration.ErrConflict, Code: "legacy.id_collision",
				Detail: target.table + "に同じIDが既にあります",
			}
		}
	}
	var activeID string
	err := d.QueryRow(ctx, `SELECT id::text
FROM feedback_migration.legacy_migration_runs
WHERE source_system = $1 AND source_checksum = $2 AND workspace_id = $3::uuid AND status = 'applied'
LIMIT 1`, input.Snapshot.SourceSystem, input.SourceChecksum, input.Scope.WorkspaceID).Scan(&activeID)
	if err == nil {
		return &legacymigration.Error{
			Kind: legacymigration.ErrConflict, Code: "legacy.source_already_applied",
			Detail: "同じsource snapshotは既に適用されています",
		}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("legacy active runを確認できません: %w", err)
	}
	return nil
}

func (d *Database) ApplyLegacyMigration(ctx context.Context, plan legacymigration.ApplyPlan) error {
	callbackCompleted := false
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := insertLegacyRun(txCtx, tx, plan); err != nil {
			return err
		}
		for _, session := range plan.Snapshot.Sessions {
			if err := insertLegacySession(txCtx, tx, session, plan); err != nil {
				return err
			}
		}
		for _, thread := range plan.Threads {
			if err := insertLegacyThread(txCtx, tx, thread, plan.Scope); err != nil {
				return err
			}
		}
		for _, message := range plan.Snapshot.Messages {
			if err := insertLegacyMessage(txCtx, tx, message, plan.Snapshot.MessageVersions); err != nil {
				return err
			}
		}
		for _, version := range plan.Snapshot.MessageVersions {
			if err := insertLegacyMessageVersion(txCtx, tx, version, plan.Snapshot.Messages); err != nil {
				return err
			}
		}
		for _, evidence := range plan.Evidence {
			if err := insertLegacyEvidence(txCtx, tx, evidence); err != nil {
				return err
			}
		}
		for _, audit := range plan.Snapshot.Audits {
			if err := insertLegacyAudit(txCtx, tx, audit, plan.Scope); err != nil {
				return err
			}
		}
		for _, outbox := range plan.Snapshot.Outbox {
			if err := insertLegacyOutbox(txCtx, tx, outbox, plan.Scope); err != nil {
				return err
			}
		}
		trackedRetention, err := insertLegacyRetention(txCtx, tx, plan.Snapshot.ProjectEvidenceRetentionDays, plan.Scope.WorkspaceID)
		if err != nil {
			return err
		}
		if trackedRetention {
			if err := trackLegacyEntity(txCtx, tx, plan.Report.RunID, "retention-policy", plan.Scope.WorkspaceID); err != nil {
				return err
			}
		}
		for _, session := range plan.Snapshot.Sessions {
			if err := trackLegacyEntity(txCtx, tx, plan.Report.RunID, "session", session.ID); err != nil {
				return err
			}
		}
		for _, evidence := range plan.Evidence {
			if err := trackLegacyEntity(txCtx, tx, plan.Report.RunID, "evidence-object", evidence.ObjectKey); err != nil {
				return err
			}
		}
		for _, audit := range plan.Snapshot.Audits {
			if err := trackLegacyEntity(txCtx, tx, plan.Report.RunID, "audit", audit.ID); err != nil {
				return err
			}
		}
		for _, outbox := range plan.Snapshot.Outbox {
			if err := trackLegacyEntity(txCtx, tx, plan.Report.RunID, "outbox", outbox.ID); err != nil {
				return err
			}
		}
		callbackCompleted = true
		return nil
	})
	if err != nil && callbackCompleted {
		return errors.Join(&legacymigration.Error{
			Kind: legacymigration.ErrCommitUnknown, Code: "legacy.commit_unknown",
			Detail: "migration transactionのcommit結果を確認できません",
		}, err)
	}
	return err
}

func insertLegacyRun(ctx context.Context, tx Tx, plan legacymigration.ApplyPlan) error {
	summary, err := json.Marshal(plan.Report)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback_migration.legacy_migration_runs (
    id, source_system, source_checksum, application_id, environment_id, workspace_id, status, summary
) VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, 'applied', $7::jsonb)`,
		plan.Report.RunID, plan.Snapshot.SourceSystem, plan.Report.SourceChecksum, plan.Scope.ApplicationID,
		plan.Scope.EnvironmentID, plan.Scope.WorkspaceID, string(summary))
	if err != nil {
		return fmt.Errorf("legacy migration runを登録できません: %w", err)
	}
	return nil
}

func insertLegacySession(ctx context.Context, tx Tx, value legacymigration.SessionSnapshot, plan legacymigration.ApplyPlan) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback.review_sessions (
    id, tenant_id, application_id, environment_id, workspace_id, manifest_version, title,
    description, status, out_of_scope_posting, start_at, end_at, created_by, created_at,
    updated_at, evidence_retention_days
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, 'warn',
          $10::timestamptz, $11::timestamptz, $12, $13::timestamptz, $14::timestamptz, $15)`,
		value.ID, plan.Scope.TenantID, plan.Scope.ApplicationID, plan.Scope.EnvironmentID, plan.Scope.WorkspaceID,
		plan.Snapshot.ManifestVersion, value.Title, value.Description, strings.ToLower(value.Status), value.StartAt,
		value.EndAt, legacyDefault(value.CreatedBy, "legacy:unknown"), value.CreatedAt, value.UpdatedAt, value.EvidenceRetentionDays)
	if err != nil {
		return fmt.Errorf("legacy sessionを登録できません: %w", err)
	}
	scopes := append([]legacymigration.ScopeSnapshot(nil), value.Scopes...)
	slices.SortStableFunc(scopes, func(left, right legacymigration.ScopeSnapshot) int {
		return left.DisplayOrder - right.DisplayOrder
	})
	for _, valueScope := range scopes {
		if _, err := tx.Exec(ctx, `INSERT INTO feedback.review_scopes
    (id, session_id, page_key, route_template, reviewable) VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
			valueScope.ID, value.ID, valueScope.PageID, valueScope.Route, valueScope.Reviewable); err != nil {
			return fmt.Errorf("legacy review scopeを登録できません: %w", err)
		}
	}
	perspectives := append([]legacymigration.PerspectiveSnapshot(nil), value.Perspectives...)
	slices.SortStableFunc(perspectives, func(left, right legacymigration.PerspectiveSnapshot) int {
		return left.DisplayOrder - right.DisplayOrder
	})
	for _, perspective := range perspectives {
		if _, err := tx.Exec(ctx, `INSERT INTO feedback.review_session_perspectives
    (session_id, code, label, status, guidance) VALUES ($1::uuid, $2, $3, $4, $5)`, value.ID,
			perspective.Code, perspective.Label, strings.ReplaceAll(strings.ToLower(perspective.Status), "_", "-"),
			perspective.Guidance); err != nil {
			return fmt.Errorf("legacy perspectiveを登録できません: %w", err)
		}
	}
	next := 1
	for _, thread := range plan.Snapshot.Threads {
		if thread.ReviewSessionID == value.ID && thread.DisplayNumber >= next {
			next = thread.DisplayNumber + 1
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO feedback.thread_sequences (session_id, next_number) VALUES ($1::uuid, $2)`,
		value.ID, next); err != nil {
		return fmt.Errorf("legacy thread sequenceを登録できません: %w", err)
	}
	return nil
}

func insertLegacyThread(ctx context.Context, tx Tx, mapped legacymigration.MappedThread, scope legacymigration.Scope) error {
	value := mapped.Source
	_, err := tx.Exec(ctx, `INSERT INTO feedback.feedback_threads (
    id, tenant_id, application_id, environment_id, workspace_id, session_id, display_number,
    location, target, perspective_code, status, reporter_principal_id, reporter_display_name,
    reporter_participant_name, created_at, updated_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb, $9::jsonb,
          $10, $11, $12, $13, $14, $15::timestamptz, $16::timestamptz)`,
		value.ID, scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID, value.ReviewSessionID,
		value.DisplayNumber, string(mapped.Location), string(mapped.Target), value.PerspectiveCode,
		strings.ToLower(value.Status), value.ReporterPrincipalID, value.ReporterDisplayName, value.ReporterName,
		value.CreatedAt, value.UpdatedAt)
	if err != nil {
		return fmt.Errorf("legacy threadを登録できません: %w", err)
	}
	return nil
}

func insertLegacyMessage(
	ctx context.Context,
	tx Tx,
	value legacymigration.MessageSnapshot,
	versions []legacymigration.MessageVersionSnapshot,
) error {
	currentVersion := 0
	for _, version := range versions {
		if version.MessageID == value.ID && version.Version > currentVersion {
			currentVersion = version.Version
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO feedback.feedback_messages (
    id, thread_id, author_principal_id, author_display_name, author_participant_name,
    body, version, created_at, edited_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
		value.ID, value.ThreadID, value.AuthorPrincipalID, value.AuthorDisplayName, value.ParticipantName,
		value.Body, currentVersion, value.CreatedAt, value.EditedAt)
	if err != nil {
		return fmt.Errorf("legacy messageを登録できません: %w", err)
	}
	return nil
}

func insertLegacyMessageVersion(
	ctx context.Context,
	tx Tx,
	value legacymigration.MessageVersionSnapshot,
	messages []legacymigration.MessageSnapshot,
) error {
	var message *legacymigration.MessageSnapshot
	for index := range messages {
		if messages[index].ID == value.MessageID {
			message = &messages[index]
			break
		}
	}
	if message == nil {
		return errors.New("legacy message versionの親messageがありません")
	}
	_, err := tx.Exec(ctx, `INSERT INTO feedback.feedback_message_versions (
    message_id, thread_id, version, author_principal_id, author_display_name,
    author_participant_name, body, created_at, edited_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
		value.MessageID, message.ThreadID, value.Version, value.EditorPrincipalID, value.EditorDisplayName,
		value.EditorParticipantName, value.Body, message.CreatedAt, value.CreatedAt)
	if err != nil {
		return fmt.Errorf("legacy message versionを登録できません: %w", err)
	}
	return nil
}

func insertLegacyEvidence(ctx context.Context, tx Tx, value legacymigration.PlannedEvidence) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback.review_evidence (
    id, thread_id, object_key, content_type, byte_size, sha256, viewport_width,
    viewport_height, pixel_ratio, captured_at, created_at, expires_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz)`,
		value.Source.ID, value.ThreadID, value.ObjectKey, value.Source.ContentType, int64(len(value.Data)),
		value.Source.SHA256, value.Source.ViewportWidth, value.Source.ViewportHeight, value.Source.PixelRatio,
		value.Source.CapturedAt, value.Source.CreatedAt, value.Source.ExpiresAt)
	if err != nil {
		return fmt.Errorf("legacy evidence metadataを登録できません: %w", err)
	}
	return nil
}

func insertLegacyAudit(ctx context.Context, tx Tx, value legacymigration.AuditSnapshot, scope legacymigration.Scope) error {
	outcome, err := legacymigration.NormalizeAuditOutcome(value.Outcome)
	if err != nil {
		return err
	}
	changes, err := legacymigration.SanitizeAuditChanges(value.Changes)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback.audit_logs (
    id, tenant_id, application_id, workspace_id, principal_id, action, resource_type,
    resource_id, outcome, request_id, changes, occurred_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz)`,
		value.ID, scope.TenantID, scope.ApplicationID, scope.WorkspaceID, value.PrincipalID, value.Action,
		value.ResourceType, value.ResourceID, outcome, value.RequestID, nullableRawJSON(changes), value.OccurredAt)
	if err != nil {
		return fmt.Errorf("legacy auditを登録できません: %w", err)
	}
	return nil
}

func insertLegacyOutbox(ctx context.Context, tx Tx, value legacymigration.OutboxSnapshot, scope legacymigration.Scope) error {
	eventType, err := legacymigration.NormalizeEventType(value.EventType)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"eventId": value.ID, "eventType": eventType, "workspaceId": scope.WorkspaceID,
		"sessionId": value.ReviewSessionID, "threadId": value.ThreadID,
	}
	if value.MessageID != nil {
		payload["messageId"] = *value.MessageID
	}
	if value.ActorPrincipalID != nil {
		payload["actorPrincipalId"] = *value.ActorPrincipalID
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback.notification_outbox (
    id, tenant_id, workspace_id, event_type, payload, status, attempt_count,
    available_at, delivered_at, created_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'delivered', 0,
          $6::timestamptz, $6::timestamptz, $6::timestamptz)`, value.ID, scope.TenantID,
		scope.WorkspaceID, eventType, string(raw), value.CreatedAt)
	if err != nil {
		return fmt.Errorf("legacy outboxを登録できません: %w", err)
	}
	return nil
}

func insertLegacyRetention(ctx context.Context, tx Tx, days *int, workspaceID string) (bool, error) {
	if days == nil {
		return false, nil
	}
	var existing *int
	err := tx.QueryRow(ctx, `SELECT evidence_retention_days FROM feedback.retention_policies
WHERE workspace_id = $1::uuid`, workspaceID).Scan(&existing)
	if err == nil {
		if existing == nil || *existing != *days {
			return false, &legacymigration.Error{
				Kind: legacymigration.ErrConflict, Code: "legacy.retention_conflict",
				Detail: "既存workspace retention policyとsnapshotが一致しません",
			}
		}
		return false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("retention policyを取得できません: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO feedback.retention_policies
    (workspace_id, evidence_retention_days) VALUES ($1::uuid, $2)`, workspaceID, *days); err != nil {
		return false, fmt.Errorf("retention policyを登録できません: %w", err)
	}
	return true, nil
}

func trackLegacyEntity(ctx context.Context, tx Tx, runID, entityType, key string) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback_migration.legacy_migration_entities
    (run_id, entity_type, entity_key) VALUES ($1::uuid, $2, $3)`, runID, entityType, key)
	if err != nil {
		return fmt.Errorf("legacy migration entityを記録できません: %w", err)
	}
	return nil
}

func (d *Database) ReconcileLegacyMigration(
	ctx context.Context,
	plan legacymigration.ApplyPlan,
) ([]string, error) {
	snapshot := plan.Snapshot
	runID := plan.Report.RunID
	expectedChecksum := plan.Report.SourceChecksum
	run, found, err := d.FindLegacyMigrationRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, &legacymigration.Error{
			Kind: legacymigration.ErrInvalidInput, Code: "legacy.run_not_found", Detail: "migration runがありません",
		}
	}
	if run.SourceChecksum != expectedChecksum {
		return nil, &legacymigration.Error{
			Kind: legacymigration.ErrConflict, Code: "legacy.run_snapshot_mismatch",
			Detail: "migration runとsnapshotが一致しません",
		}
	}
	if run.Status != "applied" {
		return nil, &legacymigration.Error{
			Kind: legacymigration.ErrConflict, Code: "legacy.run_not_applied", Detail: "migration runは適用中ではありません",
		}
	}

	differences := make([]string, 0)
	targets := []struct {
		label, table string
		ids          []string
	}{
		{"session", "feedback.review_sessions", collectLegacyIDs(snapshot.Sessions, func(value legacymigration.SessionSnapshot) string { return value.ID })},
		{"thread", "feedback.feedback_threads", collectLegacyIDs(snapshot.Threads, func(value legacymigration.ThreadSnapshot) string { return value.ID })},
		{"message", "feedback.feedback_messages", collectLegacyIDs(snapshot.Messages, func(value legacymigration.MessageSnapshot) string { return value.ID })},
		{"evidence", "feedback.review_evidence", collectLegacyIDs(snapshot.Evidence, func(value legacymigration.EvidenceSnapshot) string { return value.ID })},
		{"audit", "feedback.audit_logs", collectLegacyIDs(snapshot.Audits, func(value legacymigration.AuditSnapshot) string { return value.ID })},
		{"outbox", "feedback.notification_outbox", collectLegacyIDs(snapshot.Outbox, func(value legacymigration.OutboxSnapshot) string { return value.ID })},
	}
	for _, target := range targets {
		count, countErr := legacyCountIDs(ctx, d, target.table, "id", target.ids)
		if countErr != nil {
			return nil, fmt.Errorf("legacy reconcile countを取得できません: %w", countErr)
		}
		if count != int64(len(target.ids)) {
			differences = append(differences, fmt.Sprintf("%s: expected=%d, actual=%d", target.label, len(target.ids), count))
		}
	}
	if err := reconcileLegacyDescendants(ctx, d, snapshot, &differences); err != nil {
		return nil, err
	}
	for _, value := range snapshot.Sessions {
		var title, status string
		var retention *int
		err := d.QueryRow(ctx, `SELECT title, status, evidence_retention_days
FROM feedback.review_sessions WHERE id = $1::uuid`, value.ID).Scan(&title, &status, &retention)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("legacy sessionを照合できません: %w", err)
		}
		if title != value.Title || status != strings.ToLower(value.Status) || !equalOptionalInt(retention, value.EvidenceRetentionDays) {
			differences = append(differences, "session "+value.ID+": title/status/retentionが一致しません")
		}
	}
	for _, value := range snapshot.Threads {
		var display int
		var status string
		err := d.QueryRow(ctx, `SELECT display_number, status FROM feedback.feedback_threads WHERE id = $1::uuid`,
			value.ID).Scan(&display, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("legacy threadを照合できません: %w", err)
		}
		if display != value.DisplayNumber || status != strings.ToLower(value.Status) {
			differences = append(differences, "thread "+value.ID+": displayNumber/statusが一致しません")
		}
	}
	for _, value := range snapshot.Messages {
		var body string
		var version int
		err := d.QueryRow(ctx, `SELECT body, version FROM feedback.feedback_messages WHERE id = $1::uuid`, value.ID).Scan(&body, &version)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("legacy messageを照合できません: %w", err)
		}
		expectedVersion := 0
		for _, history := range snapshot.MessageVersions {
			if history.MessageID == value.ID && history.Version > expectedVersion {
				expectedVersion = history.Version
			}
		}
		if body != value.Body || version != expectedVersion {
			differences = append(differences, "message "+value.ID+": body/versionが一致しません")
		}
	}
	if err := reconcileLegacyHistory(ctx, d, snapshot, &differences); err != nil {
		return nil, err
	}
	for index, value := range snapshot.Evidence {
		var objectKey, contentType, sha string
		var byteSize int64
		var expires *time.Time
		err := d.QueryRow(ctx, `SELECT object_key, content_type, byte_size, sha256, expires_at
FROM feedback.review_evidence WHERE id = $1::uuid`, value.ID).Scan(&objectKey, &contentType, &byteSize, &sha, &expires)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("legacy evidenceを照合できません: %w", err)
		}
		expectedExpires, parseErr := parseOptionalLegacyTime(value.ExpiresAt)
		if parseErr != nil {
			return nil, parseErr
		}
		expectedKey := plan.Evidence[index].ObjectKey
		if objectKey != expectedKey || contentType != value.ContentType ||
			byteSize != int64(len(lenMustDecodeEvidence(value.DataBase64))) || sha != value.SHA256 || !equalOptionalTime(expires, expectedExpires) {
			differences = append(differences, "evidence "+value.ID+": metadata/SHA-256/expiryが一致しません")
		}
	}
	if err := reconcileLegacyAudits(ctx, d, snapshot, &differences); err != nil {
		return nil, err
	}
	if err := reconcileLegacyOutbox(ctx, d, snapshot, &differences); err != nil {
		return nil, err
	}
	if snapshot.ProjectEvidenceRetentionDays != nil {
		var actual *int
		err := d.QueryRow(ctx, `SELECT evidence_retention_days FROM feedback.retention_policies
WHERE workspace_id = (SELECT workspace_id FROM feedback_migration.legacy_migration_runs WHERE id = $1::uuid)`, runID).Scan(&actual)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !equalOptionalInt(actual, snapshot.ProjectEvidenceRetentionDays) {
			differences = append(differences, "workspace retention policyが一致しません")
		} else if err != nil {
			return nil, fmt.Errorf("legacy retentionを照合できません: %w", err)
		}
	}
	return differences, nil
}

func (d *Database) RollbackLegacyMigration(
	ctx context.Context,
	runID string,
	expectedChecksum string,
) (legacymigration.RollbackResult, error) {
	var result legacymigration.RollbackResult
	callbackCompleted := false
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var checksum, status string
		err := tx.QueryRow(txCtx, `SELECT source_checksum, status
FROM feedback_migration.legacy_migration_runs WHERE id = $1::uuid FOR UPDATE`, runID).Scan(&checksum, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return &legacymigration.Error{
				Kind: legacymigration.ErrInvalidInput, Code: "legacy.run_not_found", Detail: "migration runがありません",
			}
		}
		if err != nil {
			return fmt.Errorf("legacy migration runをlockできません: %w", err)
		}
		if checksum != expectedChecksum {
			return &legacymigration.Error{
				Kind: legacymigration.ErrConflict, Code: "legacy.run_snapshot_mismatch",
				Detail: "migration runとsnapshotが一致しません",
			}
		}
		result.ObjectKeys, err = legacyMigrationEntities(txCtx, tx, runID, "evidence-object")
		if err != nil {
			return err
		}
		if status == "rolled-back" {
			result.AlreadyRolledBack = true
			callbackCompleted = true
			return nil
		}
		if status != "applied" {
			return &legacymigration.Error{
				Kind: legacymigration.ErrConflict, Code: "legacy.run_status_invalid", Detail: "migration run statusが不正です",
			}
		}
		if err := deleteLegacyEntities(txCtx, tx, runID, "audit", "feedback.audit_logs"); err != nil {
			return err
		}
		if err := deleteLegacyEntities(txCtx, tx, runID, "outbox", "feedback.notification_outbox"); err != nil {
			return err
		}
		if err := deleteLegacyEntities(txCtx, tx, runID, "session", "feedback.review_sessions"); err != nil {
			return err
		}
		retentionIDs, err := legacyMigrationEntities(txCtx, tx, runID, "retention-policy")
		if err != nil {
			return err
		}
		for _, workspaceID := range retentionIDs {
			if _, err := tx.Exec(txCtx, `DELETE FROM feedback.retention_policies WHERE workspace_id = $1::uuid`, workspaceID); err != nil {
				return fmt.Errorf("legacy retention policyを削除できません: %w", err)
			}
		}
		if _, err := tx.Exec(txCtx, `UPDATE feedback_migration.legacy_migration_runs
SET status = 'rolled-back', rolled_back_at = now() WHERE id = $1::uuid AND status = 'applied'`, runID); err != nil {
			return fmt.Errorf("legacy migration runをrollback済みにできません: %w", err)
		}
		callbackCompleted = true
		return nil
	})
	if err != nil && callbackCompleted {
		return legacymigration.RollbackResult{}, errors.Join(&legacymigration.Error{
			Kind: legacymigration.ErrCommitUnknown, Code: "legacy.rollback_commit_unknown",
			Detail: "rollback transactionのcommit結果を確認できません",
		}, err)
	}
	return result, err
}

type legacyQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func legacyCountIDs(ctx context.Context, queryer legacyQueryer, table, column string, ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	placeholders := make([]string, len(ids))
	arguments := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index] = fmt.Sprintf("$%d::uuid", index+1)
		arguments[index] = id
	}
	var count int64
	err := queryer.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+column+" IN ("+
		strings.Join(placeholders, ",")+")", arguments...).Scan(&count)
	return count, err
}

func collectLegacyIDs[T any](values []T, id func(T) string) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = id(value)
	}
	return result
}

func collectLegacyScopeIDs(snapshot legacymigration.Snapshot) []string {
	result := make([]string, 0)
	for _, session := range snapshot.Sessions {
		for _, scope := range session.Scopes {
			result = append(result, scope.ID)
		}
	}
	return result
}

func legacyDefault(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func nullableRawJSON(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return string(raw)
}

func equalOptionalInt(left, right *int) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func parseOptionalLegacyTime(value *string) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func equalOptionalTime(left, right *time.Time) bool {
	return left == nil && right == nil || left != nil && right != nil && left.Equal(*right)
}

func reconcileLegacyDescendants(
	ctx context.Context,
	queryer legacyQueryer,
	snapshot legacymigration.Snapshot,
	differences *[]string,
) error {
	sessionIDs := collectLegacyIDs(snapshot.Sessions, func(value legacymigration.SessionSnapshot) string { return value.ID })
	if len(sessionIDs) == 0 {
		return nil
	}
	scopeCount := 0
	perspectiveCount := 0
	for _, session := range snapshot.Sessions {
		scopeCount += len(session.Scopes)
		perspectiveCount += len(session.Perspectives)
	}
	targets := []struct {
		label, from string
		expected    int
	}{
		{"scope", "feedback.review_scopes child WHERE child.session_id", scopeCount},
		{"perspective", "feedback.review_session_perspectives child WHERE child.session_id", perspectiveCount},
		{"thread", "feedback.feedback_threads child WHERE child.session_id", len(snapshot.Threads)},
		{"message", `feedback.feedback_messages child
JOIN feedback.feedback_threads thread ON thread.id = child.thread_id WHERE thread.session_id`, len(snapshot.Messages)},
		{"message history", `feedback.feedback_message_versions child
JOIN feedback.feedback_threads thread ON thread.id = child.thread_id WHERE thread.session_id`, len(snapshot.MessageVersions)},
		{"evidence", `feedback.review_evidence child
JOIN feedback.feedback_threads thread ON thread.id = child.thread_id WHERE thread.session_id`, len(snapshot.Evidence)},
	}
	placeholders := make([]string, len(sessionIDs))
	arguments := make([]any, len(sessionIDs))
	for index, id := range sessionIDs {
		placeholders[index] = fmt.Sprintf("$%d::uuid", index+1)
		arguments[index] = id
	}
	for _, target := range targets {
		var actual int64
		sql := "SELECT count(*) FROM " + target.from + " IN (" + strings.Join(placeholders, ",") + ")"
		if err := queryer.QueryRow(ctx, sql, arguments...).Scan(&actual); err != nil {
			return fmt.Errorf("legacy descendant countを取得できません: %w", err)
		}
		if actual != int64(target.expected) {
			*differences = append(*differences, fmt.Sprintf(
				"%s descendant: expected=%d, actual=%d", target.label, target.expected, actual,
			))
		}
	}
	return nil
}

func reconcileLegacyHistory(
	ctx context.Context,
	queryer legacyQueryer,
	snapshot legacymigration.Snapshot,
	differences *[]string,
) error {
	messages := make(map[string]legacymigration.MessageSnapshot, len(snapshot.Messages))
	for _, value := range snapshot.Messages {
		messages[value.ID] = value
	}
	for _, value := range snapshot.MessageVersions {
		var body, principal string
		var displayName, participantName *string
		var createdAt time.Time
		var editedAt *time.Time
		err := queryer.QueryRow(ctx, `SELECT body, author_principal_id, author_display_name,
       author_participant_name, created_at, edited_at
FROM feedback.feedback_message_versions WHERE message_id = $1::uuid AND version = $2`,
			value.MessageID, value.Version).Scan(&body, &principal, &displayName, &participantName, &createdAt, &editedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("legacy message historyを照合できません: %w", err)
		}
		message := messages[value.MessageID]
		expectedCreated, _ := time.Parse(time.RFC3339Nano, message.CreatedAt)
		expectedEdited, _ := time.Parse(time.RFC3339Nano, value.CreatedAt)
		if body != value.Body || principal != value.EditorPrincipalID ||
			!equalOptionalString(displayName, value.EditorDisplayName) ||
			!equalOptionalString(participantName, value.EditorParticipantName) ||
			!createdAt.Equal(expectedCreated) || editedAt == nil || !editedAt.Equal(expectedEdited) {
			*differences = append(*differences, fmt.Sprintf(
				"message history %s/%dが一致しません", value.MessageID, value.Version,
			))
		}
	}
	return nil
}

func reconcileLegacyAudits(
	ctx context.Context,
	queryer legacyQueryer,
	snapshot legacymigration.Snapshot,
	differences *[]string,
) error {
	for _, value := range snapshot.Audits {
		var action, outcome, requestID string
		var principalID, resourceType, resourceID *string
		var changes []byte
		var occurredAt time.Time
		err := queryer.QueryRow(ctx, `SELECT principal_id, action, resource_type, resource_id,
       outcome, request_id, changes, occurred_at
FROM feedback.audit_logs WHERE id = $1::uuid`, value.ID).Scan(
			&principalID, &action, &resourceType, &resourceID, &outcome, &requestID, &changes, &occurredAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("legacy auditを照合できません: %w", err)
		}
		expectedOutcome, _ := legacymigration.NormalizeAuditOutcome(value.Outcome)
		expectedChanges, _ := legacymigration.SanitizeAuditChanges(value.Changes)
		expectedOccurredAt, _ := time.Parse(time.RFC3339Nano, value.OccurredAt)
		if !equalOptionalString(principalID, value.PrincipalID) || action != value.Action ||
			!equalOptionalString(resourceType, value.ResourceType) || !equalOptionalString(resourceID, value.ResourceID) ||
			outcome != expectedOutcome || requestID != value.RequestID || !occurredAt.Equal(expectedOccurredAt) ||
			!legacyJSONEqual(changes, expectedChanges) {
			*differences = append(*differences, "audit "+value.ID+"が一致しません")
		}
	}
	return nil
}

func reconcileLegacyOutbox(
	ctx context.Context,
	queryer legacyQueryer,
	snapshot legacymigration.Snapshot,
	differences *[]string,
) error {
	for _, value := range snapshot.Outbox {
		var eventType, status, workspaceID string
		var payload []byte
		var availableAt, deliveredAt, createdAt time.Time
		err := queryer.QueryRow(ctx, `SELECT event_type, status, workspace_id::text, payload,
       available_at, delivered_at, created_at
FROM feedback.notification_outbox WHERE id = $1::uuid`, value.ID).Scan(
			&eventType, &status, &workspaceID, &payload, &availableAt, &deliveredAt, &createdAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("legacy outboxを照合できません: %w", err)
		}
		expectedEvent, _ := legacymigration.NormalizeEventType(value.EventType)
		expectedTime, _ := time.Parse(time.RFC3339Nano, value.CreatedAt)
		expectedPayload := map[string]any{
			"eventId": value.ID, "eventType": expectedEvent, "workspaceId": workspaceID,
			"sessionId": value.ReviewSessionID, "threadId": value.ThreadID,
		}
		if value.MessageID != nil {
			expectedPayload["messageId"] = *value.MessageID
		}
		if value.ActorPrincipalID != nil {
			expectedPayload["actorPrincipalId"] = *value.ActorPrincipalID
		}
		raw, _ := json.Marshal(expectedPayload)
		if eventType != expectedEvent || status != "delivered" || !legacyJSONEqual(payload, raw) ||
			!availableAt.Equal(expectedTime) || !deliveredAt.Equal(expectedTime) || !createdAt.Equal(expectedTime) {
			*differences = append(*differences, "outbox "+value.ID+"が一致しません")
		}
	}
	return nil
}

type legacyRowsQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func legacyMigrationEntities(
	ctx context.Context,
	queryer legacyRowsQueryer,
	runID string,
	entityType string,
) ([]string, error) {
	rows, err := queryer.Query(ctx, `SELECT entity_key
FROM feedback_migration.legacy_migration_entities
WHERE run_id = $1::uuid AND entity_type = $2 ORDER BY entity_key`, runID, entityType)
	if err != nil {
		return nil, fmt.Errorf("legacy migration entitiesを取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, fmt.Errorf("legacy migration entityを読み取れません: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("legacy migration entitiesを走査できません: %w", err)
	}
	return result, nil
}

func deleteLegacyEntities(ctx context.Context, tx Tx, runID, entityType, table string) error {
	ids, err := legacyMigrationEntities(ctx, tx, runID, entityType)
	if err != nil || len(ids) == 0 {
		return err
	}
	placeholders := make([]string, len(ids))
	arguments := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index] = fmt.Sprintf("$%d::uuid", index+1)
		arguments[index] = id
	}
	if _, err := tx.Exec(ctx, "DELETE FROM "+table+" WHERE id IN ("+strings.Join(placeholders, ",")+")", arguments...); err != nil {
		return fmt.Errorf("tracked legacy entityを削除できません: %w", err)
	}
	return nil
}

func equalOptionalString(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func legacyJSONEqual(left, right []byte) bool {
	if len(left) == 0 || string(left) == "null" {
		return len(right) == 0 || string(right) == "null"
	}
	if len(right) == 0 || string(right) == "null" {
		return false
	}
	var leftValue, rightValue any
	leftDecoder := json.NewDecoder(strings.NewReader(string(left)))
	rightDecoder := json.NewDecoder(strings.NewReader(string(right)))
	leftDecoder.UseNumber()
	rightDecoder.UseNumber()
	if leftDecoder.Decode(&leftValue) != nil || rightDecoder.Decode(&rightValue) != nil {
		return false
	}
	leftCanonical, _ := json.Marshal(leftValue)
	rightCanonical, _ := json.Marshal(rightValue)
	return string(leftCanonical) == string(rightCanonical)
}

func lenMustDecodeEvidence(value string) []byte {
	data, _ := base64.StdEncoding.Strict().DecodeString(value)
	return data
}

var _ legacymigration.Store = (*Database)(nil)
