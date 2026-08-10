package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	backupdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type dueBackupPolicy struct {
	WorkspaceID, TenantID, ApplicationID, EnvironmentID string
	Timezone, FullAt, QueuedKind                        string
	IntervalMinutes                                     int
	IncludeEvidence                                     bool
	LastFull, LastAny                                   *time.Time
	FromChange, FromAudit                               int64
}

func (d *Database) ResolveBackupWorkspaceScope(
	ctx context.Context, userID, applicationKey, externalWorkspaceKey string,
) (auth.ResourceScope, error) {
	rows, err := d.Query(ctx, `SELECT tenant.id::text, tenant.tenant_key, application.id::text,
       ''::text, workspace.id::text, application.application_key, ''::text,
       workspace.external_workspace_key
FROM feedback.workspace_memberships membership
JOIN feedback.workspaces workspace ON workspace.id = membership.workspace_id
JOIN feedback.applications application ON application.id = workspace.application_id
JOIN feedback.tenants tenant ON tenant.id = application.tenant_id
WHERE membership.user_id = $1::uuid AND application.application_key = $2
  AND workspace.external_workspace_key = $3`, userID, applicationKey, externalWorkspaceKey)
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("backup workspace scopeを取得できません: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return auth.ResourceScope{}, err
		}
		return auth.ResourceScope{}, notFoundError()
	}
	var scope auth.ResourceScope
	if err := rows.Scan(
		&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.EnvironmentID,
		&scope.WorkspaceID, &scope.ApplicationKey, &scope.EnvironmentKey, &scope.ExternalWorkspaceKey,
	); err != nil {
		return auth.ResourceScope{}, err
	}
	if rows.Next() {
		return auth.ResourceScope{}, &usecase.DomainError{
			Kind: usecase.ErrConflict, Code: "workspace.ambiguous", Detail: "workspace key が複数 tenant で曖昧です",
		}
	}
	return scope, nil
}

func (d *Database) GetBackupPolicyView(
	ctx context.Context, scope auth.ResourceScope, now time.Time,
) (backupdomain.PolicyView, int, error) {
	var view backupdomain.PolicyView
	var version int
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		policy, currentVersion, err := ensureAndReadBackupPolicy(txCtx, tx, scope.WorkspaceID)
		if err != nil {
			return err
		}
		var lastAt *time.Time
		var changeCursor, auditCursor int64
		err = tx.QueryRow(txCtx, `SELECT completed_at, to_change_sequence, to_audit_sequence
FROM feedback.backup_runs WHERE workspace_id = $1::uuid AND status = 'completed'
ORDER BY completed_at DESC LIMIT 1`, scope.WorkspaceID).Scan(&lastAt, &changeCursor, &auditCursor)
		if errors.Is(err, pgx.ErrNoRows) {
			lastAt = nil
			changeCursor, auditCursor = 0, 0
		} else if err != nil {
			return fmt.Errorf("最後のbackupを取得できません: %w", err)
		}
		view, err = backupdomain.PolicyViewAt(policy, lastAt, changeCursor, auditCursor, now)
		version = currentVersion
		return err
	})
	return view, version, err
}

func (d *Database) PatchBackupPolicy(
	ctx context.Context, scope auth.ResourceScope, expectedVersion int, value backupdomain.Policy,
) (backupdomain.Policy, int, error) {
	if err := backupdomain.ValidatePolicy(value); err != nil {
		return backupdomain.Policy{}, 0, err
	}
	var version int
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if _, _, err := ensureAndReadBackupPolicy(txCtx, tx, scope.WorkspaceID); err != nil {
			return err
		}
		err := tx.QueryRow(txCtx, `UPDATE feedback.backup_policies SET
    enabled = $1, timezone = $2, full_backup_at = $3::time,
    incremental_interval_minutes = $4, include_evidence = $5, retention_days = $6,
    version = version + 1, updated_at = now()
WHERE workspace_id = $7::uuid AND version = $8 RETURNING version`,
			value.Enabled, value.Timezone, value.FullBackupAt, value.IncrementalIntervalMinutes,
			value.IncludeEvidence, optionalInt(value.RetentionDays), scope.WorkspaceID, expectedVersion,
		).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return versionMismatchError()
		}
		return err
	})
	return value, version, err
}

func ensureAndReadBackupPolicy(
	ctx context.Context, queryer sessionQueryer, workspaceID string,
) (backupdomain.Policy, int, error) {
	if _, err := queryer.Exec(ctx, `INSERT INTO feedback.backup_policies (workspace_id)
VALUES ($1::uuid) ON CONFLICT DO NOTHING`, workspaceID); err != nil {
		return backupdomain.Policy{}, 0, fmt.Errorf("backup policyを初期化できません: %w", err)
	}
	var result backupdomain.Policy
	var version int
	var fullAt string
	err := queryer.QueryRow(ctx, `SELECT enabled, timezone, full_backup_at::text,
       incremental_interval_minutes, include_evidence, retention_days, version
FROM feedback.backup_policies WHERE workspace_id = $1::uuid`, workspaceID).Scan(
		&result.Enabled, &result.Timezone, &fullAt, &result.IncrementalIntervalMinutes,
		&result.IncludeEvidence, &result.RetentionDays, &version,
	)
	if err != nil {
		return backupdomain.Policy{}, 0, fmt.Errorf("backup policyを取得できません: %w", err)
	}
	result.FullBackupAt = fullAt[:5]
	return result, version, nil
}

