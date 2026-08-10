package notification

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

func TestServiceSettingsEncryptionAndRotation(t *testing.T) {
	t.Parallel()
	oldCipher, err := cryptoutil.NewCipher(bytes.Repeat([]byte{1}, 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := oldCipher.EncryptString("https://legacy.example/webhook")
	if err != nil {
		t.Fatal(err)
	}
	store := &adminFake{stored: StoredSettings{
		WebhookEnabled: true, EndpointCiphertext: encrypted.Ciphertext,
		EndpointNonce: encrypted.Nonce, Version: 3,
	}}
	rotated, err := cryptoutil.NewCipher(bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, rotated, false)
	if err != nil {
		t.Fatal(err)
	}
	view, err := service.GetSettings(context.Background(), auth.ResourceScope{WorkspaceID: "workspace"})
	if err != nil || view.Settings.WebhookEndpoint == nil || *view.Settings.WebhookEndpoint != "https://legacy.example/webhook" {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	endpoint := "https://new.example/hook"
	view, err = service.PatchSettings(context.Background(), auth.ResourceScope{WorkspaceID: "workspace"}, 3, Settings{
		WebhookEnabled: true, WebhookEndpoint: &endpoint, IncludeBody: true,
	})
	if err != nil || bytes.Contains(store.update.EndpointCiphertext, []byte(endpoint)) {
		t.Fatalf("view=%+v update=%+v err=%v", view, store.update, err)
	}
	plaintext, err := rotated.DecryptString(store.update.EndpointCiphertext, store.update.EndpointNonce)
	if err != nil || plaintext != endpoint {
		t.Fatalf("plaintext=%q err=%v", plaintext, err)
	}
}

func TestServiceValidation(t *testing.T) {
	t.Parallel()
	cipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{1}, 32), nil)
	service, err := NewService(&adminFake{}, cipher, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, settings := range []Settings{
		{WebhookEnabled: true},
		{WebhookEndpoint: stringPointer("http://127.0.0.1/hook")},
		{WebhookEndpoint: stringPointer("https://user@example.test/hook#fragment")},
	} {
		if _, err := service.PatchSettings(context.Background(), auth.ResourceScope{}, 1, settings); err == nil {
			t.Fatalf("invalid settings accepted: %+v", settings)
		}
	}
	if _, err := service.ListDeliveries(context.Background(), ListInput{Limit: 201}); err == nil {
		t.Fatal("limit>200を許可しました")
	}
	invalidStatus := "unknown"
	if _, err := service.ListDeliveries(context.Background(), ListInput{Limit: 50, Status: &invalidStatus}); err == nil {
		t.Fatal("未知statusを許可しました")
	}
}

func TestWorkerHealthThenDeliveryAndCompletion(t *testing.T) {
	t.Parallel()
	sequence := make([]string, 0, 6)
	store := &workerFake{
		sequence: &sequence,
		health:   &connector.HealthTarget{ID: "health", HealthURL: "https://health.example"},
		delivery: &connector.ClaimedDelivery{
			ID: "delivery", EventID: "event", Attempt: 1, TenantID: "tenant",
		},
	}
	cipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{1}, 32), nil)
	worker, err := NewWorker(
		store, cipher,
		dispatcherFake{sequence: &sequence, result: connector.DispatchResult{ResponseStatus: intPointer(429), Error: "HTTP 429"}},
		healthFake{sequence: &sequence},
		WorkerOptions{PollInterval: time.Second, MaxAttempts: 5},
	)
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.RunOnce(context.Background())
	if err != nil || !worked {
		t.Fatalf("worked=%v err=%v", worked, err)
	}
	want := []string{"claim-health", "check-health", "complete-health", "claim-delivery", "dispatch", "complete-delivery"}
	if !reflect.DeepEqual(sequence, want) {
		t.Fatalf("sequence=%v want=%v", sequence, want)
	}
	if store.completed.ResponseStatus == nil || *store.completed.ResponseStatus != 429 || store.maxAttempts != 5 {
		t.Fatalf("completion=%+v max=%d", store.completed, store.maxAttempts)
	}
}

func TestWorkerStopsBeforeDispatchOnClaimFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("claim failed")
	sequence := make([]string, 0, 2)
	store := &workerFake{sequence: &sequence, claimError: want}
	cipher, _ := cryptoutil.NewCipher(bytes.Repeat([]byte{1}, 32), nil)
	worker, err := NewWorker(
		store, cipher, dispatcherFake{sequence: &sequence}, healthFake{sequence: &sequence},
		WorkerOptions{PollInterval: 100 * time.Millisecond, MaxAttempts: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RunOnce(context.Background()); !errors.Is(err, want) {
		t.Fatalf("error=%v", err)
	}
	if !reflect.DeepEqual(sequence, []string{"claim-health", "claim-delivery"}) {
		t.Fatalf("sequence=%v", sequence)
	}
}

type adminFake struct {
	stored StoredSettings
	update SettingsUpdate
}

func (s *adminFake) GetNotificationSettings(context.Context, auth.ResourceScope) (StoredSettings, error) {
	return s.stored, nil
}

func (s *adminFake) PatchNotificationSettings(_ context.Context, _ auth.ResourceScope, _ int, update SettingsUpdate) (StoredSettings, error) {
	s.update = update
	s.stored = StoredSettings{
		WebhookEnabled: update.WebhookEnabled, EndpointCiphertext: update.EndpointCiphertext,
		EndpointNonce: update.EndpointNonce, IncludeBody: update.IncludeBody,
		IncludeEvidence: update.IncludeEvidence, Version: 4,
	}
	return s.stored, nil
}

func (s *adminFake) ListNotificationDeliveries(context.Context, ListInput) ([]Delivery, error) {
	return []Delivery{}, nil
}

func (s *adminFake) RetryNotificationDelivery(context.Context, auth.ResourceScope, string) (Delivery, error) {
	return Delivery{}, nil
}

type workerFake struct {
	sequence    *[]string
	health      *connector.HealthTarget
	delivery    *connector.ClaimedDelivery
	claimError  error
	completed   connector.DispatchResult
	maxAttempts int
}

func (s *workerFake) ClaimConnectorHealth(context.Context) (*connector.HealthTarget, error) {
	*s.sequence = append(*s.sequence, "claim-health")
	return s.health, nil
}

func (s *workerFake) CompleteConnectorHealth(context.Context, string, connector.HealthResult) error {
	*s.sequence = append(*s.sequence, "complete-health")
	return nil
}

func (s *workerFake) ClaimConnectorDelivery(context.Context, *cryptoutil.Cipher) (*connector.ClaimedDelivery, error) {
	*s.sequence = append(*s.sequence, "claim-delivery")
	return s.delivery, s.claimError
}

func (s *workerFake) CompleteConnectorDelivery(_ context.Context, _ connector.ClaimedDelivery, result connector.DispatchResult, maximum int) error {
	*s.sequence = append(*s.sequence, "complete-delivery")
	s.completed, s.maxAttempts = result, maximum
	return nil
}

type dispatcherFake struct {
	sequence *[]string
	result   connector.DispatchResult
}

func (d dispatcherFake) Dispatch(context.Context, connector.ClaimedDelivery) connector.DispatchResult {
	*d.sequence = append(*d.sequence, "dispatch")
	return d.result
}

type healthFake struct{ sequence *[]string }

func (h healthFake) Check(context.Context, connector.HealthTarget) connector.HealthResult {
	*h.sequence = append(*h.sequence, "check-health")
	return connector.HealthResult{Healthy: true}
}

func intPointer(value int) *int          { return &value }
func stringPointer(value string) *string { return &value }
