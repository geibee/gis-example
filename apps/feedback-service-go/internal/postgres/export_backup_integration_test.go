package postgres_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	backupdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestExportAndBackupWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w3-export-backup" {
		t.Fatal("export/backup統合testはFEEDBACK_TEST_RUN_ID=w3-export-backupの専用runでのみ実行できます")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL:      databaseURL,
		User:     requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER"),
		Password: requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD"),
		PoolSize: 4, ConnectionTimeout: 5 * time.Second, StatementTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	const (
		tenantKey      = "tenant-w3-export-backup"
		applicationKey = "go-w3-export-backup"
		workspaceKey   = "workspace-w3-export-backup"
		issuer         = "https://issuer-w3-export-backup.example"
		subject        = "subject-w3-export-backup"
	)
	// 前回の中断片だけを専用識別子で除去する。guardなしでは到達しない。
	_, _ = database.Exec(ctx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'backup-worker:%' AND resource_id IN (
    SELECT id::text FROM feedback.backup_runs WHERE tenant_id IN (SELECT id FROM feedback.tenants WHERE tenant_key = $1)
)`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.tenants WHERE tenant_key = $1`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.users WHERE issuer = $1 AND subject = $2`, issuer, subject)

	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "W3 export/backup test tenant",
		ApplicationKey: applicationKey, ApplicationDisplayName: "W3 export/backup test application",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "W3 export/backup test workspace", Issuer: issuer, Subject: subject,
		Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'backup-worker:%' AND resource_id IN (
    SELECT id::text FROM feedback.backup_runs WHERE tenant_id = $1::uuid
)`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id = $1::uuid`, created.PrincipalID)
	}()

	manifest := `{"routes":[{"pageKey":"detail","template":"/items/{id}","parameters":{"id":{"persistence":"store"}}}]}`
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.application_manifests
    (id, application_id, manifest_version, manifest, created_by)
VALUES ($1::uuid, $2::uuid, 'v1', $3::jsonb, $4)`, uuid.NewString(), created.ApplicationID, manifest, subject)
	sessionID, threadID, messageID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.review_sessions
    (id, tenant_id, application_id, environment_id, workspace_id, manifest_version, title, created_by)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'v1', 'W3 export/backup', $6)`,
		sessionID, created.TenantID, created.ApplicationID, created.EnvironmentID, created.WorkspaceID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.feedback_threads
    (id, tenant_id, application_id, environment_id, workspace_id, session_id, display_number,
     location, target, perspective_code, reporter_principal_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
        '{"pageKey":"detail","routeTemplate":"/items/{id}","pathParameters":{"id":"item 1"}}'::jsonb,
        '{"kind":"feature"}'::jsonb, 'ux', $7)`, threadID, created.TenantID, created.ApplicationID,
		created.EnvironmentID, created.WorkspaceID, sessionID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.feedback_messages
    (id, thread_id, author_principal_id, body) VALUES ($1::uuid, $2::uuid, $3, '=formula')`,
		messageID, threadID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.feedback_change_journal
    (tenant_id, application_id, environment_id, workspace_id, event_type, resource_type, resource_id, payload)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'feedback.thread.created.v1', 'thread', $5,
        '{"evidenceIncluded":false}'::jsonb)`, created.TenantID, created.ApplicationID,
		created.EnvironmentID, created.WorkspaceID, threadID)

	scope := auth.ResourceScope{
		TenantID: created.TenantID, ApplicationID: created.ApplicationID, EnvironmentID: created.EnvironmentID,
		WorkspaceID: created.WorkspaceID, TenantKey: tenantKey, ApplicationKey: applicationKey,
		EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
	}
	principal := auth.Principal{UserID: created.PrincipalID, Issuer: issuer, Subject: subject}
	exportCommand := exportdomain.CreateCommand{
		Request: exportdomain.Request{
			ApplicationKey: applicationKey, EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
			SessionID: &sessionID, Format: exportdomain.FormatCSV, Locale: "ja-JP", Timezone: "Asia/Tokyo",
		},
		IdempotencyKey: "w3-export-backup-key-0001", RequestHash: strings.Repeat("a", 64),
	}
	job, err := database.CreateExport(ctx, scope, principal, exportCommand)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := database.CreateExport(ctx, scope, principal, exportCommand)
	if err != nil || replayed.ID != job.ID {
		t.Fatalf("idempotency replay=%+v err=%v", replayed, err)
	}
	mismatch := exportCommand
	mismatch.RequestHash = strings.Repeat("b", 64)
	if _, err := database.CreateExport(ctx, scope, principal, mismatch); !errors.Is(err, usecase.ErrConflict) {
		t.Fatalf("idempotency mismatch error=%v", err)
	}
	preparedExport, err := database.PrepareExport(ctx, exportdomain.Claimed{ID: job.ID, WorkspaceID: created.WorkspaceID})
	if err != nil || len(preparedExport.Rows) != 1 || preparedExport.Rows[0].LatestMessage != "=formula" ||
		preparedExport.Rows[0].DeepLink != "https://app.example/items/item%201?feedbackThread="+threadID {
		t.Fatalf("prepared export=%+v err=%v", preparedExport, err)
	}

	resolved, err := database.ResolveBackupWorkspaceScope(ctx, created.PrincipalID, applicationKey, workspaceKey)
	if err != nil || resolved.WorkspaceID != created.WorkspaceID || resolved.EnvironmentID != "" {
		t.Fatalf("backup workspace scope=%+v err=%v", resolved, err)
	}
	policy, version, err := database.GetBackupPolicyView(ctx, resolved, time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC))
	if err != nil || version != 1 || policy.Policy != backupdomain.DefaultPolicy() {
		t.Fatalf("default policy=%+v version=%d err=%v", policy, version, err)
	}
	enabled := backupdomain.DefaultPolicy()
	enabled.Enabled = true
	retention := 30
	enabled.RetentionDays = &retention
	if _, version, err = database.PatchBackupPolicy(ctx, resolved, version, enabled); err != nil || version != 2 {
		t.Fatalf("patch policy version=%d err=%v", version, err)
	}

	runID, claimToken := uuid.NewString(), uuid.NewString()
	scheduled := time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.backup_runs
    (id, tenant_id, application_id, environment_id, workspace_id, kind, scheduled_for, status,
     from_change_sequence, from_audit_sequence, include_evidence, attempt_count, claim_token, claimed_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'full', $6, 'running', 0, 0, true, 1, $7::uuid, now())`,
		runID, created.TenantID, created.ApplicationID, created.EnvironmentID, created.WorkspaceID, scheduled, claimToken)
	claimed := backupdomain.Claimed{
		ID: runID, TenantID: created.TenantID, ApplicationID: created.ApplicationID,
		WorkspaceID: created.WorkspaceID, Kind: backupdomain.KindFull, ScheduledFor: scheduled.Format(time.RFC3339),
		IncludeEvidence: true, ClaimToken: claimToken, Attempt: 1,
	}
	preparedBackup, err := database.PrepareBackup(ctx, claimed)
	if err != nil || len(preparedBackup.CSVEntries) != 6 || preparedBackup.ToChangeSequence == 0 {
		t.Fatalf("prepared backup entries=%d cursor=%d err=%v", len(preparedBackup.CSVEntries), preparedBackup.ToChangeSequence, err)
	}
	archivePath := t.TempDir() + "/backup.zip"
	localObjects, err := objectstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	archive, err := backupdomain.WriteArchive(ctx, preparedBackup, localObjects, archivePath, func() time.Time {
		return time.Date(2026, 8, 9, 1, 3, 0, 0, time.UTC)
	})
	if err != nil || !backupdomain.VerifyArchive(archivePath) {
		t.Fatalf("archive=%+v err=%v", archive, err)
	}
	if err := database.CompleteBackup(ctx, claimed, preparedBackup, "w3-export-backup/run.zip", archive); err != nil {
		t.Fatal(err)
	}
	completed, err := database.GetBackup(ctx, runID)
	if err != nil || completed.Status != backupdomain.StatusCompleted || completed.ToChangeSequence == nil ||
		completed.ToAuditSequence == nil || completed.ArchiveSHA256 == nil || *completed.ArchiveSHA256 != archive.SHA256 {
		t.Fatalf("completed backup=%+v err=%v", completed, err)
	}

	// fullの確定cursorから次のincrementalが隙間なく開始し、新しい変更だけを含むことを固定する。
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.feedback_change_journal
    (tenant_id, application_id, environment_id, workspace_id, event_type, resource_type, resource_id, payload)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'feedback.message.created.v1', 'message', $5,
        jsonb_build_object('threadId', $6::text))`, created.TenantID, created.ApplicationID,
		created.EnvironmentID, created.WorkspaceID, messageID, threadID)
	incrementalID, incrementalClaimToken := uuid.NewString(), uuid.NewString()
	incrementalScheduled := scheduled.Add(time.Hour)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.backup_runs
    (id, tenant_id, application_id, environment_id, workspace_id, kind, scheduled_for, status,
     from_change_sequence, from_audit_sequence, include_evidence, attempt_count, claim_token, claimed_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'incremental', $6, 'running',
        $7, $8, true, 1, $9::uuid, now())`, incrementalID, created.TenantID, created.ApplicationID,
		created.EnvironmentID, created.WorkspaceID, incrementalScheduled, *completed.ToChangeSequence,
		*completed.ToAuditSequence, incrementalClaimToken)
	incrementalClaimed := backupdomain.Claimed{
		ID: incrementalID, TenantID: created.TenantID, ApplicationID: created.ApplicationID,
		WorkspaceID: created.WorkspaceID, Kind: backupdomain.KindIncremental,
		ScheduledFor:       incrementalScheduled.Format(time.RFC3339),
		FromChangeSequence: *completed.ToChangeSequence, FromAuditSequence: *completed.ToAuditSequence,
		IncludeEvidence: true, ClaimToken: incrementalClaimToken, Attempt: 1,
	}
	preparedIncremental, err := database.PrepareBackup(ctx, incrementalClaimed)
	if err != nil || preparedIncremental.FromChangeSequence != *completed.ToChangeSequence ||
		preparedIncremental.FromAuditSequence != *completed.ToAuditSequence ||
		preparedIncremental.ToChangeSequence <= preparedIncremental.FromChangeSequence ||
		preparedIncremental.ToAuditSequence < preparedIncremental.FromAuditSequence {
		t.Fatalf("prepared incremental=%+v err=%v", preparedIncremental, err)
	}
	incrementalPath := t.TempDir() + "/incremental.zip"
	incrementalArchive, err := backupdomain.WriteArchive(ctx, preparedIncremental, localObjects, incrementalPath, func() time.Time {
		return time.Date(2026, 8, 9, 2, 3, 0, 0, time.UTC)
	})
	if err != nil || !backupdomain.VerifyArchive(incrementalPath) {
		t.Fatalf("incremental archive=%+v err=%v", incrementalArchive, err)
	}
	if err := database.CompleteBackup(
		ctx, incrementalClaimed, preparedIncremental, "w3-export-backup/incremental.zip", incrementalArchive,
	); err != nil {
		t.Fatal(err)
	}
	incremental, err := database.GetBackup(ctx, incrementalID)
	if err != nil || incremental.Status != backupdomain.StatusCompleted ||
		incremental.FromChangeSequence != *completed.ToChangeSequence ||
		incremental.FromAuditSequence != *completed.ToAuditSequence || incremental.ToChangeSequence == nil ||
		*incremental.ToChangeSequence < incremental.FromChangeSequence || incremental.ToAuditSequence == nil ||
		*incremental.ToAuditSequence < incremental.FromAuditSequence {
		t.Fatalf("completed incremental=%+v err=%v", incremental, err)
	}
}

type exportBackupExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func mustExecExportBackup(
	t *testing.T, ctx context.Context, executor exportBackupExecutor, sql string, arguments ...any,
) {
	t.Helper()
	if _, err := executor.Exec(ctx, sql, arguments...); err != nil {
		t.Fatal(err)
	}
}