func (d *Database) ScheduleDueBackups(ctx context.Context, now time.Time) (int, error) {
	scheduled := 0
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		rows, err := tx.Query(txCtx, `SELECT policy.workspace_id::text, policy.timezone, policy.full_backup_at::text,
       policy.incremental_interval_minutes, policy.include_evidence,
       tenant.id::text, application.id::text, environment.id::text,
       (SELECT max(run.completed_at) FROM feedback.backup_runs run
        WHERE run.workspace_id = policy.workspace_id AND run.kind = 'full' AND run.status = 'completed'),
       (SELECT max(run.completed_at) FROM feedback.backup_runs run
        WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'),
       COALESCE((SELECT run.to_change_sequence FROM feedback.backup_runs run
                 WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'
                 ORDER BY run.completed_at DESC LIMIT 1), 0),
       COALESCE((SELECT run.to_audit_sequence FROM feedback.backup_runs run
                 WHERE run.workspace_id = policy.workspace_id AND run.status = 'completed'
                 ORDER BY run.completed_at DESC LIMIT 1), 0),
       COALESCE((SELECT queued.kind FROM feedback.backup_runs queued
        WHERE queued.workspace_id = policy.workspace_id AND queued.status = 'queued'
        ORDER BY CASE queued.kind WHEN 'full' THEN 0 ELSE 1 END, queued.scheduled_for LIMIT 1), '')
FROM feedback.backup_policies policy
JOIN feedback.workspaces workspace ON workspace.id = policy.workspace_id
JOIN feedback.applications application ON application.id = workspace.application_id
JOIN feedback.tenants tenant ON tenant.id = application.tenant_id
JOIN LATERAL (SELECT candidate.id FROM feedback.application_environments candidate
              WHERE candidate.application_id = application.id ORDER BY candidate.environment_key LIMIT 1) environment ON true
WHERE policy.enabled
  AND NOT EXISTS (SELECT 1 FROM feedback.backup_runs active
                  WHERE active.workspace_id = policy.workspace_id AND active.status IN ('running', 'failed'))
FOR UPDATE OF policy SKIP LOCKED`)
		if err != nil {
			return fmt.Errorf("backup policy scheduling対象を取得できません: %w", err)
		}
		policies := make([]dueBackupPolicy, 0)
		for rows.Next() {
			var value dueBackupPolicy
			if err := rows.Scan(
				&value.WorkspaceID, &value.Timezone, &value.FullAt, &value.IntervalMinutes,
				&value.IncludeEvidence, &value.TenantID, &value.ApplicationID, &value.EnvironmentID,
				&value.LastFull, &value.LastAny, &value.FromChange, &value.FromAudit, &value.QueuedKind,
			); err != nil {
				rows.Close()
				return err
			}
			policies = append(policies, value)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, policy := range policies {
			decision, err := backupdomain.DecideSchedule(backupdomain.ScheduleState{
				Policy: backupdomain.Policy{
					Enabled: true, Timezone: policy.Timezone, FullBackupAt: policy.FullAt[:5],
					IncrementalIntervalMinutes: policy.IntervalMinutes, IncludeEvidence: policy.IncludeEvidence,
				},
				LastFull: policy.LastFull, LastAny: policy.LastAny, FromChangeSequence: policy.FromChange,
				FromAuditSequence: policy.FromAudit, QueuedKind: policy.QueuedKind,
			}, now)
			if err != nil {
				return err
			}
			if decision == nil {
				continue
			}
			tag, err := tx.Exec(txCtx, `INSERT INTO feedback.backup_runs (
    id, tenant_id, application_id, environment_id, workspace_id, kind, scheduled_for,
    from_change_sequence, from_audit_sequence, include_evidence
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10)
ON CONFLICT (workspace_id, kind, scheduled_for) DO NOTHING`,
				uuid.NewString(), policy.TenantID, policy.ApplicationID, policy.EnvironmentID, policy.WorkspaceID,
				decision.Kind, decision.ScheduledFor, decision.FromChangeSequence, decision.FromAuditSequence,
				policy.IncludeEvidence,
			)
			if err != nil {
				return fmt.Errorf("backup runをscheduleできません: %w", err)
			}
			scheduled += int(tag.RowsAffected())
		}
		return nil
	})
	return scheduled, err
}

