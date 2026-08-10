package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

const (
	testDeliveryID = "00000000-0000-4000-8000-000000000031"
	testEventID    = "00000000-0000-4000-8000-000000000032"
	testSecret     = "runtime-test-shared-secret-32chars"
)

func TestRuntimeSignatureForbiddenPayloadAndPersistentDuplicate(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	store, err := NewFileDeliveryIDStore(filepath.Join(t.TempDir(), "ids.log"), 100)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	handler, err := NewRuntime(
		RuntimeSettings{Provider: "webhook", DisplayName: "Webhook", SharedSecret: testSecret},
		referenceFunc(func(context.Context, DeliveryRequestV1) error { calls.Add(1); return nil }),
		store, func() time.Time { return now },
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	body := runtimeFixture(t, false)

	response := sendRuntime(t, server.URL, body, now.Add(-301*time.Second), testSecret, testDeliveryID)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired signature status=%d", response.StatusCode)
	}
	response.Body.Close()
	response = sendRuntime(t, server.URL, body, now, "wrong-secret-with-enough-length-000", testDeliveryID)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong signature status=%d", response.StatusCode)
	}
	response.Body.Close()
	forbidden := runtimeFixture(t, true)
	response = sendRuntime(t, server.URL, forbidden, now, testSecret, testDeliveryID)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("forbidden payload status=%d", response.StatusCode)
	}
	response.Body.Close()
	response = sendRuntime(t, server.URL, body, now, testSecret, testDeliveryID)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("accepted status=%d", response.StatusCode)
	}
	response.Body.Close()
	response = sendRuntime(t, server.URL, body, now, testSecret, testDeliveryID)
	if response.StatusCode != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("duplicate status=%d calls=%d", response.StatusCode, calls.Load())
	}
	response.Body.Close()
}

