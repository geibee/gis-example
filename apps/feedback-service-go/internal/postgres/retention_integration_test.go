package postgres_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestRetentionPolicyAndWorkerWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w4-retention" {
		t.Fatal("retention統合testはFEEDBACK_TEST_RUN_ID=w4-retentionの専用runでのみ実行できます")
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
		tenantKey      = "tenant-w4-retention"
		applicationKey = "go-w4-retention"
		workspaceKey   = "workspace-w4-retention"
		issuer         = "https://issuer-w4-retention.example"
		subject        = "subject-w4-retention"
	)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'retention:%'
AND tenant_id IN (SELECT id FROM feedback.tenants WHERE tenant_key = $1)`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.tenants WHERE tenant_key = $1`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.users WHERE issuer = $1 AND subject = $2`, issuer, subject)
	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "W4 retention test tenant",
		ApplicationKey: applicationKey, ApplicationDisplayName: "W4 retention test application",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "W4 retention test workspace", Issuer: issuer, Subject: subject,
		Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.audit_logs WHERE tenant_id = $1::uuid`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id = $1::uuid`, created.PrincipalID)
	}()

	scope := auth.ResourceScope{
		TenantID: created.TenantID, TenantKey: tenantKey, ApplicationID: created.ApplicationID,
		ApplicationKey: applicationKey, WorkspaceID: created.WorkspaceID,
		ExternalWorkspaceKey: workspaceKey,
	}
	resolved, err := database.ResolveRetentionWorkspaceScope(ctx, created.PrincipalID, applicationKey, workspaceKey)
	if err != nil || resolved.WorkspaceID != created.WorkspaceID || resolved.EnvironmentID != "" {
		t.Fatalf("retention workspace scope=%+v err=%v", resolved, err)
	}
	policy, version, err := database.GetRetentionPolicy(ctx, scope)
	if err != nil || version != 1 || policy.EvidenceRetentionDays != nil || policy.ExportRetentionDays != 7 {
		t.Fatalf("default retention=%+v version=%d err=%v", policy, version, err)
	}
	days := 30
	policy = retention.Policy{EvidenceRetentionDays: &days, ExportRetentionDays: 14}
	if _, version, err = database.PatchRetentionPolicy(ctx, scope, version, policy); err != nil || version != 2 {
		t.Fatalf("patch retention version=%d err=%v", version, err)
	}
	if _, _, err := database.PatchRetentionPolicy(ctx, scope, 1, policy); !errors.Is(err, usecase.ErrVersionMismatch) {
		t.Fatalf("stale retention ETag error=%v", err)
	}

	evidenceRoot, exportRoot := t.TempDir(), t.TempDir()
	evidenceObjects, err := objectstore.NewLocal(evidenceRoot)
	if err != nil {
		t.Fatal(err)
	}
	exportObjects, err := objectstore.NewLocal(exportRoot)
	if err != nil {
		t.Fatal(err)
	}
	const (
		evidenceKey       = "evidence/expired"
		exportKey         = "exports/expired"
		backupKey         = "backups/expired"
		evidenceOrphanKey = "evidence/orphan"
		exportOrphanKey   = "exports/orphan"
		backupOrphanKey   = "backups/orphan"
	)
	for _, item := range []struct {
		store *objectstore.Local
		key   string
	}{
		{evidenceObjects, evidenceKey}, {evidenceObjects, evidenceOrphanKey},
		{exportObjects, exportKey}, {exportObjects, exportOrphanKey},
		{exportObjects, backupKey}, {exportObjects, backupOrphanKey},
	} {
		if err := item.store.Put(ctx, item.key, "application/octet-stream", []byte("payload")); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-3 * time.Hour)
	if err := os.Chtimes(filepath.Join(evidenceRoot, evidenceOrphanKey), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(exportRoot, exportOrphanKey), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(exportRoot, backupOrphanKey), old, old); err != nil {
		t.Fatal(err)
	}

	sessionID, threadID, evidenceID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.review_sessions
    (id, tenant_id, application_id, environment_id, workspace_id, manifest_version, title, created_by)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'v1', 'W4 retention', $6)`,
		sessionID, created.TenantID, created.ApplicationID, created.EnvironmentID, created.WorkspaceID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.feedback_threads
    (id, tenant_id, application_id, environment_id, workspace_id, session_id, display_number,
     location, target, perspective_code, reporter_principal_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
        '{"pageKey":"detail","routeTemplate":"/items/{id}","pathParameters":{"id":"1"}}'::jsonb,
        '{"kind":"feature"}'::jsonb, 'ux', $7)`,
		threadID, created.TenantID, created.ApplicationID, created.EnvironmentID,
		created.WorkspaceID, sessionID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.review_evidence
    (id, thread_id, object_key, content_type, byte_size, sha256, viewport_width,
     viewport_height, pixel_ratio, captured_at, expires_at)
VALUES ($1::uuid, $2::uuid, $3, 'image/png', 7, $4, 100, 100, 1, now() - interval '2 days', now() - interval '1 hour')`,
		evidenceID, threadID, evidenceKey, strings.Repeat("0", 64))
	exportID, backupID := uuid.NewString(), uuid.NewString()
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.export_jobs
    (id, tenant_id, application_id, environment_id, workspace_id, requested_by,
     format, locale, timezone, status, object_key, expires_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
        'csv', 'ja-JP', 'Asia/Tokyo', 'completed', $7, now() - interval '1 hour')`,
		exportID, created.TenantID, created.ApplicationID, created.EnvironmentID,
		created.WorkspaceID, subject, exportKey)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.backup_runs
    (id, tenant_id, application_id, environment_id, workspace_id, kind, scheduled_for,
     status, include_evidence, object_key, expires_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'full', now() - interval '2 hours',
        'completed', false, $6, now() - interval '1 hour')`,
		backupID, created.TenantID, created.ApplicationID, created.EnvironmentID,
		created.WorkspaceID, backupKey)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.idempotency_records
    (tenant_id, principal_id, endpoint, idempotency_key, request_hash, response_status, response_body, expires_at)