func (d *Database) ClaimBackup(ctx context.Context) (*backupdomain.Claimed, error) {
	var claimed *backupdomain.Claimed
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var value backupdomain.Claimed
		var scheduledFor time.Time
		var previousAttempts int
		err := tx.QueryRow(txCtx, `SELECT run.id::text, run.tenant_id::text, run.application_id::text,
       run.workspace_id::text, run.kind, run.scheduled_for, run.from_change_sequence,
       run.from_audit_sequence, run.include_evidence, run.attempt_count
FROM feedback.backup_runs run
JOIN feedback.backup_policies policy ON policy.workspace_id = run.workspace_id
WHERE ((run.status = 'queued' AND run.available_at <= now())
       OR (run.status = 'running' AND run.claimed_at < now() - interval '10 minutes'))
  AND NOT EXISTS (SELECT 1 FROM feedback.backup_runs active
                  WHERE active.workspace_id = run.workspace_id AND active.status = 'running' AND active.id <> run.id)
ORDER BY CASE run.kind WHEN 'full' THEN 0 ELSE 1 END, run.scheduled_for
FOR UPDATE OF run, policy SKIP LOCKED LIMIT 1`).Scan(
			&value.ID, &value.TenantID, &value.ApplicationID, &value.WorkspaceID, &value.Kind,
			&scheduledFor, &value.FromChangeSequence, &value.FromAuditSequence,
			&value.IncludeEvidence, &previousAttempts,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("backup runをclaimできません: %w", err)
		}
		value.ScheduledFor = javaInstant(scheduledFor)
		value.ClaimToken = uuid.NewString()
		value.Attempt = previousAttempts + 1
		tag, err := tx.Exec(txCtx, `UPDATE feedback.backup_runs SET status = 'running', claim_token = $1::uuid,
    claimed_at = now(), attempt_count = $2, error = NULL WHERE id = $3::uuid`,
			value.ClaimToken, value.Attempt, value.ID,
		)
		if err != nil {
			return fmt.Errorf("backup claimを更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("backup claimの更新件数が不正です")
		}
		if err := recordBackupAudit(txCtx, tx, value, "backup.run.started", "succeeded", map[string]any{
			"attempt": value.Attempt, "kind": value.Kind,
			"fromChangeSequence": value.FromChangeSequence, "fromAuditSequence": value.FromAuditSequence,
		}); err != nil {
			return err
		}
		claimed = &value
		return nil
	})
	return claimed, err
}