func TestRuntimeConcurrentDuplicateRunsOnce(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	store := &memoryStore{values: map[string]bool{}}
	start := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	handler, err := NewRuntime(
		RuntimeSettings{Provider: "webhook", DisplayName: "Webhook", SharedSecret: testSecret},
		referenceFunc(func(context.Context, DeliveryRequestV1) error {
			if calls.Add(1) == 1 {
				close(start)
				<-release
			}
			return nil
		}), store, func() time.Time { return now },
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	body := runtimeFixture(t, false)
	statuses := make(chan int, 2)
	go func() {
		response := sendRuntime(t, server.URL, body, now, testSecret, testDeliveryID)
		statuses <- response.StatusCode
		response.Body.Close()
	}()
	<-start
	go func() {
		response := sendRuntime(t, server.URL, body, now, testSecret, testDeliveryID)
		statuses <- response.StatusCode
		response.Body.Close()
	}()
	close(release)
	first, second := <-statuses, <-statuses
	if calls.Load() != 1 || !((first == 202 && second == 200) || (first == 200 && second == 202)) {
		t.Fatalf("calls=%d statuses=%d,%d", calls.Load(), first, second)
	}
}

func TestFileDeliveryIDStoreStreamsAndKeepsRecentIDs(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "ids.log")
	ids := []string{
		"00000000-0000-4000-8000-000000000041",
		"00000000-0000-4000-8000-000000000042",
		"00000000-0000-4000-8000-000000000043",
	}
	if err := os.WriteFile(path, []byte(strings.Join(ids, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileDeliveryIDStore(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	for index, id := range ids {
		present, err := store.Contains(id)
		if err != nil || present != (index > 0) {
			t.Fatalf("Contains(%s)=%v err=%v", id, present, err)
		}
	}
	if err := store.Add("not-a-uuid"); err == nil {
		t.Fatal("不正なdelivery IDを永続化しました")
	}
	if err := store.Add("00000000-0000-4000-8000-000000000044"); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewFileDeliveryIDStore(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	present, err := reloaded.Contains("00000000-0000-4000-8000-000000000044")
	if err != nil || !present {
		t.Fatalf("再起動後のdelivery ID=%v err=%v", present, err)
	}
}

func TestFileDeliveryIDStoreRejectsOversizedCorruptLine(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "ids.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", maximumDeliveryIDLineBytes+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileDeliveryIDStore(path, 100); err == nil {
		t.Fatal("上限超過のidempotency fileを受理しました")
	}
}

func TestHTTPDispatcherTimeoutStatusAndPayloadFiltering(t *testing.T) {
	t.Parallel()
	var captured []byte
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/timeout":
			time.Sleep(100 * time.Millisecond)
			writer.WriteHeader(http.StatusNoContent)
		case "/accepted":
			captured, _ = ioReadAll(request)
			writeJSON(writer, http.StatusAccepted, DeliveryResultV1{
				Kind: "delivery-result", ProtocolVersion: "1", DeliveryID: testDeliveryID,
				Status: "accepted", ReceivedAt: "2026-08-09T00:00:00Z",
			})
		case "/redirect":
			http.Redirect(writer, request, serverURLForRedirect(request)+"/accepted", http.StatusFound)
		default:
			status := 400
			_, _ = fmtSscanfPath(request.URL.Path, &status)
			writer.WriteHeader(status)
		}
	}))
	defer server.Close()
	host := map[string]struct{}{"127.0.0.1": {}}
	policy := EndpointPolicy{AllowLocalHTTP: true, AllowedHosts: host}
	delivery := claimedFixture(server.URL + "/accepted")
	dispatcher := NewHTTPDispatcher(policy, server.Client(), 2*time.Second, func() time.Time { return time.Unix(1_700_000_000, 0) })
	result := dispatcher.Dispatch(context.Background(), delivery)
	if result.Error != "" || result.ResponseStatus == nil || *result.ResponseStatus != 202 {
		t.Fatalf("accepted=%+v", result)
	}
	text := string(captured)
	if strings.Contains(text, "secret body") || strings.Contains(text, "evidenceUrl") || strings.Contains(text, "objectKey") {
		t.Fatalf("禁止payloadが送信されました: %s", text)
	}
	for _, test := range []struct {
		path      string
		retryable bool
		status    *int
	}{
		{path: "/timeout", retryable: true}, {path: "/429", retryable: true, status: intPointer(429)},
		{path: "/400", retryable: false, status: intPointer(400)}, {path: "/503", retryable: true, status: intPointer(503)},
		{path: "/redirect", retryable: false, status: intPointer(302)},
	} {
		delivery.DeliveryURL = server.URL + test.path
		candidate := dispatcher
		if test.path == "/timeout" {
			candidate = NewHTTPDispatcher(policy, server.Client(), 10*time.Millisecond, time.Now)
		}
		got := candidate.Dispatch(context.Background(), delivery)
		if !sameStatus(got.ResponseStatus, test.status) || IsRetryableResponse(got.ResponseStatus) != test.retryable {
			t.Fatalf("%s result=%+v retryable=%v", test.path, got, IsRetryableResponse(got.ResponseStatus))
		}
	}
}

func TestEndpointPolicyRejectsSSRF(t *testing.T) {
	t.Parallel()
	resolver := staticResolver{addresses: []net.IPAddr{{IP: net.ParseIP("10.0.0.8")}}}
	policy := EndpointPolicy{AllowedHosts: map[string]struct{}{"connector.example": {}}, Resolver: resolver}
	if _, err := policy.Validate(context.Background(), "https://connector.example/deliver"); err == nil {
		t.Fatal("private addressを許可しました")
	}
	if _, err := policy.Validate(context.Background(), "https://other.example/deliver"); err == nil {
		t.Fatal("allowlist外hostを許可しました")
	}
	public := EndpointPolicy{
		AllowedHosts: map[string]struct{}{"connector.example": {}},
		Resolver:     staticResolver{addresses: []net.IPAddr{{IP: net.ParseIP("192.0.2.10")}}},
	}
	if _, err := public.Validate(context.Background(), "https://connector.example/deliver"); err != nil {
		t.Fatal(err)
	}
	localDevelopment := EndpointPolicy{
		AllowLocalHTTP: true, AllowedHosts: map[string]struct{}{"connector.local": {}}, Resolver: resolver,
	}
	if _, err := localDevelopment.Validate(context.Background(), "http://connector.local/deliver"); err != nil {
		t.Fatalf("開発用local HTTPでDocker private addressを拒否しました: %v", err)
	}
}

func TestHealthErrorMasksEndpointSecrets(t *testing.T) {
	t.Parallel()
	message := sanitizeHealthError(errors.New(`Get "https://connector.example/health?token=top-secret": timeout`))
	if strings.Contains(message, "top-secret") || !strings.Contains(message, "<redacted>") {
		t.Fatalf("health error=%q", message)
	}
}

func TestRuntimeTimestampUsesJavaInstantGrouping(t *testing.T) {
	t.Parallel()
	value := time.Date(2026, 8, 9, 0, 0, 0, 123400000, time.FixedZone("JST", 9*60*60))
	if got := javaInstant(value); got != "2026-08-08T15:00:00.123400Z" {
		t.Fatalf("timestamp=%q", got)
	}
}

func TestFetchManifestAppliesProtocolDefaultsAndRejectsUnknownField(t *testing.T) {
	t.Parallel()
	var unknown atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if unknown.Load() {
			_, _ = writer.Write([]byte(`{"connectorKey":"webhook","displayName":"Webhook","supportedEvents":["feedback.message.created.v1"],"token":"forbidden"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"connectorKey":"webhook","displayName":"Webhook","supportedEvents":["feedback.message.created.v1"]}`))
	}))
	defer server.Close()
	manifest, err := FetchManifest(context.Background(), server.URL, server.Client(), true)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Kind != "manifest" || manifest.ProtocolVersion != "1" || manifest.HealthPath != "/health/ready" {
		t.Fatalf("manifest=%+v", manifest)
	}
	if err := ValidateManifest("webhook", []string{"feedback.message.created.v1"}, manifest); err != nil {
		t.Fatal(err)
	}
	unknown.Store(true)
	if _, err := FetchManifest(context.Background(), server.URL, server.Client(), true); err == nil {
		t.Fatal("未知fieldを持つmanifestを許可しました")
	}
}

