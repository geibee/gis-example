package postgres_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/legacymigration"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/migrations/legacyjournal"
)

func TestMembershipAndLegacyMigrationWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w3-admin-legacy" {
		t.Fatal("W3 admin/legacy統合testはFEEDBACK_TEST_RUN_ID=w3-admin-legacyの専用DBでのみ実行できます")
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
	var databaseName string
	if err := database.QueryRow(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(databaseName, "w3_admin_legacy") && !strings.Contains(databaseName, "w3-admin-legacy") {
		t.Fatalf("専用DB名にw3_admin_legacyを含めてください（検出: %s）", databaseName)
	}
	if _, err := database.Exec(ctx, `DROP SCHEMA IF EXISTS feedback_migration CASCADE`); err != nil {
		t.Fatal(err)
	}
	journal, err := legacyjournal.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(ctx, `CREATE SCHEMA feedback_migration`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(ctx, `CREATE TABLE feedback_migration.legacy_migration_runs (id uuid PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.PrepareLegacyMigrationSchema(ctx, journal); err == nil {
		t.Fatal("部分適用されたlegacy journal schemaを受理しました")
	}
	if _, err := database.Exec(ctx, `DROP SCHEMA feedback_migration CASCADE`); err != nil {
		t.Fatal(err)
	}
	initialized, err := database.PrepareLegacyMigrationSchema(ctx, journal)
	if err != nil || !initialized {
		t.Fatalf("PrepareLegacyMigrationSchema() initialized=%t error=%v", initialized, err)
	}
	initialized, err = database.PrepareLegacyMigrationSchema(ctx, journal)
	if err != nil || initialized {
		t.Fatalf("PrepareLegacyMigrationSchema() retry initialized=%t error=%v", initialized, err)
	}
	wrongChecksum := journal
	wrongChecksum.Checksum++
	if _, err := database.PrepareLegacyMigrationSchema(ctx, wrongChecksum); err == nil {
		t.Fatal("checksumが異なるlegacy journal migrationを受理しました")
	}
	if err := database.ValidateLegacyMigrationSchema(ctx); err != nil {
		t.Fatal(err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	ids := struct {
		tenant, application, environment, workspace, manifest, owner, member, session, run string
	}{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	applicationKey := "w3-admin-" + suffix
	workspaceKey := "workspace-" + suffix
	issuer := "https://issuer-w3-admin.example"
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback_migration.legacy_migration_runs WHERE id = $1::uuid`, ids.run)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, ids.tenant)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id IN ($1::uuid, $2::uuid)`, ids.owner, ids.member)
	}()

	mustExecW3(t, ctx, database, `INSERT INTO feedback.tenants (id, tenant_key, display_name)
VALUES ($1::uuid, $2, 'W3 admin')`, ids.tenant, "tenant-w3-admin-"+suffix)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.applications (id, tenant_id, application_key, display_name)
VALUES ($1::uuid, $2::uuid, $3, 'W3 admin')`, ids.application, ids.tenant, applicationKey)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.application_environments
    (id, application_id, environment_key, base_url, allowed_issuers)
VALUES ($1::uuid, $2::uuid, 'test', 'https://app.example', ARRAY[$3])`, ids.environment, ids.application, issuer)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.workspaces
    (id, tenant_id, application_id, external_workspace_key, display_name)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'W3 admin')`, ids.workspace, ids.tenant, ids.application, workspaceKey)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.application_manifests
    (id, application_id, manifest_version, manifest, created_by)