func (d *Database) PrepareBackup(ctx context.Context, claimed backupdomain.Claimed) (backupdomain.PreparedArchive, error) {
	var prepared backupdomain.PreparedArchive
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if _, err := tx.Exec(txCtx, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`); err != nil {
			return fmt.Errorf("backup snapshot isolationを設定できません: %w", err)
		}
		var metadata struct {
			TenantKey, ApplicationKey, EnvironmentKeys, WorkspaceKey, HistoryStarted string
			RetentionDays                                                            *int
		}
		var historyStarted time.Time
		err := tx.QueryRow(txCtx, `SELECT tenant.tenant_key, application.application_key,
       COALESCE(string_agg(DISTINCT environment.environment_key, ',' ORDER BY environment.environment_key), ''),
       workspace.external_workspace_key, policy.retention_days,
       (SELECT recorded_at FROM feedback.system_metadata WHERE key = 'backup_history_coverage_started_at')
FROM feedback.backup_runs run
JOIN feedback.tenants tenant ON tenant.id = run.tenant_id
JOIN feedback.applications application ON application.id = run.application_id
JOIN feedback.workspaces workspace ON workspace.id = run.workspace_id
LEFT JOIN feedback.feedback_threads thread ON thread.workspace_id = run.workspace_id
LEFT JOIN feedback.application_environments environment ON environment.id = thread.environment_id
LEFT JOIN feedback.backup_policies policy ON policy.workspace_id = run.workspace_id
WHERE run.id = $1::uuid
GROUP BY tenant.tenant_key, application.application_key, workspace.external_workspace_key, policy.retention_days`,
			claimed.ID,
		).Scan(&metadata.TenantKey, &metadata.ApplicationKey, &metadata.EnvironmentKeys,
			&metadata.WorkspaceKey, &metadata.RetentionDays, &historyStarted)
		if err != nil {
			return fmt.Errorf("backup metadataを取得できません: %w", err)
		}
		if metadata.EnvironmentKeys == "" {
			metadata.EnvironmentKeys = "*"
		}
		metadata.HistoryStarted = javaInstant(historyStarted)
		toChange, err := maximumBackupSequence(txCtx, tx, "feedback_change_journal", claimed.WorkspaceID)
		if err != nil {
			return err
		}
		toAudit, err := maximumBackupSequence(txCtx, tx, "audit_logs", claimed.WorkspaceID)
		if err != nil {
			return err
		}
		full := claimed.Kind == backupdomain.KindFull
		csvEntries := make([]backupdomain.CSVEntry, 0, 6)
		for _, query := range backupCSVQueries(claimed, toChange, toAudit, full) {
			rows, err := queryBackupRows(txCtx, tx, query.SQL, query.Arguments...)
			if err != nil {
				return fmt.Errorf("%sをbackup用に取得できません: %w", query.Path, err)
			}
			csvEntries = append(csvEntries, backupdomain.CSVEntry{Path: query.Path, Header: query.Header, Rows: rows})
		}
		evidenceCSV, evidenceEntries, err := prepareBackupEvidence(txCtx, tx, claimed, toChange, full)
		if err != nil {
			return err
		}
		csvEntries = append(csvEntries, evidenceCSV)
		prepared = backupdomain.PreparedArchive{
			RunID: claimed.ID, Kind: claimed.Kind, ScheduledFor: claimed.ScheduledFor,
			TenantKey: metadata.TenantKey, ApplicationKey: metadata.ApplicationKey,
			EnvironmentKey: metadata.EnvironmentKeys, ExternalWorkspaceKey: metadata.WorkspaceKey,
			FromChangeSequence: claimed.FromChangeSequence, ToChangeSequence: toChange,
			FromAuditSequence: claimed.FromAuditSequence, ToAuditSequence: toAudit,
			HistoryCoverageStartedAt: metadata.HistoryStarted, IncludeEvidence: claimed.IncludeEvidence,
			CSVEntries: csvEntries, EvidenceEntries: evidenceEntries, RetentionDays: metadata.RetentionDays,
		}
		return nil
	})
	return prepared, err
}

type backupCSVQuery struct {
	Path      string
	Header    []string
	SQL       string
	Arguments []any
}

const changedThreadsCTE = `WITH changed_threads AS (
    SELECT DISTINCT CASE WHEN resource_type = 'thread' THEN resource_id::uuid
                         ELSE NULLIF(payload->>'threadId', '')::uuid END AS thread_id
    FROM feedback.feedback_change_journal
    WHERE workspace_id = $1::uuid AND sequence > $2 AND sequence <= $3
)`

const changedMessagesCTE = `WITH changed_messages AS (
    SELECT DISTINCT resource_id::uuid AS message_id
    FROM feedback.feedback_change_journal
    WHERE workspace_id = $1::uuid AND sequence > $2 AND sequence <= $3
      AND resource_type = 'message'
      AND event_type IN ('feedback.message.created.v1', 'feedback.message.updated.v1')
)`

const changedMessageVersionsCTE = `WITH changed_message_events AS (
    SELECT resource_id::uuid AS message_id, event_type,
           NULLIF(payload->>'fromVersion', '')::integer AS from_version
    FROM feedback.feedback_change_journal
    WHERE workspace_id = $1::uuid AND sequence > $2 AND sequence <= $3
      AND resource_type = 'message'
      AND event_type IN ('feedback.message.created.v1', 'feedback.message.updated.v1')
), changed_messages AS (SELECT DISTINCT message_id FROM changed_message_events)`

const changedEvidenceThreadsCTE = `WITH changed_evidence_threads AS (
    SELECT DISTINCT resource_id::uuid AS thread_id
    FROM feedback.feedback_change_journal
    WHERE workspace_id = $1::uuid AND sequence > $2 AND sequence <= $3
      AND resource_type = 'thread' AND event_type = 'feedback.thread.created.v1'
      AND COALESCE((payload->>'evidenceIncluded')::boolean, false)
)`

func backupCSVQueries(claimed backupdomain.Claimed, toChange, toAudit int64, full bool) []backupCSVQuery {
	threadPrefix, threadFilter := "", ""
	messagePrefix, messageFilter := "", ""
	threadArguments := []any{claimed.WorkspaceID}
	messageArguments := []any{claimed.WorkspaceID}
	if !full {
		threadPrefix = changedThreadsCTE + " "
		threadFilter = "AND thread.id IN (SELECT thread_id FROM changed_threads WHERE thread_id IS NOT NULL)"
		threadArguments = []any{claimed.WorkspaceID, claimed.FromChangeSequence, toChange, claimed.WorkspaceID}
		messagePrefix = changedMessagesCTE + " "
		messageFilter = "AND message.id IN (SELECT message_id FROM changed_messages)"
		messageArguments = []any{claimed.WorkspaceID, claimed.FromChangeSequence, toChange, claimed.WorkspaceID}
	}
	queries := []backupCSVQuery{
		{
			Path:   "threads.csv",
			Header: []string{"thread_id", "session_id", "environment_key", "display_number", "status", "perspective_code", "location_json", "target_json", "reporter_principal_id", "reporter_display_name", "reporter_participant_name", "version", "created_at", "updated_at"},
			SQL: threadPrefix + `SELECT thread.id::text, thread.session_id::text, environment.environment_key,
thread.display_number::text, thread.status, thread.perspective_code, thread.location::text, thread.target::text,
thread.reporter_principal_id, thread.reporter_display_name, thread.reporter_participant_name,
thread.version::text, thread.created_at::text, thread.updated_at::text
FROM feedback.feedback_threads thread
JOIN feedback.application_environments environment ON environment.id = thread.environment_id
WHERE thread.workspace_id = $` + fmt.Sprint(len(threadArguments)) + `::uuid ` + threadFilter + ` ORDER BY thread.created_at, thread.id`,
			Arguments: threadArguments,
		},
		{
			Path:   "messages.csv",
			Header: []string{"message_id", "thread_id", "author_principal_id", "author_display_name", "author_participant_name", "body", "version", "created_at", "edited_at"},
			SQL: messagePrefix + `SELECT message.id::text, message.thread_id::text, message.author_principal_id,
message.author_display_name, message.author_participant_name, message.body, message.version::text,
message.created_at::text, message.edited_at::text
FROM feedback.feedback_messages message JOIN feedback.feedback_threads thread ON thread.id = message.thread_id
WHERE thread.workspace_id = $` + fmt.Sprint(len(messageArguments)) + `::uuid ` + messageFilter + ` ORDER BY message.created_at, message.id`,
			Arguments: messageArguments,
		},
	}
	if full {
		queries = append(queries, backupCSVQuery{
			Path:   "message_versions.csv",
			Header: []string{"message_id", "thread_id", "version", "current", "author_principal_id", "author_display_name", "author_participant_name", "body", "created_at", "edited_at"},
			SQL: `SELECT version.message_id::text, version.thread_id::text, version.version::text, 'false',
version.author_principal_id, version.author_display_name, version.author_participant_name, version.body,
version.created_at::text, version.edited_at::text FROM feedback.feedback_message_versions version
JOIN feedback.feedback_threads thread ON thread.id = version.thread_id WHERE thread.workspace_id = $1::uuid
UNION ALL SELECT message.id::text, message.thread_id::text, message.version::text, 'true',
message.author_principal_id, message.author_display_name, message.author_participant_name, message.body,
message.created_at::text, message.edited_at::text FROM feedback.feedback_messages message
JOIN feedback.feedback_threads thread ON thread.id = message.thread_id WHERE thread.workspace_id = $2::uuid
ORDER BY 2, 1, 3`, Arguments: []any{claimed.WorkspaceID, claimed.WorkspaceID},
		})
	} else {
		queries = append(queries, backupCSVQuery{
			Path:   "message_versions.csv",
			Header: []string{"message_id", "thread_id", "version", "current", "author_principal_id", "author_display_name", "author_participant_name", "body", "created_at", "edited_at"},
			SQL: changedMessageVersionsCTE + ` SELECT version.message_id::text, version.thread_id::text,
version.version::text, 'false', version.author_principal_id, version.author_display_name,
version.author_participant_name, version.body, version.created_at::text, version.edited_at::text
FROM feedback.feedback_message_versions version JOIN changed_message_events event
  ON event.message_id = version.message_id AND event.event_type = 'feedback.message.updated.v1'
 AND event.from_version = version.version
UNION ALL SELECT message.id::text, message.thread_id::text, message.version::text, 'true',
message.author_principal_id, message.author_display_name, message.author_participant_name,
message.body, message.created_at::text, message.edited_at::text
FROM feedback.feedback_messages message JOIN changed_messages changed ON changed.message_id = message.id
ORDER BY 2, 1, 3`, Arguments: []any{claimed.WorkspaceID, claimed.FromChangeSequence, toChange},
		})
	}
	fromChange := claimed.FromChangeSequence
	if full {
		fromChange = 0
	}
	queries = append(queries,
		backupCSVQuery{
			Path: "status_events.csv", Header: []string{"sequence", "thread_id", "event_type", "status", "occurred_at", "source"},
			SQL: `SELECT journal.sequence::text, journal.resource_id, journal.event_type,
CASE journal.event_type WHEN 'feedback.thread.resolved.v1' THEN 'resolved'
WHEN 'feedback.thread.reopened.v1' THEN 'open' ELSE 'open' END,
journal.occurred_at::text, 'journal' FROM feedback.feedback_change_journal journal
WHERE journal.workspace_id = $1::uuid AND journal.sequence > $2 AND journal.sequence <= $3
AND journal.event_type IN ('feedback.thread.created.v1', 'feedback.thread.resolved.v1', 'feedback.thread.reopened.v1')
ORDER BY journal.occurred_at, journal.sequence`, Arguments: []any{claimed.WorkspaceID, fromChange, toChange},
		},
		backupCSVQuery{
			Path: "audit_logs.csv", Header: []string{"sequence", "audit_id", "principal_id", "action", "resource_type", "resource_id", "outcome", "request_id", "changes_json", "occurred_at"},
			SQL: `SELECT sequence::text, id::text, principal_id, action, resource_type, resource_id,
outcome, request_id, changes::text, occurred_at::text FROM feedback.audit_logs
WHERE workspace_id = $1::uuid AND sequence > $2 AND sequence <= $3 ORDER BY sequence`,
			Arguments: []any{claimed.WorkspaceID, claimed.FromAuditSequence, toAudit},
		},
	)
	return queries
}

func prepareBackupEvidence(
	ctx context.Context, queryer sessionQueryer, claimed backupdomain.Claimed, upper int64, full bool,
) (backupdomain.CSVEntry, []backupdomain.EvidenceEntry, error) {
	prefix, filter := "", ""
	arguments := []any{claimed.WorkspaceID}
	workspacePosition := 1
	if !full {
		prefix = changedEvidenceThreadsCTE + " "
		filter = "AND thread.id IN (SELECT thread_id FROM changed_evidence_threads)"
		arguments = []any{claimed.WorkspaceID, claimed.FromChangeSequence, upper, claimed.WorkspaceID}
		workspacePosition = 4
	}
	query := prefix + `SELECT evidence.id::text, evidence.thread_id::text, evidence.object_key,
evidence.content_type, evidence.byte_size::text, evidence.sha256, evidence.viewport_width::text,
evidence.viewport_height::text, evidence.pixel_ratio::text, evidence.captured_at::text,
evidence.created_at::text FROM feedback.review_evidence evidence
JOIN feedback.feedback_threads thread ON thread.id = evidence.thread_id
WHERE thread.workspace_id = $` + fmt.Sprint(workspacePosition) + `::uuid ` + filter + ` ORDER BY evidence.created_at, evidence.id`
	rows, err := queryBackupRows(ctx, queryer, query, arguments...)
	if err != nil {
		return backupdomain.CSVEntry{}, nil, fmt.Errorf("evidence.csvをbackup用に取得できません: %w", err)
	}
	archiveRows := make([][]*string, 0, len(rows))
	entries := make([]backupdomain.EvidenceEntry, 0, len(rows))
	for _, row := range rows {
		extension := "png"
		if row[3] != nil && *row[3] == "image/webp" {
			extension = "webp"
		}
		archivePath := "evidence/" + stringValue(row[1]) + "." + extension
		archiveRows = append(archiveRows, append(row, stringPointer(archivePath)))
		entries = append(entries, backupdomain.EvidenceEntry{
			ArchivePath: archivePath, ObjectKey: stringValue(row[2]), ContentType: stringValue(row[3]),
			ExpectedSHA256: stringValue(row[5]),
		})
	}
	return backupdomain.CSVEntry{
		Path:   "evidence.csv",
		Header: []string{"evidence_id", "thread_id", "object_key", "content_type", "byte_size", "sha256", "viewport_width", "viewport_height", "pixel_ratio", "captured_at", "created_at", "archive_path"},
		Rows:   archiveRows,
	}, entries, nil
}

func maximumBackupSequence(ctx context.Context, queryer sessionQueryer, table, workspaceID string) (int64, error) {
	if table != "feedback_change_journal" && table != "audit_logs" {
		return 0, errors.New("backup sequence tableがallowlistにありません")
	}
	var result int64
	query := `SELECT COALESCE(max(sequence), 0) FROM feedback.` + table + ` WHERE workspace_id = $1::uuid`
	if err := queryer.QueryRow(ctx, query, workspaceID).Scan(&result); err != nil {
		return 0, fmt.Errorf("backup sequenceを取得できません: %w", err)
	}
	return result, nil
}

func queryBackupRows(ctx context.Context, queryer sessionQueryer, query string, arguments ...any) ([][]*string, error) {
	rows, err := queryer.Query(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([][]*string, 0)
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make([]*string, len(values))
		for index, value := range values {
			if value == nil {
				continue
			}
			text := ""
			switch typed := value.(type) {
			case string:
				text = typed
			case []byte:
				text = string(typed)
			default:
				text = fmt.Sprint(typed)
			}
			row[index] = &text
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (d *Database) CompleteBackup(
	ctx context.Context,
	claimed backupdomain.Claimed,
	prepared backupdomain.PreparedArchive,
	objectKey string,
	archive backupdomain.ArchiveResult,
) error {
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		counts, err := json.Marshal(archive.EntryCounts)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(txCtx, `UPDATE feedback.backup_runs SET status = 'completed', object_key = $1,
    archive_sha256 = $2, archive_bytes = $3, entry_counts = $4::jsonb,
    to_change_sequence = $5, to_audit_sequence = $6,
    history_coverage_started_at = $7::timestamptz,
    expires_at = CASE WHEN $8::integer IS NULL THEN NULL ELSE now() + ($9::integer * interval '1 day') END,
    completed_at = now(), claim_token = NULL, error = NULL
WHERE id = $10::uuid AND status = 'running' AND claim_token = $11::uuid`,
			objectKey, archive.SHA256, archive.ByteSize, string(counts), prepared.ToChangeSequence,
			prepared.ToAuditSequence, prepared.HistoryCoverageStartedAt, optionalInt(prepared.RetentionDays),
			optionalInt(prepared.RetentionDays), claimed.ID, claimed.ClaimToken,
		)
		if err != nil {
			return fmt.Errorf("backup完了状態を更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("backup runの完了状態を更新できません")
		}
		if claimed.Kind == backupdomain.KindFull {
			if _, err := tx.Exec(txCtx, `UPDATE feedback.backup_runs
SET status = 'superseded', error = 'completed full backup superseded this run'
WHERE workspace_id = $1::uuid AND kind = 'incremental' AND status = 'queued' AND scheduled_for <= now()`,
				claimed.WorkspaceID,
			); err != nil {
				return fmt.Errorf("incremental backupをsupersedeできません: %w", err)
			}
		}
		return recordBackupAudit(txCtx, tx, claimed, "backup.run.completed", "succeeded", map[string]any{
			"objectKey": objectKey, "archiveSha256": archive.SHA256, "archiveBytes": archive.ByteSize,
			"toChangeSequence": prepared.ToChangeSequence, "toAuditSequence": prepared.ToAuditSequence,
			"entryCounts": archive.EntryCounts,
		})
	})
}

func (d *Database) FailBackup(
	ctx context.Context, claimed backupdomain.Claimed, message string, maxAttempts int,
) error {
	message = truncateUTF16(message, 2000)
	terminal := claimed.Attempt >= maxAttempts
	delaySeconds := 1 << min(claimed.Attempt, 10)
	if delaySeconds > 3600 {
		delaySeconds = 3600
	}
	status := backupdomain.StatusQueued
	if terminal {
		status = backupdomain.StatusFailed
	}
	return d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if _, err := tx.Exec(txCtx, `UPDATE feedback.backup_runs SET status = $1,
    available_at = now() + ($2 * interval '1 second'), claim_token = NULL, error = $3
WHERE id = $4::uuid AND claim_token = $5::uuid`,
			status, delaySeconds, message, claimed.ID, claimed.ClaimToken,
		); err != nil {
			return fmt.Errorf("backup失敗状態を更新できません: %w", err)
		}
		return recordBackupAudit(txCtx, tx, claimed, "backup.run.failed", "failed", map[string]any{
			"attempt": claimed.Attempt, "terminal": terminal, "error": message,
		})
	})
}

const backupRunColumns = `id::text, kind, status, scheduled_for, from_change_sequence,
to_change_sequence, from_audit_sequence, to_audit_sequence, archive_sha256, archive_bytes,
entry_counts, history_coverage_started_at, expires_at, completed_at, created_at, error`

func (d *Database) ListBackups(
	ctx context.Context, scope auth.ResourceScope, limit, offset int,
) (backupdomain.Page, error) {
	rows, err := d.Query(ctx, `SELECT `+backupRunColumns+`
FROM feedback.backup_runs WHERE workspace_id = $1::uuid
ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, scope.WorkspaceID, limit+1, offset)
	if err != nil {
		return backupdomain.Page{}, fmt.Errorf("backup一覧を取得できません: %w", err)
	}
	defer rows.Close()
	items := make([]backupdomain.Run, 0, limit+1)
	for rows.Next() {
		value, err := scanBackupRun(rows)
		if err != nil {
			return backupdomain.Page{}, err
		}
		items = append(items, value)
	}
	if err := rows.Err(); err != nil {
		return backupdomain.Page{}, err
	}
	page := backupdomain.Page{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		next := backupdomainCursor(offset + limit)
		page.NextCursor = &next
	}
	return page, nil
}

