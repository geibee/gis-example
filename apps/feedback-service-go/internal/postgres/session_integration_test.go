package postgres_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	sessiondomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestSessionCRUDWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w2-session" {
		t.Fatal("session統合testはFEEDBACK_TEST_RUN_ID=w2-sessionの専用DBでのみ実行できます")
	}
	user := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER")
	password := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL: databaseURL, User: user, Password: password, PoolSize: 4,
		ConnectionTimeout: 5 * time.Second, StatementTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	const (
		tenantKey      = "tenant-w2-session"
		applicationKey = "go-w2-session"
		workspaceKey   = "workspace-w2-session"
		issuer         = "https://issuer-w2-session.example"
		subject        = "subject-w2-session"
	)
	// 前回の中断片だけを専用識別子で除去する。guardなしでは到達しない。
	_, _ = database.Exec(ctx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'request-w2-session-%'`)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.tenants WHERE tenant_key = $1`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.users WHERE issuer = $1 AND subject = $2`, issuer, subject)

	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "W2 session test tenant",
		ApplicationKey: applicationKey, ApplicationDisplayName: "W2 session test application",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "W2 session test workspace", Issuer: issuer, Subject: subject,
		Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'request-w2-session-%'`)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id = $1::uuid`, created.PrincipalID)
	}()

	_, err = database.Exec(ctx, `INSERT INTO feedback.application_manifests (
    id, application_id, manifest_version, manifest, version, created_by
) VALUES ($1::uuid, $2::uuid, 'v1', '{}'::jsonb, 1, $3)`, uuid.NewString(), created.ApplicationID, subject)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := database.ResolvePrincipal(ctx, auth.Identity{Issuer: issuer, Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := auth.NewAuthorizer(database, database)
	if err != nil {
		t.Fatal(err)
	}
	service, err := sessiondomain.NewService(database, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	request := sessiondomain.CreateRequest{
		ApplicationKey: applicationKey, EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
		ManifestVersion: "v1", Title: "  W2 session  ", OutOfScopePosting: sessiondomain.OutOfScopeWarn,
		Scopes: []sessiondomain.Scope{
			{PageKey: "detail", Reviewable: false},
			{PageKey: "home", Reviewable: true},
		},
		Perspectives: []sessiondomain.Perspective{
			{Code: "ux", Label: "UX", Status: sessiondomain.PerspectiveActive},
		},
	}
	command := sessiondomain.CreateCommand{
		Request: request, IdempotencyKey: "w2-session-key-0001", RequestHash: strings.Repeat("a", 64),
	}

	var results [2]sessiondomain.MutationResult
	var failures [2]error
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], failures[index] = service.Create(
				ctx, principal, "request-w2-session-create", command,
			)
		}(index)
	}
	wait.Wait()
	for _, failure := range failures {
		if failure != nil {
			t.Fatal(failure)
		}
	}
	if results[0].Session.ID != results[1].Session.ID || results[0].Session.Title != "W2 session" {
		t.Fatalf("idempotent results = %+v / %+v", results[0], results[1])
	}
	sessionID := results[0].Session.ID
	mismatch := command
	mismatch.RequestHash = strings.Repeat("c", 64)
	_, err = service.Create(ctx, principal, "request-w2-session-mismatch", mismatch)
	var mismatchError *usecase.DomainError
	if !errors.Is(err, usecase.ErrConflict) || !errors.As(err, &mismatchError) || mismatchError.Code != "idempotency.mismatch" {
		t.Fatalf("idempotency mismatch error = %v", err)
	}
	missingManifest := command
	missingManifest.IdempotencyKey = "w2-session-key-0003"
	missingManifest.RequestHash = strings.Repeat("d", 64)
	missingManifest.Request.ManifestVersion = "missing"
	_, err = service.Create(ctx, principal, "request-w2-session-invalid", missingManifest)
	var validationError *sessiondomain.ValidationError
	if !errors.As(err, &validationError) || validationError.Code != "request.invalid" {
		t.Fatalf("missing manifest error = %v", err)
	}
	var invalidIdempotencyCount int
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.idempotency_records
WHERE tenant_id = $1::uuid AND principal_id = $2 AND endpoint = 'POST /sessions'
  AND idempotency_key = 'w2-session-key-0003'`, created.TenantID, subject).Scan(&invalidIdempotencyCount); err != nil {
		t.Fatal(err)
	}
	if invalidIdempotencyCount != 0 {
		t.Fatalf("失敗createのidempotency recordが残りました: %d", invalidIdempotencyCount)
	}

	page, err := service.List(ctx, principal, sessiondomain.ListInput{
		ApplicationKey: applicationKey, EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
		Status: integrationStringPointer(sessiondomain.StatusDraft), Limit: integrationIntPointer(1),
		RequestID: "request-w2-session-list",
	})
	if err != nil || page.TotalCount != 1 || len(page.Items) != 1 || page.NextCursor != nil {
		t.Fatalf("List() = %+v, %v", page, err)
	}
	read, err := service.Get(ctx, principal, sessionID, "request-w2-session-get")
	if err != nil || read.Version != 1 || len(read.Scopes) != 2 || read.Scopes[0].PageKey != "detail" {
		t.Fatalf("Get() = %+v, %v", read, err)
	}

	open := sessiondomain.StatusOpen
	replacementScopes := []sessiondomain.Scope{{PageKey: "summary", Reviewable: true}}
	replacementPerspectives := []sessiondomain.Perspective{{Code: "USABILITY", Label: "操作性", Status: sessiondomain.PerspectiveActive}}
	patched, err := service.Patch(ctx, principal, sessionID, "request-w2-session-patch", func() (sessiondomain.Patch, error) {
		return sessiondomain.Patch{ExpectedVersion: 1, Status: &open, Scopes: &replacementScopes, Perspectives: &replacementPerspectives}, nil
	})
	if err != nil || patched.Session.Version != 2 || patched.Session.Status != sessiondomain.StatusOpen ||
		len(patched.Session.Scopes) != 1 || patched.Session.Scopes[0].PageKey != "summary" ||
		len(patched.Session.Perspectives) != 1 || patched.Session.Perspectives[0].Code != "USABILITY" {
		t.Fatalf("Patch() = %+v, %v", patched, err)
	}
	_, err = service.Patch(ctx, principal, sessionID, "request-w2-session-stale", func() (sessiondomain.Patch, error) {
		return sessiondomain.Patch{ExpectedVersion: 1, Title: integrationStringPointer("stale")}, nil
	})
	if !errors.Is(err, usecase.ErrVersionMismatch) {
		t.Fatalf("stale Patch() error = %v", err)
	}

	secondCommand := command
	secondCommand.IdempotencyKey = "w2-session-key-0002"
	secondCommand.RequestHash = strings.Repeat("b", 64)
	second, err := service.Create(ctx, principal, "request-w2-session-create-2", secondCommand)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Patch(ctx, principal, second.Session.ID, "request-w2-session-conflict", func() (sessiondomain.Patch, error) {
		return sessiondomain.Patch{ExpectedVersion: 1, Status: &open}, nil
	})
	var domainError *usecase.DomainError
	if !errors.Is(err, usecase.ErrConflict) || !errors.As(err, &domainError) || domainError.Code != "session.open_conflict" {
		t.Fatalf("open conflict error = %v", err)
	}

	var journalCount int
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.feedback_change_journal
WHERE workspace_id = $1::uuid AND resource_type = 'session'`, created.WorkspaceID).Scan(&journalCount); err != nil {
		t.Fatal(err)
	}
	if journalCount != 0 {
		t.Fatalf("session CRUDがchange journalを生成しました: %d", journalCount)
	}
}

func integrationStringPointer(value string) *string { return &value }
func integrationIntPointer(value int) *int          { return &value }
