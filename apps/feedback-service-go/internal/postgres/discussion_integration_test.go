package postgres_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
)

func TestDiscussionConcurrencyWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w2-discussion" {
		t.Fatal("discussion統合testはFEEDBACK_TEST_RUN_ID=w2-discussionの専用DBでのみ実行できます")
	}
	user := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER")
	password := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL: databaseURL, User: user, Password: password, PoolSize: 16,
		ConnectionTimeout: 5 * time.Second, StatementTimeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	const (
		tenantKey      = "tenant-w2-discussion"
		applicationKey = "go-w2-discussion"
		workspaceKey   = "workspace-w2-discussion"
		issuer         = "https://issuer-w2-discussion.example"
		subject        = "subject-w2-discussion"
	)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'request-w2-discussion-%'`)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.tenants WHERE tenant_key = $1`, tenantKey)
	_, _ = database.Exec(ctx, `DELETE FROM feedback.users WHERE issuer = $1 AND subject = $2`, issuer, subject)
	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "W2 discussion test tenant",
		ApplicationKey: applicationKey, ApplicationDisplayName: "W2 discussion test application",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example/root",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "W2 discussion test workspace", Issuer: issuer, Subject: subject,
		Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE 'request-w2-discussion-%'`)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, created.TenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.users WHERE id = $1::uuid`, created.PrincipalID)
	}()

	manifest := fmt.Sprintf(`{
  "schemaVersion":"1","applicationKey":%q,"displayName":"Discussion","manifestVersion":"v1",
  "routes":[{"pageKey":"home","template":"/","label":"Home","queryParameters":{"tab":{"persistence":"store"}}}]
}`, applicationKey)
	_, err = database.Exec(ctx, `INSERT INTO feedback.application_manifests (
    id, application_id, manifest_version, manifest, version, created_by
) VALUES ($1::uuid, $2::uuid, 'v1', $3::jsonb, 1, $4)`, uuid.NewString(), created.ApplicationID, manifest, subject)
	if err != nil {
		t.Fatal(err)
	}
	sessionID := uuid.NewString()
	_, err = database.Exec(ctx, `INSERT INTO feedback.review_sessions (
    id, tenant_id, application_id, environment_id, workspace_id, manifest_version,
    title, status, out_of_scope_posting, created_by
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'v1', 'Discussion', 'open', 'deny', $6)`,
		sessionID, created.TenantID, created.ApplicationID, created.EnvironmentID, created.WorkspaceID, subject,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(ctx, `INSERT INTO feedback.review_scopes (
    id, session_id, page_key, route_template, reviewable
) VALUES ($1::uuid, $2::uuid, 'home', '/', true)`, uuid.NewString(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(ctx, `INSERT INTO feedback.review_session_perspectives (
    session_id, code, label, status
) VALUES ($1::uuid, 'ux', 'UX', 'active')`, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := database.ResolvePrincipal(ctx, auth.Identity{Issuer: issuer, Subject: subject})
	if err != nil {
		t.Fatal(err)
	}
	scope := auth.ResourceScope{
		TenantID: created.TenantID, TenantKey: tenantKey, ApplicationID: created.ApplicationID,
		EnvironmentID: created.EnvironmentID, WorkspaceID: created.WorkspaceID,
		ApplicationKey: applicationKey, EnvironmentKey: "test", ExternalWorkspaceKey: workspaceKey,
	}
	service, err := discussion.NewService(database, nil, 100)
	if err != nil {
		t.Fatal(err)
	}

	baseRequest := discussion.ThreadCreateRequest{
		Location:        []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{},"queryParameters":{"tab":"map"}}`),
		Target:          []byte(`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`),
		PerspectiveCode: "ux", Body: "initial body",
	}
	invalid := discussion.CreateThreadInput{
		Scope: scope, SessionID: sessionID, Principal: principal, Request: baseRequest,
		IdempotencyKey: "test-invalid-idempotency", RequestHash: discussionHash("invalid"),
		RequestID: "request-w2-discussion-invalid",
	}
	invalid.Request.PerspectiveCode = "missing"
	if _, err := service.CreateThread(ctx, invalid); !errors.Is(err, discussion.ErrInvalidInput) {
		t.Fatalf("invalid perspective error=%v", err)
	}
	assertDiscussionCounts(t, ctx, database, created.WorkspaceID, 0, 0, 0)

	idemInput := discussion.CreateThreadInput{
		Scope: scope, SessionID: sessionID, Principal: principal, Request: baseRequest,
		IdempotencyKey: "w2-discussion-thread-0001", RequestHash: discussionHash("same-thread"),
		RequestID: "request-w2-discussion-idempotent",
	}
	var idemResults [2]discussion.Mutation[discussion.Thread]
	var idemErrors [2]error
	var wait sync.WaitGroup
	for index := range idemResults {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			idemResults[index], idemErrors[index] = service.CreateThread(ctx, idemInput)
		}(index)
	}
	wait.Wait()
	for _, failure := range idemErrors {
		if failure != nil {
			t.Fatal(failure)
		}
	}
	if idemResults[0].Value.ID != idemResults[1].Value.ID || idemResults[0].Replay == idemResults[1].Replay {
		t.Fatalf("idempotent thread results=%+v / %+v", idemResults[0], idemResults[1])
	}
	mismatch := idemInput
	mismatch.RequestHash = discussionHash("different")
	_, err = service.CreateThread(ctx, mismatch)
	var mismatchError *discussion.Error
	if !errors.Is(err, discussion.ErrConflict) || !errors.As(err, &mismatchError) || mismatchError.Code != "idempotency.mismatch" {
		t.Fatalf("idempotency mismatch=%v", err)
	}

	const parallelThreads = 12
	threadResults := make([]discussion.Mutation[discussion.Thread], parallelThreads)
	threadErrors := make([]error, parallelThreads)
	for index := 0; index < parallelThreads; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := idemInput
			input.IdempotencyKey = fmt.Sprintf("w2-discussion-thread-%04d", index+2)
			input.RequestHash = discussionHash(input.IdempotencyKey)
			input.Request.Body = fmt.Sprintf("body-%d", index)
			threadResults[index], threadErrors[index] = service.CreateThread(ctx, input)
		}(index)
	}
	wait.Wait()
	numbers := []int{idemResults[0].Value.DisplayNumber}
	for index, failure := range threadErrors {
		if failure != nil {
			t.Fatalf("parallel create[%d]: %v", index, failure)
		}
		numbers = append(numbers, threadResults[index].Value.DisplayNumber)
	}
	sort.Ints(numbers)
	for index, number := range numbers {
		if number != index+1 {
			t.Fatalf("parallel display numbers=%v", numbers)
		}
	}

	threadID := idemResults[0].Value.ID
	messageInput := discussion.CreateMessageInput{
		Scope: scope, ThreadID: threadID, Principal: principal,
		Request:        discussion.MessageCreateRequest{Body: " follow-up "},
		IdempotencyKey: "w2-discussion-message-0001", RequestHash: discussionHash("same-message"),
		RequestID: "request-w2-discussion-message",
	}
	var messageResults [2]discussion.Mutation[discussion.Message]
	var messageErrors [2]error
	for index := range messageResults {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			messageResults[index], messageErrors[index] = service.CreateMessage(ctx, messageInput)
		}(index)
	}
	wait.Wait()
	for _, failure := range messageErrors {
		if failure != nil {
			t.Fatal(failure)
		}
	}
	if messageResults[0].Value.ID != messageResults[1].Value.ID || messageResults[0].Replay == messageResults[1].Replay {
		t.Fatalf("idempotent message results=%+v / %+v", messageResults[0], messageResults[1])
	}
	messageID := messageResults[0].Value.ID
	const patchers = 8
	patchErrors := make([]error, patchers)
	patchSuccess := 0
	var patchMu sync.Mutex
	for index := 0; index < patchers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, failure := service.PatchMessage(ctx, discussion.PatchMessageInput{
				Scope: scope, MessageID: messageID, Principal: principal, ExpectedVersion: 1,
				Request: discussion.MessagePatchRequest{Body: fmt.Sprintf("patched-%d", index)},
			})
			patchMu.Lock()
			defer patchMu.Unlock()
			patchErrors[index] = failure
			if failure == nil {
				patchSuccess++
			}
		}(index)
	}
	wait.Wait()
	if patchSuccess != 1 {
		t.Fatalf("patch success=%d errors=%v", patchSuccess, patchErrors)
	}
	for _, failure := range patchErrors {
		if failure != nil && !errors.Is(failure, discussion.ErrVersionMismatch) {
			t.Fatalf("unexpected patch failure=%v", failure)
		}
	}
	versions, err := service.ListMessageVersions(ctx, messageID)
	if err != nil || len(versions) != 2 || versions[0].Version != 1 || versions[0].Current ||
		versions[1].Version != 2 || !versions[1].Current {
		t.Fatalf("message versions=%+v err=%v", versions, err)
	}

	currentThread, err := service.GetThread(ctx, threadID)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := service.PatchThreadStatus(ctx, discussion.PatchThreadStatusInput{
		Scope: scope, ThreadID: threadID, Principal: principal, ExpectedVersion: currentThread.Version,
		Status: "resolved", RequestID: "request-w2-discussion-resolve",
	})
	if err != nil || resolved.Status != "resolved" || resolved.Version != currentThread.Version+1 {
		t.Fatalf("resolved=%+v err=%v", resolved, err)
	}
	deepLink, err := service.GetThreadDeepLink(ctx, threadID)
	if err != nil || deepLink != "https://app.example/root/?tab=map&feedbackThread="+threadID {
		t.Fatalf("deep link=%q err=%v", deepLink, err)
	}
	resolvedStatus := "resolved"
	page, err := service.ListThreads(ctx, discussion.ListThreadsInput{
		SessionID: sessionID, Status: &resolvedStatus, Limit: 200,
	})
	if err != nil || page.TotalCount != 1 || len(page.Items) != 1 || page.Items[0].ID != threadID {
		t.Fatalf("resolved page=%+v err=%v", page, err)
	}

	rateInput := discussion.RateLimitInput{
		Scope: scope, Principal: principal, RemoteAddress: "192.0.2.77",
		PrincipalLimitPerMinute: 1, TenantLimitPerMinute: 1, IPLimitPerMinute: 1,
		RequestID: "request-w2-discussion-rate",
	}
	if err := service.EnforceWriteRateLimit(ctx, rateInput); err != nil {
		t.Fatalf("first rate request=%v", err)
	}
	if err := service.EnforceWriteRateLimit(ctx, rateInput); !errors.Is(err, discussion.ErrRateLimited) {
		t.Fatalf("second rate request=%v", err)
	}
	var rateAudit, rateMetric int
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.audit_logs
WHERE request_id = 'request-w2-discussion-rate' AND action = 'rate_limit' AND outcome = 'denied'`).Scan(&rateAudit); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, `SELECT value FROM feedback.operational_metric_counters
WHERE tenant_id = $1::uuid AND metric_name = 'rate_limit_rejections_total'`, created.TenantID).Scan(&rateMetric); err != nil {
		t.Fatal(err)
	}
	if rateAudit != 1 || rateMetric != 1 {
		t.Fatalf("rate audit=%d metric=%d", rateAudit, rateMetric)
	}

	assertDiscussionCounts(t, ctx, database, created.WorkspaceID, 13, 16, 15)
}

func discussionHash(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func assertDiscussionCounts(
	t *testing.T,
	ctx context.Context,
	database *postgres.Database,
	workspaceID string,
	wantThreads int,
	wantJournal int,
	wantOutbox int,
) {
	t.Helper()
	var threads, journal, outbox int
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.feedback_threads
WHERE workspace_id = $1::uuid`, workspaceID).Scan(&threads); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.feedback_change_journal
WHERE workspace_id = $1::uuid`, workspaceID).Scan(&journal); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.notification_outbox
WHERE workspace_id = $1::uuid`, workspaceID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if threads != wantThreads || journal != wantJournal || outbox != wantOutbox {
		t.Fatalf("partial write: threads=%d/%d journal=%d/%d outbox=%d/%d",
			threads, wantThreads, journal, wantJournal, outbox, wantOutbox,
		)
	}
}
