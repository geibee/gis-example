package postgres_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
)

func TestNotificationConnectorLeaseAndRetryWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w3-connector" {
		t.Fatal("connector統合testはFEEDBACK_TEST_RUN_ID=w3-connectorの専用runでのみ実行できます")
	}
	user := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER")
	password := requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL: databaseURL, User: user, Password: password, PoolSize: 8,
		ConnectionTimeout: 5 * time.Second, StatementTimeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	tenantID, applicationID := uuid.NewString(), uuid.NewString()
	environmentID, workspaceID := uuid.NewString(), uuid.NewString()
	sessionID, threadID, outboxID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
	tenantKey := "tenant-w3-connector-" + suffix
	applicationKey := "app-w3-connector-" + suffix
	workspaceKey := "workspace-w3-connector-" + suffix
	installationKey := "w3-webhook-connector-" + suffix
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, tenantID)
		_, _ = database.Exec(cleanupCtx, `DELETE FROM feedback.connector_installations WHERE connector_key = $1`, installationKey)
	}()

	mustExec(t, ctx, database, `INSERT INTO feedback.tenants (id,tenant_key,display_name)
VALUES ($1::uuid,$2,'W3 connector')`, tenantID, tenantKey)
	mustExec(t, ctx, database, `INSERT INTO feedback.applications (id,tenant_id,application_key,display_name)
VALUES ($1::uuid,$2::uuid,$3,'W3 connector')`, applicationID, tenantID, applicationKey)
	mustExec(t, ctx, database, `INSERT INTO feedback.application_environments (
id,application_id,environment_key,base_url,allowed_origins,deep_link_thread_parameter)
VALUES ($1::uuid,$2::uuid,'test','https://app.example/root',ARRAY['https://app.example'],'feedbackThread')`, environmentID, applicationID)
	mustExec(t, ctx, database, `INSERT INTO feedback.workspaces (
id,tenant_id,application_id,external_workspace_key,display_name)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'W3 connector')`, workspaceID, tenantID, applicationID, workspaceKey)
	mustExec(t, ctx, database, `INSERT INTO feedback.application_manifests (
id,application_id,manifest_version,manifest,created_by)
VALUES ($1::uuid,$2::uuid,'v1',$3::jsonb,'w3')`, uuid.NewString(), applicationID,
		`{"routes":[{"pageKey":"home","template":"/"}]}`)
	mustExec(t, ctx, database, `INSERT INTO feedback.review_sessions (
id,tenant_id,application_id,environment_id,workspace_id,manifest_version,title,status,created_by)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'v1','W3','open','w3')`,
		sessionID, tenantID, applicationID, environmentID, workspaceID)
	mustExec(t, ctx, database, `INSERT INTO feedback.feedback_threads (
id,tenant_id,application_id,environment_id,workspace_id,session_id,display_number,
location,target,perspective_code,reporter_principal_id)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,1,$7::jsonb,$8::jsonb,'ux','w3')`,
		threadID, tenantID, applicationID, environmentID, workspaceID, sessionID,
		`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`,
		`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`)
	payload, _ := json.Marshal(map[string]any{
		"schemaVersion": "1", "eventId": outboxID, "requestId": "w3-integration",
		"eventType": "feedback.message.created.v1", "occurredAt": "2026-08-09T00:00:00Z",
		"tenantKey": tenantKey, "applicationKey": applicationKey,
		"environmentKey": "test", "externalWorkspaceKey": workspaceKey,
		"sessionId": sessionID, "threadId": threadID,
		"actor": map[string]any{"principalId": "w3", "displayName": nil, "participantName": nil},
		"body":  "integration body", "deepLink": nil, "evidenceUrl": nil,
	})
	mustExec(t, ctx, database, `INSERT INTO feedback.notification_outbox (
id,tenant_id,workspace_id,event_type,payload)
VALUES ($1::uuid,$2::uuid,$3::uuid,'feedback.message.created.v1',$4::jsonb)`, outboxID, tenantID, workspaceID, payload)

	cipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{7}, 32), nil)
	connectorService, err := connector.NewService(database, cipher, true)
	if err != nil {
		t.Fatal(err)
	}
	err = connectorService.Register(ctx, connector.InstallationInput{
		ConnectorKey: installationKey, DisplayName: "W3 Webhook",
		ManifestURL: "http://127.0.0.1:1/connector/v1/manifest",
		DeliveryURL: "http://127.0.0.1:1/connector/v1/deliveries",
		HealthURL:   "http://127.0.0.1:1/health/ready", SigningSecret: "w3-connector-shared-secret-32-characters",
		SupportedEvents: []string{"feedback.message.created.v1"}, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	scope := auth.ResourceScope{TenantID: tenantID, WorkspaceID: workspaceID}
	createdConnector, err := connectorService.Create(ctx, scope, connector.CreateRequest{
		ConnectorType: installationKey, Name: "W3 Webhook", DestinationRef: "review-a", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, ctx, database, `INSERT INTO feedback.connector_delivery_queue (id,outbox_id,connector_id)
VALUES ($1::uuid,$2::uuid,$3::uuid)`, uuid.NewString(), outboxID, createdConnector.ID)
	connectors, err := connectorService.List(ctx, scope)
	if err != nil || len(connectors) != 1 || connectors[0].DestinationRef != "review-a" {
		t.Fatalf("connectors=%+v err=%v", connectors, err)
	}

	var claims [2]*connector.ClaimedDelivery
	var claimErrors [2]error
	var wait sync.WaitGroup
	for index := range claims {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			claims[index], claimErrors[index] = database.ClaimConnectorDelivery(ctx, cipher)
		}(index)
	}
	wait.Wait()
	var first *connector.ClaimedDelivery
	for index, claim := range claims {
		if claimErrors[index] != nil {
			t.Fatal(claimErrors[index])
		}
		if claim != nil {
			if first != nil {
				t.Fatalf("同じqueueが二重claimされました: %+v / %+v", first, claim)
			}
			first = claim
		}
	}
	if first == nil || first.Attempt != 1 {
		t.Fatalf("parallel claim=%+v", claims)
	}
	mustExec(t, ctx, database, `UPDATE feedback.connector_delivery_queue
SET claimed_at = now() - interval '3 minutes' WHERE id = $1::uuid`, first.ID)
	recovered, err := database.ClaimConnectorDelivery(ctx, cipher)
	if err != nil || recovered == nil || recovered.ID != first.ID || recovered.Attempt != 2 {
		t.Fatalf("lease recovery=%+v err=%v", recovered, err)
	}
	status429 := 429
	if err := database.CompleteConnectorDelivery(ctx, *recovered, connector.DispatchResult{
		ResponseStatus: &status429, Error: "HTTP 429",
	}, 5); err != nil {
		t.Fatal(err)
	}
	mustExec(t, ctx, database, `UPDATE feedback.connector_delivery_queue SET available_at = now() WHERE id = $1::uuid`, first.ID)
	third, err := database.ClaimConnectorDelivery(ctx, cipher)
	if err != nil || third == nil || third.Attempt != 3 {
		t.Fatalf("third claim=%+v err=%v", third, err)
	}
	status400 := 400
	if err := database.CompleteConnectorDelivery(ctx, *third, connector.DispatchResult{
		ResponseStatus: &status400, Error: "HTTP 400",
	}, 5); err != nil {
		t.Fatal(err)
	}
	notificationService, err := notification.NewService(database, cipher, true)
	if err != nil {
		t.Fatal(err)
	}
	failed := "failed"
	deliveries, err := notificationService.ListDeliveries(ctx, notification.ListInput{Scope: scope, Status: &failed, Limit: 50})
	if err != nil || len(deliveries) != 1 || deliveries[0].AttemptCount != 3 || len(deliveries[0].Attempts) != 2 {
		t.Fatalf("deliveries=%+v err=%v", deliveries, err)
	}
	retried, err := notificationService.Retry(ctx, scope, first.ID)
	if err != nil || retried.Status != "pending" || retried.RetryCycle != 1 || retried.AttemptCount != 0 {
		t.Fatalf("retry=%+v err=%v", retried, err)
	}
	var failures int
	if err := database.QueryRow(ctx, `SELECT value FROM feedback.operational_metric_counters
WHERE metric_name = 'delivery_failures_total' AND tenant_id = $1::uuid`, tenantID).Scan(&failures); err != nil || failures != 2 {
		t.Fatalf("failure metric=%d err=%v", failures, err)
	}
}

func mustExec(t *testing.T, ctx context.Context, database *postgres.Database, query string, arguments ...any) {
	t.Helper()
	if _, err := database.Exec(ctx, query, arguments...); err != nil {
		t.Fatal(err)
	}
}