func (d *Database) GetBackup(ctx context.Context, id string) (backupdomain.Run, error) {
	result, err := scanBackupRun(d.QueryRow(ctx, `SELECT `+backupRunColumns+`
FROM feedback.backup_runs WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return backupdomain.Run{}, notFoundError()
	}
	if err != nil {
		return backupdomain.Run{}, fmt.Errorf("backup runを取得できません: %w", err)
	}
	return result, nil
}

func (d *Database) GetStoredBackup(ctx context.Context, id string) (backupdomain.StoredMetadata, error) {
	var result backupdomain.StoredMetadata
	err := d.QueryRow(ctx, `SELECT object_key, archive_sha256, archive_bytes FROM feedback.backup_runs
WHERE id = $1::uuid AND status = 'completed' AND object_key IS NOT NULL
  AND archive_sha256 IS NOT NULL AND archive_bytes IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())`, id).Scan(
		&result.ObjectKey, &result.ArchiveSHA256, &result.ArchiveBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return backupdomain.StoredMetadata{}, &usecase.DomainError{
			Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "backup file がないか期限切れです",
		}
	}
	if err != nil {
		return backupdomain.StoredMetadata{}, fmt.Errorf("stored backupを取得できません: %w", err)
	}
	return result, nil
}

func (d *Database) RetryBackup(
	ctx context.Context, scope auth.ResourceScope, id string,
) (backupdomain.Run, error) {
	var result backupdomain.Run
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		tag, err := tx.Exec(txCtx, `UPDATE feedback.backup_runs SET status = 'queued', attempt_count = 0,
    available_at = now(), error = NULL
WHERE id = $1::uuid AND workspace_id = $2::uuid AND status = 'failed'`, id, scope.WorkspaceID)
		if err != nil {
			return fmt.Errorf("backupを再試行状態にできません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			var visible bool
			if err := tx.QueryRow(txCtx, `SELECT EXISTS (
    SELECT 1 FROM feedback.backup_runs WHERE id = $1::uuid AND workspace_id = $2::uuid
)`, id, scope.WorkspaceID).Scan(&visible); err != nil {
				return err
			}
			if !visible {
				return notFoundError()
			}
			return &usecase.DomainError{
				Kind: usecase.ErrConflict, Code: "backup.not_failed", Detail: "failed backupだけを再試行できます",
			}
		}
		result, err = scanBackupRun(tx.QueryRow(txCtx, `SELECT `+backupRunColumns+`
FROM feedback.backup_runs WHERE id = $1::uuid`, id))
		return err
	})
	return result, err
}

func scanBackupRun(scanner sessionScanner) (backupdomain.Run, error) {
	var result backupdomain.Run
	var scheduledFor, historyStarted, createdAt time.Time
	var expiresAt, completedAt *time.Time
	var counts []byte
	err := scanner.Scan(
		&result.ID, &result.Kind, &result.Status, &scheduledFor,
		&result.FromChangeSequence, &result.ToChangeSequence, &result.FromAuditSequence, &result.ToAuditSequence,
		&result.ArchiveSHA256, &result.ArchiveBytes, &counts, &historyStarted,
		&expiresAt, &completedAt, &createdAt, &result.Error,
	)
	if err != nil {
		return backupdomain.Run{}, err
	}
	result.ScheduledFor = javaInstant(scheduledFor)
	result.HistoryCoverageStartedAt = javaInstant(historyStarted)
	result.CreatedAt = javaInstant(createdAt)
	result.ExpiresAt = instantPointer(expiresAt)
	result.CompletedAt = instantPointer(completedAt)
	if len(counts) != 0 {
		if err := json.Unmarshal(counts, &result.EntryCounts); err != nil {
			return backupdomain.Run{}, fmt.Errorf("backup entry countsを読み取れません: %w", err)
		}
	}
	if result.Status == backupdomain.StatusCompleted && (expiresAt == nil || expiresAt.After(time.Now())) {
		download := "/feedback/v1/backups/" + result.ID + "/download"
		result.DownloadURL = &download
	}
	return result, nil
}

func recordBackupAudit(
	ctx context.Context,
	tx Tx,
	claimed backupdomain.Claimed,
	action, outcome string,
	changes map[string]any,
) error {
	data, err := json.Marshal(sanitizeBackupAuditElement(changes, ""))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback.audit_logs (
    id, tenant_id, application_id, workspace_id, principal_id, action,
    resource_type, resource_id, outcome, request_id, changes
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, $5, 'backup', $6, $7, $8, $9::jsonb)`,
		uuid.NewString(), claimed.TenantID, claimed.ApplicationID, claimed.WorkspaceID,
		action, claimed.ID, outcome,
		fmt.Sprintf("backup-worker:%s:%d:%s", claimed.ID, claimed.Attempt, action), string(data),
	)
	if err != nil {
		return fmt.Errorf("backup worker auditを記録できません: %w", err)
	}
	return nil
}

