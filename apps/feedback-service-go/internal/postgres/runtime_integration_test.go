package postgres_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestRuntimeFoundationAgainstPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	runID := os.Getenv("FEEDBACK_TEST_RUN_ID")
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,20}$`).MatchString(runID) {
		t.Fatal("FEEDBACK_TEST_RUN_IDは21文字以下の小文字英数字・hyphenで指定してください")
	}
	user := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER")
	password := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL: databaseURL, User: user, Password: password, PoolSize: 3,
		ConnectionTimeout: 5 * time.Second, StatementTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	applicationKey := "go-" + runID
	tenantKey := "tenant-" + runID
	workspaceKey := "workspace-" + runID
	issuer := "https://issuer-" + runID + ".example"
	subject := "subject-" + runID
	requestID := "request-" + runID
	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "Go統合テナント",
		ApplicationKey: applicationKey, ApplicationDisplayName: "Go統合アプリ",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "Go統合workspace", Issuer: issuer, Subject: subject,
		Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, "DELETE FROM feedback.audit_logs WHERE request_id = $1", requestID)
		_, _ = database.Exec(cleanupCtx, "DELETE FROM feedback.tenants WHERE id = $1::uuid", created.TenantID)
		_, _ = database.Exec(cleanupCtx, "DELETE FROM feedback.users WHERE id = $1::uuid", created.PrincipalID)
	}()

	principal, err := database.ResolvePrincipal(ctx, auth.Identity{Issuer: issuer, Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := auth.NewAuthorizer(database, database)
	if err != nil {
		t.Fatal(err)
	}
	service, err := usecase.NewService(database, authorizer, 1_048_576, 100)
	if err != nil {
		t.Fatal(err)
	}
	manifest := json.RawMessage(fmt.Sprintf(`{
      "schemaVersion":"1","applicationKey":%q,"displayName":"統合アプリ","manifestVersion":"v1",
      "routes":[{"pageKey":"home","template":"/","label":"ホーム"}]
    }`, applicationKey))
	record, err := service.PutManifest(ctx, principal, applicationKey, requestID, func() (json.RawMessage, string, *int, error) {
		return manifest, "v1", nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.Version != 1 {
		t.Fatalf("manifest version = %d", record.Version)
	}
	read, err := service.GetManifest(ctx, principal, applicationKey, requestID)
	if err != nil || read.Version != 1 {
		t.Fatalf("GetManifest() record=%+v err=%v", read, err)
	}
	contextValue, err := service.ReviewContext(ctx, principal, usecase.ReviewContextInput{
		ApplicationKey: applicationKey, EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
		PageKey: "home", RouteTemplate: "/", RequestID: requestID,
	}, func(json.RawMessage) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if contextValue.Session != nil || contextValue.Scope != "excluded" || contextValue.Posting != "deny" {
		t.Fatalf("review context = %+v", contextValue)
	}
	allowed, err := database.IsOriginAllowed(ctx, "https://app.example")
	if err != nil || !allowed {
		t.Fatalf("IsOriginAllowed() allowed=%v err=%v", allowed, err)
	}
	metrics, err := database.CollectOperationalMetrics(ctx)
	if err != nil || len(metrics) < 6 {
		t.Fatalf("CollectOperationalMetrics() count=%d err=%v", len(metrics), err)
	}
}

func requiredIntegrationEnvironment(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%sが必要です", name)
	}
	return value
}