func TestCreateRequestJSONDefaultsEnabled(t *testing.T) {
	t.Parallel()
	var request CreateRequest
	if err := json.Unmarshal([]byte(`{"connectorType":"slack","name":"Slack","destinationRef":"review"}`), &request); err != nil {
		t.Fatal(err)
	}
	if !request.Enabled || request.IncludeBody {
		t.Fatalf("request=%+v", request)
	}
}

func TestReferenceRenderersAndSMTPIsolation(t *testing.T) {
	t.Parallel()
	delivery := DeliveryRequestV1{DeliveryID: testDeliveryID, Event: fixtureEvent(t, false)}
	teams, err := renderReferencePayload("teams", delivery.Event)
	if err != nil || !strings.Contains(string(teams), "Feedback notification") {
		t.Fatalf("teams=%s err=%v", teams, err)
	}
	slack, err := renderReferencePayload("slack", delivery.Event)
	if err != nil || strings.Contains(string(slack), "summary") {
		t.Fatalf("slack=%s err=%v", slack, err)
	}
	mailSender := &recordingMailSender{}
	smtpDispatcher, err := NewSMTPReferenceDispatcher(SMTPSettings{
		Host: "smtp.internal", Port: 587, SenderAddress: "feedback@example.invalid",
		Destinations: map[string]string{"review-a": "a@example.invalid"}, Password: "smtp-secret",
	}, mailSender)
	if err != nil {
		t.Fatal(err)
	}
	delivery.DestinationRef = "review-a"
	if err := smtpDispatcher.Dispatch(context.Background(), delivery); err != nil {
		t.Fatal(err)
	}
	if len(mailSender.sent) != 1 || strings.Contains(mailSender.sent[0].Body, "smtp-secret") ||
		mailSender.sent[0].Subject != "[Feedback] feedback.message.created.v1" {
		t.Fatalf("mail=%+v", mailSender.sent)
	}
}

