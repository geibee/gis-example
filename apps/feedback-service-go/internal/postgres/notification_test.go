package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

func TestClaimConnectorDeliveryUsesLeaseAndDecryptsPreviousKey(t *testing.T) {
	t.Parallel()
	oldCipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{1}, 32), nil)
	encrypted, err := oldCipher.EncryptString("connector-shared-secret-32-characters")
	if err != nil {
		t.Fatal(err)
	}
	rotated, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{1}, 32))
	payload, _ := json.Marshal(map[string]any{
		"threadId":   "00000000-0000-4000-8000-000000000034",
		"occurredAt": "2026-08-09T00:00:00Z",
	})
	tx := &notificationTestTx{rows: []pgx.Row{discussionRow{scanFn: func(destinations ...any) error {
		*destinations[0].(*string) = "00000000-0000-4000-8000-000000000031"
		*destinations[1].(*string) = "00000000-0000-4000-8000-000000000032"
		*destinations[2].(*[]byte) = payload
		*destinations[3].(*int) = 0
		*destinations[4].(*int) = 0
		*destinations[5].(*string) = "review-a"
		*destinations[6].(*bool) = false
		*destinations[7].(*string) = "https://connector.example/deliver"
		*destinations[8].(*[]byte) = encrypted.Ciphertext
		*destinations[9].(*[]byte) = encrypted.Nonce
		*destinations[10].(*string) = "00000000-0000-4000-8000-000000000041"
		*destinations[11].(*[]byte) = []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`)
		*destinations[12].(*string) = "https://app.example"
		*destinations[13].(*string) = "feedbackThread"
		*destinations[14].(*[]byte) = []byte(`{"routes":[{"pageKey":"home","template":"/"}]}`)
		*destinations[15].(*[]string) = []string{"connector.example"}
		return nil
	}}}}
	database := newTestDatabase(&notificationTestPool{tx: tx})
	delivery, err := database.ClaimConnectorDelivery(context.Background(), rotated)
	if err != nil {
		t.Fatal(err)
	}
	if delivery == nil || delivery.SigningSecret != "connector-shared-secret-32-characters" || delivery.Attempt != 1 {
		t.Fatalf("delivery=%+v", delivery)
	}
	if tx.commits != 1 || tx.rollbacks != 0 || len(tx.querySQL) != 1 ||
		!strings.Contains(tx.querySQL[0], "FOR UPDATE OF queue SKIP LOCKED") ||
		!strings.Contains(tx.querySQL[0], "claimed_at < now() - interval '2 minutes'") {
		t.Fatalf("query=%v commits=%d rollbacks=%d", tx.querySQL, tx.commits, tx.rollbacks)
	}
	if len(tx.execSQL) != 1 || !strings.Contains(tx.execSQL[0], "status = 'processing'") {
		t.Fatalf("exec=%v", tx.execSQL)
	}
	if !strings.Contains(string(delivery.Event), `"deepLink":"https://app.example/?feedbackThread=`) {
		t.Fatalf("enriched event=%s", delivery.Event)
	}
}

func TestCompleteConnectorDeliveryRollsBackAttemptQueueAndMetricTogether(t *testing.T) {
	t.Parallel()
	want := errors.New("metric unavailable")
	tx := &notificationTestTx{execFn: func(sql string, _ []any) (pgconn.CommandTag, error) {
		if strings.Contains(sql, "operational_metric_counters") {
			return pgconn.CommandTag{}, want
		}
		return pgconn.NewCommandTag("UPDATE 1"), nil
	}}
	database := newTestDatabase(&notificationTestPool{tx: tx})
	status := 503
	err := database.CompleteConnectorDelivery(context.Background(), connector.ClaimedDelivery{
		ID:       "00000000-0000-4000-8000-000000000031",
		EventID:  "00000000-0000-4000-8000-000000000032",
		TenantID: "00000000-0000-4000-8000-000000000041", Attempt: 1,
	}, connector.DispatchResult{ResponseStatus: &status, Error: "HTTP 503"}, 5)
	if !errors.Is(err, want) || tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("err=%v commits=%d rollbacks=%d", err, tx.commits, tx.rollbacks)
	}
	joined := strings.Join(tx.execSQL, "\n")
	if !strings.Contains(joined, "connector_delivery_attempts") ||
		!strings.Contains(joined, "connector_delivery_queue") ||
		!strings.Contains(joined, "operational_metric_counters") ||
		strings.Contains(joined, "UPDATE feedback.notification_outbox") {
		t.Fatalf("rollback境界SQL=%s", joined)
	}
}

func TestCompleteConnectorDeliveryCommitsAttemptMetricAndAggregate(t *testing.T) {
	t.Parallel()
	tx := &notificationTestTx{}
	database := newTestDatabase(&notificationTestPool{tx: tx})
	status := 429
	err := database.CompleteConnectorDelivery(context.Background(), connector.ClaimedDelivery{
		ID:       "00000000-0000-4000-8000-000000000031",
		EventID:  "00000000-0000-4000-8000-000000000032",
		TenantID: "00000000-0000-4000-8000-000000000041", Attempt: 2, RetryCycle: 1,
	}, connector.DispatchResult{ResponseStatus: &status, Error: "HTTP 429"}, 5)
	if err != nil || tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("err=%v commits=%d rollbacks=%d", err, tx.commits, tx.rollbacks)
	}
	joined := strings.Join(tx.execSQL, "\n")
	for _, fragment := range []string{
		"connector_delivery_attempts", "connector_delivery_queue", "operational_metric_counters",
		"UPDATE feedback.notification_outbox",
	} {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("%s missing: %s", fragment, joined)
		}
	}
	if len(tx.execArguments) < 2 || tx.execArguments[1][0] != "pending" || tx.execArguments[1][1] != 4 {
		t.Fatalf("retry update args=%v", tx.execArguments)
	}
}