VALUES ($1::uuid, $2, '/w4', 'w4-retention-key-0001', $3, 200, '{}'::jsonb, now() - interval '1 minute')`,
		created.TenantID, subject, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.rate_limit_counters
    (tenant_id, principal_id, window_epoch, request_count)
VALUES ($1::uuid, $2, floor(extract(epoch FROM now()) / 60)::bigint - 10, 1)`, created.TenantID, subject)
	mustExecExportBackup(t, ctx, database, `INSERT INTO feedback.write_rate_limit_counters
    (tenant_id, dimension, subject_hash, window_epoch, request_count)
VALUES ($1::uuid, 'principal', $2, floor(extract(epoch FROM now()) / 60)::bigint - 10, 1)`,
		created.TenantID, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

	count, err := database.PurgeExpiredEvidence(ctx, 100, func(context.Context, string) error {
		return errors.New("injected object delete failure")
	})
	if err == nil || count != 1 {
		t.Fatal("object削除失敗を無視しました")
	}
	if got := queryCountRetention(t, ctx, database, `SELECT count(*) FROM feedback.review_evidence WHERE id = $1::uuid`, evidenceID); got != 0 {
		t.Fatalf("論理purge後のevidence count=%d", got)
	}
	if got := queryCountRetention(t, ctx, database, `SELECT count(*) FROM feedback.audit_logs WHERE resource_id = $1`, evidenceID); got != 1 {
		t.Fatalf("論理purge後のaudit count=%d", got)
	}
	if err := os.Chtimes(filepath.Join(evidenceRoot, evidenceKey), old, old); err != nil {
		t.Fatal(err)
	}
	count, err = database.PurgeExpiredExports(ctx, 100, func(context.Context, string) error {
		return errors.New("injected export delete failure")
	})
	if err == nil || count != 1 {
		t.Fatal("export object削除失敗を無視しました")
	}
	if got := queryCountRetention(t, ctx, database,
		`SELECT count(*) FROM feedback.export_jobs WHERE id = $1::uuid AND object_key IS NULL`, exportID); got != 1 {
		t.Fatalf("論理purge後のexport count=%d", got)
	}
	if err := os.Chtimes(filepath.Join(exportRoot, exportKey), old, old); err != nil {
		t.Fatal(err)
	}

	worker, err := retention.NewWorker(database, evidenceObjects, exportObjects, retention.WorkerSettings{
		EvidencePrefix: "evidence/", ExportPrefix: "exports/", BackupPrefix: "backups/",
		OrphanGrace: time.Hour, BatchSize: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.RunOnce(ctx, time.Now())
	if err != nil || !worked {
		t.Fatalf("retention worker worked=%v err=%v", worked, err)
	}
	for _, check := range []struct {
		query string
		args  []any
		want  int
	}{
		{`SELECT count(*) FROM feedback.review_evidence WHERE id = $1::uuid`, []any{evidenceID}, 0},
		{`SELECT count(*) FROM feedback.export_jobs WHERE id = $1::uuid AND object_key IS NULL`, []any{exportID}, 1},
		{`SELECT count(*) FROM feedback.backup_runs WHERE id = $1::uuid AND object_key IS NULL`, []any{backupID}, 1},
		{`SELECT count(*) FROM feedback.idempotency_records WHERE endpoint = '/w4' AND tenant_id = $1::uuid`, []any{created.TenantID}, 0},
		{`SELECT count(*) FROM feedback.audit_logs WHERE resource_id IN ($1, $2, $3)`, []any{evidenceID, exportID, backupID}, 3},
	} {
		if got := queryCountRetention(t, ctx, database, check.query, check.args...); got != check.want {
			t.Fatalf("query %q count=%d want=%d", check.query, got, check.want)
		}
	}
	for _, item := range []struct {
		store *objectstore.Local
		key   string
	}{
		{evidenceObjects, evidenceKey}, {evidenceObjects, evidenceOrphanKey},
		{exportObjects, exportKey}, {exportObjects, exportOrphanKey},
		{exportObjects, backupKey}, {exportObjects, backupOrphanKey},
	} {
		if _, err := item.store.Get(ctx, item.key); !errors.Is(err, objectstore.ErrNotFound) {
			t.Fatalf("object %s remained: %v", item.key, err)
		}
	}
}

type retentionQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func queryCountRetention(
	t *testing.T, ctx context.Context, database retentionQueryer, query string, arguments ...any,
) int {
	t.Helper()
	var count int
	if err := database.QueryRow(ctx, query, arguments...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