func TestWebhookReferenceSignsExactOutboundBody(t *testing.T) {
	t.Parallel()
	now := time.Unix(1_700_000_000, 0)
	var body []byte
	var timestamp, signature string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ = io.ReadAll(request.Body)
		timestamp = request.Header.Get("X-Feedback-Timestamp")
		signature = request.Header.Get("X-Feedback-Signature")
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	const webhookSecret = "webhook-outbound-signing-secret-32chars"
	dispatcher, err := NewHTTPReferenceDispatcher(ReferenceSettings{
		Provider: "webhook", Destinations: map[string]string{"review-a": server.URL},
		AllowLocalHTTP: true, WebhookSigningSecret: webhookSecret,
	}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := dispatcher.Dispatch(context.Background(), DeliveryRequestV1{
		DeliveryID: testDeliveryID, DestinationRef: "review-a", Event: fixtureEvent(t, false),
	}); err != nil {
		t.Fatal(err)
	}
	if !cryptoutil.VerifyTimestampSignature(
		[]byte(webhookSecret), timestamp, signature, body, now, 5*time.Minute,
	) {
		t.Fatalf("timestamp=%q signature=%q body=%s", timestamp, signature, body)
	}
}

func TestRuntimeSeparateProcessSmokeAndRestartReplay(t *testing.T) {
	if os.Getenv("FEEDBACK_CONNECTOR_CHILD") == "1" {
		runRuntimeChild(t)
		return
	}
	directory := t.TempDir()
	addressFile := filepath.Join(directory, "address")
	idFile := filepath.Join(directory, "ids")
	marker := filepath.Join(directory, "dispatches")
	start := func() (*exec.Cmd, string) {
		_ = os.Remove(addressFile)
		command := exec.Command(os.Args[0], "-test.run=^TestRuntimeSeparateProcessSmokeAndRestartReplay$")
		command.Env = append(os.Environ(),
			"FEEDBACK_CONNECTOR_CHILD=1", "FEEDBACK_CONNECTOR_ADDRESS_FILE="+addressFile,
			"FEEDBACK_CONNECTOR_ID_FILE="+idFile, "FEEDBACK_CONNECTOR_MARKER="+marker,
		)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			raw, err := os.ReadFile(addressFile)
			if err == nil && len(raw) != 0 {
				return command, "http://" + string(raw)
			}
			time.Sleep(10 * time.Millisecond)
		}
		_ = command.Process.Kill()
		t.Fatal("child runtimeが起動しません")
		return nil, ""
	}
	command, endpoint := start()
	dispatcher := NewHTTPDispatcher(
		EndpointPolicy{AllowLocalHTTP: true}, &http.Client{}, 2*time.Second,
		func() time.Time { return time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC) },
	)
	delivery := claimedFixture(endpoint + "/connector/v1/deliveries")
	result := dispatcher.Dispatch(context.Background(), delivery)
	if result.Error != "" || result.ResponseStatus == nil || *result.ResponseStatus != 202 {
		t.Fatalf("separate process result=%+v", result)
	}
	_ = command.Process.Kill()
	_, _ = command.Process.Wait()
	command, endpoint = start()
	delivery.DeliveryURL = endpoint + "/connector/v1/deliveries"
	result = dispatcher.Dispatch(context.Background(), delivery)
	if result.Error != "" || result.ResponseStatus == nil || *result.ResponseStatus != 200 {
		t.Fatalf("restart replay result=%+v", result)
	}
	_ = command.Process.Kill()
	_, _ = command.Process.Wait()
	raw, err := os.ReadFile(marker)
	if err != nil || strings.Count(string(raw), testDeliveryID) != 1 {
		t.Fatalf("dispatch marker=%q err=%v", raw, err)
	}
}

func runRuntimeChild(t *testing.T) {
	store, err := NewFileDeliveryIDStore(os.Getenv("FEEDBACK_CONNECTOR_ID_FILE"), 100)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewRuntime(
		RuntimeSettings{Provider: "webhook", DisplayName: "Webhook", SharedSecret: testSecret},
		referenceFunc(func(_ context.Context, delivery DeliveryRequestV1) error {
			file, err := os.OpenFile(os.Getenv("FEEDBACK_CONNECTOR_MARKER"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer file.Close()
			_, err = file.WriteString(delivery.DeliveryID + "\n")
			return err
		}), store, func() time.Time { return time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC) },
	)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("FEEDBACK_CONNECTOR_ADDRESS_FILE"), []byte(listener.Addr().String()), 0o600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatal(err)
	}
}