func TestCompleteConnectorDeliveryDeadLettersRetryableAtMaximum(t *testing.T) {
	t.Parallel()
	tx := &notificationTestTx{}
	database := newTestDatabase(&notificationTestPool{tx: tx})
	status := 429
	err := database.CompleteConnectorDelivery(context.Background(), connector.ClaimedDelivery{
		ID:       "00000000-0000-4000-8000-000000000031",
		EventID:  "00000000-0000-4000-8000-000000000032",
		TenantID: "00000000-0000-4000-8000-000000000041", Attempt: 5,
	}, connector.DispatchResult{ResponseStatus: &status, Error: "HTTP 429"}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(tx.execArguments) < 2 || tx.execArguments[1][0] != "failed" {
		t.Fatalf("queue update args=%v", tx.execArguments)
	}
}

func TestClaimConnectorHealthUsesSkipLocked(t *testing.T) {
	t.Parallel()
	tx := &notificationTestTx{rows: []pgx.Row{discussionRow{scanFn: func(destinations ...any) error {
		*destinations[0].(*string) = "00000000-0000-4000-8000-000000000031"
		*destinations[1].(*string) = "https://connector.example/health"
		*destinations[2].(*[]string) = []string{"connector.example"}
		return nil
	}}}}
	database := newTestDatabase(&notificationTestPool{tx: tx})
	target, err := database.ClaimConnectorHealth(context.Background())
	if err != nil || target == nil {
		t.Fatalf("target=%+v err=%v", target, err)
	}
	if !strings.Contains(tx.querySQL[0], "health_checked_at < now() - interval '1 minute'") ||
		!strings.Contains(tx.querySQL[0], "FOR UPDATE SKIP LOCKED") {
		t.Fatalf("query=%s", tx.querySQL[0])
	}
}

func TestRegisterWebhookBackfillsLegacySettingsInOneTransaction(t *testing.T) {
	t.Parallel()
	cipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{9}, 32), nil)
	endpoint := "https://legacy.example/webhook"
	encrypted, err := cipher.EncryptString(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	installationID := "00000000-0000-4000-8000-000000000051"
	workspaceID := "00000000-0000-4000-8000-000000000052"
	tx := &notificationTestTx{
		rows: []pgx.Row{
			discussionRow{scanFn: func(destinations ...any) error {
				*destinations[0].(*string) = installationID
				return nil
			}},
			discussionRow{err: pgx.ErrNoRows},
		},
		queryRows: &discussionRows{scans: []func(...any) error{func(destinations ...any) error {
			*destinations[0].(*string) = workspaceID
			*destinations[1].(*string) = "application"
			*destinations[2].(*string) = "workspace"
			*destinations[3].(*bool) = true
			*destinations[4].(*bool) = false
			*destinations[5].(*[]byte) = encrypted.Ciphertext
			*destinations[6].(*[]byte) = encrypted.Nonce
			return nil
		}}},
	}
	digest := sha256.Sum256([]byte(endpoint))
	database := newTestDatabase(&notificationTestPool{tx: tx})
	err = database.RegisterConnectorInstallation(context.Background(), connector.ValidatedInstallation{
		ID: installationID, ConnectorKey: "webhook", DisplayName: "Webhook",
		ManifestURL: "https://connector.example/manifest", DeliveryURL: "https://connector.example/deliver",
		HealthURL: "https://connector.example/health", AllowedHosts: []string{"connector.example"},
		EncryptedSecret: encrypted, SupportedEvents: []string{"feedback.message.created.v1"}, Enabled: true,
		LegacyDestinationRefs: map[string]string{hex.EncodeToString(digest[:]): "review-a"},
	}, cipher)
	if err != nil || tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("err=%v commits=%d rollbacks=%d", err, tx.commits, tx.rollbacks)
	}
	if len(tx.execArguments) != 2 || tx.execArguments[0][3] != "review-a" ||
		!strings.Contains(tx.execSQL[0], "legacy_settings") ||
		!strings.Contains(tx.execSQL[1], "connector_delivery_queue") {
		t.Fatalf("execSQL=%v args=%v", tx.execSQL, tx.execArguments)
	}
}