VALUES ($1::uuid, $2::uuid, 'v1', '{"routes":[]}'::jsonb, 'w3-admin')`, ids.manifest, ids.application)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.users (id, issuer, subject)
VALUES ($1::uuid, $2, $3), ($4::uuid, $2, $5)`, ids.owner, issuer, "owner-"+suffix, ids.member, "member-"+suffix)
	mustExecW3(t, ctx, database, `INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions)
VALUES ($1::uuid, $2::uuid, ARRAY['feedback.admin'])`, ids.workspace, ids.owner)

	scope, err := database.ResolveAdminWorkspaceScope(ctx, ids.owner, applicationKey, workspaceKey)
	if err != nil || scope.WorkspaceID != ids.workspace || scope.EnvironmentID != "" {
		t.Fatalf("ResolveAdminWorkspaceScope()=%+v error=%v", scope, err)
	}
	principal := auth.Principal{UserID: ids.owner, Issuer: issuer, Subject: "owner-" + suffix}
	created, err := database.CreateWorkspaceMember(ctx, scope, principal, admin.CreateCommand{
		Request: admin.MembershipCreate{Issuer: issuer, Subject: "member-" + suffix,
			Permissions: []auth.Permission{auth.PermissionRead}},
		IdempotencyKey: "w3-admin-member-" + suffix, RequestHash: strings.Repeat("a", 64),
	})
	if err != nil || created.After.UserID != ids.member || created.After.Version != 1 {
		t.Fatalf("CreateWorkspaceMember()=%+v error=%v", created, err)
	}
	patched, err := database.PatchWorkspaceMember(ctx, scope, ids.member, 1,
		admin.MembershipPatch{Permissions: []auth.Permission{auth.PermissionComment, auth.PermissionRead}})
	if err != nil || patched.Before == nil || patched.After.Version != 2 {
		t.Fatalf("PatchWorkspaceMember()=%+v error=%v", patched, err)
	}
	deleted, err := database.DeleteWorkspaceMember(ctx, scope, ids.member, 2)
	if err != nil || deleted.Version != 2 {
		t.Fatalf("DeleteWorkspaceMember()=%+v error=%v", deleted, err)
	}

	retention := 30
	snapshot := legacymigration.Snapshot{
		SchemaVersion: "1", SourceSystem: "w3-source-" + suffix, ApplicationKey: applicationKey,
		EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey, ManifestVersion: "v1",
		ProjectEvidenceRetentionDays: &retention,
		Sessions: []legacymigration.SessionSnapshot{{
			ID: ids.session, Title: "Legacy session", Status: "closed",
			CreatedAt: "2026-01-02T03:04:05Z", UpdatedAt: "2026-01-02T03:04:05Z",
			Scopes: []legacymigration.ScopeSnapshot{}, Perspectives: []legacymigration.PerspectiveSnapshot{},
		}},
		Threads: []legacymigration.ThreadSnapshot{}, Messages: []legacymigration.MessageSnapshot{},
		MessageVersions: []legacymigration.MessageVersionSnapshot{}, Evidence: []legacymigration.EvidenceSnapshot{},
		Audits: []legacymigration.AuditSnapshot{}, Outbox: []legacymigration.OutboxSnapshot{},
	}
	legacyScope, err := database.ResolveLegacyMigrationScope(ctx, snapshot)
	if err != nil || legacyScope.WorkspaceID != ids.workspace {
		t.Fatalf("ResolveLegacyMigrationScope()=%+v error=%v", legacyScope, err)
	}
	plan := legacymigration.ApplyPlan{Snapshot: snapshot, Scope: legacyScope, Report: legacymigration.Report{
		RunID: ids.run, SourceChecksum: strings.Repeat("b", 64), Sessions: 1, Differences: []string{},
	}}
	if err := database.CheckLegacyMigrationCollisions(ctx, legacymigration.CollisionInput{
		Snapshot: snapshot, RunID: ids.run, SourceChecksum: plan.Report.SourceChecksum, Scope: legacyScope,
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ApplyLegacyMigration(ctx, plan); err != nil {
		t.Fatal(err)
	}
	differences, err := database.ReconcileLegacyMigration(ctx, plan)
	if err != nil || len(differences) != 0 {
		t.Fatalf("ReconcileLegacyMigration() differences=%v error=%v", differences, err)
	}
	rollback, err := database.RollbackLegacyMigration(ctx, ids.run, plan.Report.SourceChecksum)
	if err != nil || len(rollback.ObjectKeys) != 0 {
		t.Fatalf("RollbackLegacyMigration()=%+v error=%v", rollback, err)
	}
	run, found, err := database.FindLegacyMigrationRun(ctx, ids.run)
	if err != nil || !found || run.Status != "rolled-back" {
		t.Fatalf("FindLegacyMigrationRun()=%+v found=%t error=%v", run, found, err)
	}
}

func mustExecW3(t *testing.T, ctx context.Context, database *postgres.Database, sql string, arguments ...any) {
	t.Helper()
	if _, err := database.Exec(ctx, sql, arguments...); err != nil {
		t.Fatal(err)
	}
}