func runtimeFixture(t *testing.T, forbidden bool) []byte {
	t.Helper()
	event := fixtureEvent(t, forbidden)
	body, err := json.Marshal(DeliveryRequestV1{
		Kind: "delivery-request", ProtocolVersion: "1", DeliveryID: testDeliveryID,
		EventID: testEventID, DestinationRef: "review-a", OccurredAt: "2026-08-09T00:00:00Z", Event: event,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func fixtureEvent(t *testing.T, forbidden bool) json.RawMessage {
	t.Helper()
	event := map[string]any{
		"schemaVersion": "1", "eventId": testEventID, "requestId": "connector-runtime-test",
		"eventType": "feedback.message.created.v1", "occurredAt": "2026-08-09T00:00:00Z",
		"tenantKey": "tenant-a", "applicationKey": "app-a", "environmentKey": "production",
		"externalWorkspaceKey": "workspace-a", "sessionId": "00000000-0000-4000-8000-000000000033",
		"threadId": "00000000-0000-4000-8000-000000000034",
		"actor":    map[string]any{"principalId": "principal-a", "displayName": "テスト担当者", "participantName": nil},
		"body":     "secret body", "deepLink": "https://deep.example/thread", "evidenceUrl": nil,
	}
	if forbidden {
		event["token"] = "外部へ出してはいけない値"
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func claimedFixture(endpoint string) ClaimedDelivery {
	event := map[string]any{
		"schemaVersion": "1", "eventId": testEventID, "requestId": "connector-runtime-test",
		"eventType": "feedback.message.created.v1", "occurredAt": "2026-08-09T00:00:00Z",
		"tenantKey": "tenant-a", "applicationKey": "app-a", "environmentKey": "production",
		"externalWorkspaceKey": "workspace-a", "sessionId": "00000000-0000-4000-8000-000000000033",
		"threadId": "00000000-0000-4000-8000-000000000034",
		"actor":    map[string]any{"principalId": "principal-a", "displayName": "テスト担当者", "participantName": nil},
		"deepLink": "https://deep.example/thread", "body": "secret body",
		"evidenceUrl": "https://forbidden", "objectKey": "private/object",
	}
	raw, _ := json.Marshal(event)
	return ClaimedDelivery{
		ID: testDeliveryID, EventID: testEventID, Event: raw, Attempt: 1,
		DestinationRef: "review-a", DeliveryURL: endpoint, SigningSecret: testSecret,
		TenantID: "tenant-id", AllowedHosts: map[string]struct{}{"127.0.0.1": {}},
	}
}

func sendRuntime(t *testing.T, base string, body []byte, now time.Time, secret, deliveryID string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, base+"/connector/v1/deliveries", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Feedback-Delivery-Id", deliveryID)
	request.Header.Set("X-Feedback-Timestamp", fmtInt(now.Unix()))
	request.Header.Set("X-Feedback-Signature", cryptoutil.SignTimestamp([]byte(secret), now.Unix(), body))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func fmtInt(value int64) string { return strconvFormatInt(value) }

type referenceFunc func(context.Context, DeliveryRequestV1) error

func (f referenceFunc) Dispatch(ctx context.Context, delivery DeliveryRequestV1) error {
	return f(ctx, delivery)
}

type memoryStore struct {
	mutex  sync.Mutex
	values map[string]bool
}

func (s *memoryStore) Contains(id string) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.values[id], nil
}

func (s *memoryStore) Add(id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.values[id] = true
	return nil
}

type staticResolver struct{ addresses []net.IPAddr }

func (r staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.addresses, nil
}

type recordingMailSender struct{ sent []MailDelivery }

func (s *recordingMailSender) Send(_ context.Context, delivery MailDelivery) error {
	s.sent = append(s.sent, delivery)
	return nil
}

func intPointer(value int) *int { return &value }

func sameStatus(left, right *int) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func ioReadAll(request *http.Request) ([]byte, error) { return io.ReadAll(request.Body) }

func fmtSscanfPath(path string, value *int) (int, error) { return fmt.Sscanf(path, "/%d", value) }

func serverURLForRedirect(request *http.Request) string { return "http://" + request.Host }

func strconvFormatInt(value int64) string { return strconv.FormatInt(value, 10) }