type notificationTestTx struct {
	rows          []pgx.Row
	queryRows     pgx.Rows
	querySQL      []string
	execSQL       []string
	execArguments [][]any
	execFn        func(string, []any) (pgconn.CommandTag, error)
	commits       int
	rollbacks     int
}

func (tx *notificationTestTx) Exec(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	tx.execSQL = append(tx.execSQL, sql)
	tx.execArguments = append(tx.execArguments, append([]any(nil), arguments...))
	if tx.execFn != nil {
		return tx.execFn(sql, arguments)
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (tx *notificationTestTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	tx.querySQL = append(tx.querySQL, sql)
	if tx.queryRows == nil {
		return nil, errors.New("unexpected Query")
	}
	return tx.queryRows, nil
}

func (tx *notificationTestTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.querySQL = append(tx.querySQL, sql)
	if len(tx.rows) == 0 {
		return discussionRow{err: errors.New("unexpected QueryRow")}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}

func (tx *notificationTestTx) Commit(context.Context) error {
	tx.commits++
	return nil
}

func (tx *notificationTestTx) Rollback(context.Context) error {
	tx.rollbacks++
	return nil
}

type notificationTestPool struct{ tx *notificationTestTx }

func (p *notificationTestPool) Begin(context.Context) (managedTx, error) { return p.tx, nil }
func (p *notificationTestPool) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unexpected pool Exec")
}
func (p *notificationTestPool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected pool Query")
}
func (p *notificationTestPool) QueryRow(context.Context, string, ...any) pgx.Row {
	return discussionRow{err: errors.New("unexpected pool QueryRow")}
}
func (p *notificationTestPool) Ping(context.Context) error { return nil }
func (p *notificationTestPool) Close()                     {}