var backupAuditSensitiveKey = regexp.MustCompile(
	`(?i)(password|passwd|token|secret|authorization|cookie|body|dataBase64|evidence|webhookEndpoint|privateKey)`,
)

func sanitizeBackupAuditElement(value any, key string) any {
	if key != "" && backupAuditSensitiveKey.MatchString(key) {
		return "[REDACTED]"
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for childKey, child := range typed {
			result[childKey] = sanitizeBackupAuditElement(child, childKey)
		}
		return result
	case map[string]int64:
		result := make(map[string]any, len(typed))
		for childKey, child := range typed {
			result[childKey] = sanitizeBackupAuditElement(child, childKey)
		}
		return result
	case []any:
		limit := min(len(typed), 50)
		result := make([]any, 0, limit+1)
		for index := range limit {
			result = append(result, sanitizeBackupAuditElement(typed[index], ""))
		}
		if len(typed) > limit {
			result = append(result, fmt.Sprintf("[TRUNCATED:%d]", len(typed)))
		}
		return result
	case string:
		length := len(utf16.Encode([]rune(typed)))
		if length > 1000 {
			hash := sha256.Sum256([]byte(typed))
			return fmt.Sprintf("[SUMMARY:length=%d,sha256=%s]", length, hex.EncodeToString(hash[:]))
		}
	}
	return value
}

func truncateUTF16(value string, maximum int) string {
	units := 0
	for index, character := range value {
		width := 1
		if character > 0xffff {
			width = 2
		}
		if units+width > maximum {
			return value[:index]
		}
		units += width
	}
	return value
}

func optionalInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func stringPointer(value string) *string { return &value }

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func backupdomainCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("offset:%d", offset)))
}
