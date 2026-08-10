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
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
)

func TestEvidenceMetadataAndQuotaWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w2-evidence" {
		t.Fatal("evidence統合testはFEEDBACK_TEST_RUN_ID=w2-evidenceの専用DBでのみ実行できます")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL:      databaseURL,
		User:     requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER"),
		Password: requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD"),
		PoolSize: 4, ConnectionTimeout: 5 * time.Second, StatementTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	ids := struct {
		tenant, application, environment, workspace, user, session, thread string
	}{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	requestID := "request-w2-evidence-" + suffix
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.audit_logs WHERE request_id = $1`, requestID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, ids.tenant)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id = $1::uuid`, ids.user)
	}()
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.tenants (id, tenant_key, display_name)
VALUES ($1::uuid, $2, 'W2 evidence')`, ids.tenant, "tenant-w2-evidence-"+suffix)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.applications (id, tenant_id, application_key, display_name)
VALUES ($1::uuid, $2::uuid, $3, 'W2 evidence')`, ids.application, ids.tenant, "app-w2-evidence-"+suffix)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.application_environments
    (id, application_id, environment_key, base_url, allowed_issuers)
VALUES ($1::uuid, $2::uuid, 'test', 'https://app.example', ARRAY['https://issuer.example'])`, ids.environment, ids.application)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.workspaces
    (id, tenant_id, application_id, external_workspace_key, display_name)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'W2 evidence')`, ids.workspace, ids.tenant, ids.application, "workspace-"+suffix)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.users (id, issuer, subject)
VALUES ($1::uuid, 'https://issuer.example', $2)`, ids.user, "subject-"+suffix)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions)
VALUES ($1::uuid, $2::uuid, ARRAY['feedback.read'])`, ids.workspace, ids.user)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.review_sessions
    (id, tenant_id, application_id, environment_id, workspace_id, manifest_version, title, created_by)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'v1', 'W2 evidence', 'subject')`,
		ids.session, ids.tenant, ids.application, ids.environment, ids.workspace)
	mustExecEvidence(t, ctx, database, `INSERT INTO feedback.feedback_threads
    (id, tenant_id, application_id, environment_id, workspace_id, session_id, display_number,
     location, target, perspective_code, reporter_principal_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
        '{}'::jsonb, '{}'::jsonb, 'ux', 'subject')`,
		ids.thread, ids.tenant, ids.application, ids.environment, ids.workspace, ids.session)

	scope, err := database.ResolveEvidenceScope(ctx, ids.user, ids.thread)
	if err != nil || scope.TenantID != ids.tenant || scope.WorkspaceID != ids.workspace {
		t.Fatalf("ResolveEvidenceScope()=%+v error=%v", scope, err)
	}
	attachment := evidence.Attachment{
		ObjectKey:   "evidence/" + ids.tenant + "/" + ids.workspace + "/" + ids.thread,
		ContentType: "image/png", ByteSize: 15, SHA256: strings.Repeat("a", 64),
		ViewportWidth: 1280, ViewportHeight: 720, PixelRatio: 2, CapturedAt: time.Now().UTC(),
	}
	err = database.InTransaction(ctx, func(txCtx context.Context, tx postgres.Tx) error {
		if err := database.EnforceEvidenceQuota(txCtx, tx, ids.workspace, 1); err != nil {
			return err
		}
		return database.InsertEvidenceMetadata(txCtx, tx, ids.thread, attachment)
	})
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := database.GetEvidenceMetadata(ctx, ids.thread)
	if err != nil || metadata.ObjectKey != attachment.ObjectKey || metadata.ByteSize != attachment.ByteSize {
		t.Fatalf("GetEvidenceMetadata()=%+v error=%v", metadata, err)
	}
	err = database.InTransaction(ctx, func(txCtx context.Context, tx postgres.Tx) error {
		return database.EnforceEvidenceQuota(txCtx, tx, ids.workspace, 1)
	})
	if !errors.Is(err, evidence.ErrQuotaExceeded) {
		t.Fatalf("quota error=%v", err)
	}
	principal := auth.Principal{UserID: ids.user, Issuer: "https://issuer.example", Subject: "subject-" + suffix}
	if err := database.RecordEvidenceAuthorization(ctx, scope, principal, requestID); err != nil {
		t.Fatal(err)
	}
	if err := database.RecordEvidenceRead(ctx, scope, principal, ids.thread, requestID); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteEvidenceMetadata(ctx, attachment.ObjectKey); err != nil {
		t.Fatal(err)
	}
	exists, err := database.EvidenceObjectExists(ctx, attachment.ObjectKey)
	if err != nil || exists {
		t.Fatalf("EvidenceObjectExists()=%v error=%v", exists, err)
	}
}

type evidenceExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func mustExecEvidence(t *testing.T, ctx context.Context, executor evidenceExecutor, sql string, arguments ...any) {
	t.Helper()
	if _, err := executor.Exec(ctx, sql, arguments...); err != nil {
		t.Fatal(err)
	}
}
