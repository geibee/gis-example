package httpapi_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	sessiondomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

func TestRuntimeHTTPFoundationAgainstPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	runID := os.Getenv("FEEDBACK_TEST_RUN_ID")
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,20}$`).MatchString(runID) {
		t.Fatal("FEEDBACK_TEST_RUN_IDは21文字以下の小文字英数字・hyphenで指定してください")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL:      databaseURL,
		User:     requiredHTTPIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER"),
		Password: requiredHTTPIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD"),
		PoolSize: 4, ConnectionTimeout: 5 * time.Second, StatementTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}

	applicationKey := "http-" + runID
	tenantKey := "tenant-http-" + runID
	workspaceKey := "workspace-http-" + runID
	issuer := "https://http-issuer-" + runID + ".example"
	subject := "http-subject-" + runID
	displayName := "HTTP統合利用者"
	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runner.Run(ctx, bootstrap.Input{
		TenantKey: tenantKey, TenantDisplayName: "HTTP統合テナント",
		ApplicationKey: applicationKey, ApplicationDisplayName: "HTTP統合アプリ",
		EnvironmentKey: "test", EnvironmentBaseURL: "https://app.example",
		AllowedOrigins: []string{"https://app.example"}, ExternalWorkspaceKey: workspaceKey,
		WorkspaceDisplayName: "HTTP統合workspace", Issuer: issuer, Subject: subject,
		DisplayName: &displayName, Permissions: []bootstrap.Permission{auth.PermissionAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupHTTPIntegration(t, database, created, runID)

	keys := newHTTPJWTKeys(t, "http-key-"+runID)
	verifier, err := auth.NewDirectVerifier(config.OIDCSettings{
		Issuer: issuer, Audience: "feedback-service", SubjectClaim: "sub",
		DisplayNameClaim: "name", EmailClaim: "email",
	}, auth.KeySetSourceFunc(func(context.Context, bool) (jwk.Set, error) {
		return keys.publicSet, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	authenticator, err := auth.NewAuthenticator(verifier, nil, database, database)
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
	sessionService, err := sessiondomain.NewService(database, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	storage, err := objectstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	evidenceService, err := evidence.NewService(database, storage, authorizer, evidence.Settings{
		KeyPrefix: "evidence/", MaximumBytes: 1024,
		StorageTimeout: 2 * time.Second, OrphanGrace: 5 * time.Minute, DeleteAttempts: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	discussionService, err := discussion.NewService(database, evidenceService, 10)
	if err != nil {
		t.Fatal(err)
	}
	api, err := httpapi.NewAPIHandler(
		service,
		httpapi.WithSessionAPI(sessionService, database),
		httpapi.WithDiscussionAPI(discussionService, database, authorizer, database, httpapi.DiscussionAPISettings{
			EvidenceMaximumBytes: 1024, PrincipalLimitPerMinute: 100,
			TenantLimitPerMinute: 100, IPLimitPerMinute: 100,
		}),
		httpapi.WithEvidenceAPI(evidenceService),
	)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	contract.HandlerWithOptions(api, contract.StdHTTPServerOptions{BaseURL: "/feedback/v1", BaseRouter: mux})
	server := httptest.NewServer(httpapi.RequestIDMiddleware(nil)(httpapi.AuthenticationMiddleware(authenticator)(mux)))
	defer server.Close()

	validToken := keys.sign(t, issuer, "feedback-service", subject, map[string]any{"name": displayName})
	assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/capabilities", "", nil, http.StatusOK, "")
	assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/me", "", nil, http.StatusUnauthorized, "http-"+runID+"-missing")
	wrongAudience := keys.sign(t, issuer, "another-service", subject, nil)
	assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/me", wrongAudience, nil, http.StatusUnauthorized, "http-"+runID+"-audience")

	me := assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/me", validToken, nil, http.StatusOK, "http-"+runID+"-me")
	var meValue usecase.Me
	if err := json.Unmarshal(me, &meValue); err != nil {
		t.Fatal(err)
	}
	if meValue.Participant.PrincipalID != subject || meValue.Participant.DisplayName == nil || *meValue.Participant.DisplayName != displayName ||
		len(meValue.Memberships) != 1 || meValue.Memberships[0].Permissions[0] != auth.PermissionAdmin {
		t.Fatalf("me = %+v", meValue)
	}

	manifest := []byte(fmt.Sprintf(`{"schemaVersion":"1","applicationKey":%q,"displayName":"HTTP統合アプリ","manifestVersion":"v1","routes":[{"pageKey":"home","template":"/","label":"ホーム"}]}`, applicationKey))
	putBody, putHeader := assertHTTPResponse(t, server.Client(), http.MethodPut, server.URL+"/feedback/v1/applications/"+applicationKey+"/manifest", validToken, manifest, http.StatusOK, "http-"+runID+"-put", nil)
	if putHeader.Get("ETag") != `"v1"` || !equalHTTPJSON(putBody, manifest) {
		t.Fatalf("manifest PUT: etag=%q body=%s", putHeader.Get("ETag"), putBody)
	}
	getBody, getHeader := assertHTTPResponse(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/applications/"+applicationKey+"/manifest", validToken, nil, http.StatusOK, "http-"+runID+"-get", nil)
	if getHeader.Get("ETag") != "" || !equalHTTPJSON(getBody, manifest) {
		t.Fatalf("manifest GET: etag=%q body=%s", getHeader.Get("ETag"), getBody)
	}

	query := url.Values{
		"applicationKey": {applicationKey}, "environmentKey": {"test"},
		"externalWorkspaceKey": {workspaceKey}, "release": {"v1"},
		"pageKey": {"home"}, "routeTemplate": {"/"}, "pathParameters": {"{}"},
	}
	reviewBody := assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/review-context?"+query.Encode(), validToken, nil, http.StatusOK, "http-"+runID+"-context")
	var review usecase.ReviewContext
	if err := json.Unmarshal(reviewBody, &review); err != nil {
		t.Fatal(err)
	}
	if review.Session != nil || review.Scope != "excluded" || review.Posting != "deny" {
		t.Fatalf("review context = %+v", review)
	}

	sessionRequest := []byte(fmt.Sprintf(`{
      "applicationKey":%q,"environmentKey":"test","externalWorkspaceKey":%q,
      "manifestVersion":"v1","title":"HTTP session","description":null,
      "scopes":[{"pageKey":"home","routeTemplate":null,"reviewable":true}],
		"perspectives":[{"code":"ux","label":"UX","status":"active","guidance":null}]
    }`, applicationKey, workspaceKey))
	createHeaders := make(http.Header)
	createHeaders.Set("Idempotency-Key", "http-session-key-"+runID)
	createdBody, createdHeader := assertHTTPResponse(
		t, server.Client(), http.MethodPost, server.URL+"/feedback/v1/sessions",
		validToken, sessionRequest, http.StatusCreated, "http-"+runID+"-session-create", createHeaders,
	)
	var createdSession sessiondomain.Session
	if err := json.Unmarshal(createdBody, &createdSession); err != nil {
		t.Fatal(err)
	}
	if createdHeader.Get("ETag") != `"v1"` || createdSession.Version != 1 || createdSession.Description != nil {
		t.Fatalf("session create: header=%v body=%+v", createdHeader, createdSession)
	}
	sessionQuery := url.Values{
		"applicationKey": {applicationKey}, "environmentKey": {"test"},
		"externalWorkspaceKey": {workspaceKey}, "limit": {"1"},
	}
	listBody := assertHTTPStatus(
		t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/sessions?"+sessionQuery.Encode(),
		validToken, nil, http.StatusOK, "http-"+runID+"-session-list",
	)
	var page sessiondomain.Page
	if err := json.Unmarshal(listBody, &page); err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != 1 || len(page.Items) != 1 || page.NextCursor != nil {
		t.Fatalf("session list = %+v", page)
	}
	getSessionBody, getSessionHeader := assertHTTPResponse(
		t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/sessions/"+createdSession.ID,
		validToken, nil, http.StatusOK, "http-"+runID+"-session-get", nil,
	)
	if getSessionHeader.Get("ETag") != `"v1"` || !equalHTTPJSON(getSessionBody, createdBody) {
		t.Fatalf("session get: etag=%q body=%s", getSessionHeader.Get("ETag"), getSessionBody)
	}
	patchHeaders := make(http.Header)
	patchHeaders.Set("If-Match", `"v1"`)
	patchHeaders.Set("Content-Type", "application/merge-patch+json")
	patchedBody, patchedHeader := assertHTTPResponse(
		t, server.Client(), http.MethodPatch, server.URL+"/feedback/v1/sessions/"+createdSession.ID,
		validToken, []byte(`{"status":"open","description":null}`), http.StatusOK,
		"http-"+runID+"-session-patch", patchHeaders,
	)
	var patchedSession sessiondomain.Session
	if err := json.Unmarshal(patchedBody, &patchedSession); err != nil {
		t.Fatal(err)
	}
	if patchedHeader.Get("ETag") != `"v2"` || patchedSession.Version != 2 || patchedSession.Status != "open" {
		t.Fatalf("session patch: header=%v body=%+v", patchedHeader, patchedSession)
	}
	_, _ = assertHTTPResponse(
		t, server.Client(), http.MethodPatch, server.URL+"/feedback/v1/sessions/"+createdSession.ID,
		validToken, []byte(`{"title":"stale"}`), http.StatusPreconditionFailed,
		"http-"+runID+"-session-stale", patchHeaders,
	)

	threadRequest := []byte(`{
      "location":{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}},
      "target":{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.25},
      "perspectiveCode":"ux","body":"最初のメッセージ","participantName":null,
      "evidence":{"contentType":"image/png","dataBase64":"iVBORw0KGgo=","viewportWidth":800,
        "viewportHeight":600,"pixelRatio":2,"capturedAt":"2026-08-09T12:34:56Z"}
    }`)
	threadHeaders := make(http.Header)
	threadHeaders.Set("Idempotency-Key", "http-thread-key-"+runID)
	threadBody, threadResponseHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodPost,
		server.URL+"/feedback/v1/sessions/"+createdSession.ID+"/threads",
		validToken, threadRequest, http.StatusCreated, "http-"+runID+"-thread-create", threadHeaders,
	)
	var createdThread discussion.Thread
	if err := json.Unmarshal(threadBody, &createdThread); err != nil {
		t.Fatal(err)
	}
	if threadResponseHeaders.Get("ETag") != `"v1"` || createdThread.DisplayNumber != 1 ||
		!createdThread.EvidenceAvailable || len(createdThread.Messages) != 1 {
		t.Fatalf("thread create: header=%v body=%+v", threadResponseHeaders, createdThread)
	}
	threadListBody := assertHTTPStatus(
		t, server.Client(), http.MethodGet,
		server.URL+"/feedback/v1/sessions/"+createdSession.ID+"/threads?limit=1",
		validToken, nil, http.StatusOK, "http-"+runID+"-thread-list",
	)
	var threadPage discussion.ThreadPage
	if err := json.Unmarshal(threadListBody, &threadPage); err != nil {
		t.Fatal(err)
	}
	if threadPage.TotalCount != 1 || len(threadPage.Items) != 1 || threadPage.NextCursor != nil {
		t.Fatalf("thread list = %+v", threadPage)
	}
	deepLinkBody := assertHTTPStatus(
		t, server.Client(), http.MethodGet,
		server.URL+"/feedback/v1/threads/"+createdThread.ID+"/deep-link",
		validToken, nil, http.StatusOK, "http-"+runID+"-thread-link",
	)
	var deepLink struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(deepLinkBody, &deepLink); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(deepLink.URL, "https://app.example/") || !strings.Contains(deepLink.URL, createdThread.ID) {
		t.Fatalf("deep link = %s", deepLink.URL)
	}
	evidenceBody, evidenceHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodGet,
		server.URL+"/feedback/v1/threads/"+createdThread.ID+"/evidence",
		validToken, nil, http.StatusOK, "http-"+runID+"-evidence-get", nil,
	)
	if string(evidenceBody) != string([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}) ||
		evidenceHeaders.Get("Content-Type") != "image/png" || evidenceHeaders.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("evidence get: header=%v body=%x", evidenceHeaders, evidenceBody)
	}
	rangeHeaders := make(http.Header)
	rangeHeaders.Set("Range", "bytes=1-3")
	rangeBody, rangeResponseHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodGet,
		server.URL+"/feedback/v1/threads/"+createdThread.ID+"/evidence",
		validToken, nil, http.StatusPartialContent, "http-"+runID+"-evidence-range", rangeHeaders,
	)
	if len(rangeBody) != 3 || rangeResponseHeaders.Get("Content-Range") != "bytes 1-3/8" {
		t.Fatalf("evidence range: header=%v body=%x", rangeResponseHeaders, rangeBody)
	}

	messageHeaders := make(http.Header)
	messageHeaders.Set("Idempotency-Key", "http-message-key-"+runID)
	messageBody, messageResponseHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodPost,
		server.URL+"/feedback/v1/threads/"+createdThread.ID+"/messages",
		validToken, []byte(`{"body":"返信","participantName":null}`), http.StatusCreated,
		"http-"+runID+"-message-create", messageHeaders,
	)
	var createdMessage discussion.Message
	if err := json.Unmarshal(messageBody, &createdMessage); err != nil {
		t.Fatal(err)
	}
	if messageResponseHeaders.Get("ETag") != `"v1"` || createdMessage.Version != 1 {
		t.Fatalf("message create: header=%v body=%+v", messageResponseHeaders, createdMessage)
	}
	messagePatchHeaders := make(http.Header)
	messagePatchHeaders.Set("If-Match", `"v1"`)
	messagePatchHeaders.Set("Content-Type", "application/merge-patch+json")
	patchedMessageBody, patchedMessageHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodPatch,
		server.URL+"/feedback/v1/messages/"+createdMessage.ID,
		validToken, []byte(`{"body":"編集済み","participantName":"担当者"}`), http.StatusOK,
		"http-"+runID+"-message-patch", messagePatchHeaders,
	)
	var patchedMessage discussion.Message
	if err := json.Unmarshal(patchedMessageBody, &patchedMessage); err != nil {
		t.Fatal(err)
	}
	if patchedMessageHeaders.Get("ETag") != `"v2"` || patchedMessage.Version != 2 || patchedMessage.EditedAt == nil {
		t.Fatalf("message patch: header=%v body=%+v", patchedMessageHeaders, patchedMessage)
	}
	versionsBody := assertHTTPStatus(
		t, server.Client(), http.MethodGet,
		server.URL+"/feedback/v1/messages/"+createdMessage.ID+"/versions",
		validToken, nil, http.StatusOK, "http-"+runID+"-message-versions",
	)
	var versions []discussion.MessageVersion
	if err := json.Unmarshal(versionsBody, &versions); err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 || versions[0].Current || !versions[1].Current {
		t.Fatalf("message versions = %+v", versions)
	}
	latestThreadBody, latestThreadHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/threads/"+createdThread.ID,
		validToken, nil, http.StatusOK, "http-"+runID+"-thread-get", nil,
	)
	var latestThread discussion.Thread
	if err := json.Unmarshal(latestThreadBody, &latestThread); err != nil {
		t.Fatal(err)
	}
	if latestThreadHeaders.Get("ETag") != `"v3"` || latestThread.Version != 3 {
		t.Fatalf("thread version after messages: header=%v body=%+v", latestThreadHeaders, latestThread)
	}
	threadStatusHeaders := make(http.Header)
	threadStatusHeaders.Set("If-Match", `"v3"`)
	threadStatusHeaders.Set("Content-Type", "application/merge-patch+json")
	resolvedBody, resolvedHeaders := assertHTTPResponse(
		t, server.Client(), http.MethodPatch,
		server.URL+"/feedback/v1/threads/"+createdThread.ID+"/status",
		validToken, []byte(`{"status":"resolved"}`), http.StatusOK,
		"http-"+runID+"-thread-resolve", threadStatusHeaders,
	)
	var resolved discussion.Thread
	if err := json.Unmarshal(resolvedBody, &resolved); err != nil {
		t.Fatal(err)
	}
	if resolvedHeaders.Get("ETag") != `"v4"` || resolved.Status != "resolved" || resolved.Version != 4 {
		t.Fatalf("thread resolve: header=%v body=%+v", resolvedHeaders, resolved)
	}
	var journalCount, outboxCount int
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.feedback_change_journal WHERE workspace_id = $1::uuid`, created.WorkspaceID).Scan(&journalCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(ctx, `SELECT count(*) FROM feedback.notification_outbox WHERE workspace_id = $1::uuid`, created.WorkspaceID).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if journalCount != 4 || outboxCount != 3 {
		t.Fatalf("journal/outbox count = %d/%d", journalCount, outboxCount)
	}

	if _, err := database.Exec(ctx, `UPDATE feedback.application_memberships SET permissions = ARRAY['feedback.read']::text[] WHERE application_id = $1::uuid AND user_id = $2::uuid`, created.ApplicationID, created.PrincipalID); err != nil {
		t.Fatal(err)
	}
	assertHTTPStatus(t, server.Client(), http.MethodPut, server.URL+"/feedback/v1/applications/"+applicationKey+"/manifest", validToken, []byte(`{"not":"a manifest"}`), http.StatusNotFound, "http-"+runID+"-permission")

	if _, err := database.Exec(ctx, `UPDATE feedback.application_environments SET allowed_issuers = ARRAY[]::text[] WHERE id = $1::uuid`, created.EnvironmentID); err != nil {
		t.Fatal(err)
	}
	assertHTTPStatus(t, server.Client(), http.MethodGet, server.URL+"/feedback/v1/applications/"+applicationKey+"/manifest", validToken, nil, http.StatusNotFound, "http-"+runID+"-issuer")
}

type httpJWTKeys struct {
	privateKey jwk.Key
	publicSet  jwk.Set
}

func newHTTPJWTKeys(t *testing.T, keyID string) httpJWTKeys {
	t.Helper()
	rawKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := jwk.Import(rawKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := jwk.Import(&rawKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []jwk.Key{privateKey, publicKey} {
		if err := key.Set(jwk.KeyIDKey, keyID); err != nil {
			t.Fatal(err)
		}
		if err := key.Set(jwk.AlgorithmKey, jwa.RS256()); err != nil {
			t.Fatal(err)
		}
	}
	set := jwk.NewSet()
	if err := set.AddKey(publicKey); err != nil {
		t.Fatal(err)
	}
	return httpJWTKeys{privateKey: privateKey, publicSet: set}
}

func (keys httpJWTKeys) sign(t *testing.T, issuer, audience, subject string, claims map[string]any) string {
	t.Helper()
	now := time.Now().UTC()
	token, err := jwt.NewBuilder().Issuer(issuer).Audience([]string{audience}).Subject(subject).
		IssuedAt(now.Add(-time.Second)).Expiration(now.Add(5 * time.Minute)).Build()
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range claims {
		if err := token.Set(name, value); err != nil {
			t.Fatal(err)
		}
	}
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.RS256(), keys.privateKey))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func assertHTTPStatus(t *testing.T, client *http.Client, method, endpoint, token string, body []byte, status int, requestID string) []byte {
	t.Helper()
	contents, _ := assertHTTPResponse(t, client, method, endpoint, token, body, status, requestID, nil)
	return contents
}

func assertHTTPResponse(t *testing.T, client *http.Client, method, endpoint, token string, body []byte, status int, requestID string, headers http.Header) ([]byte, http.Header) {
	t.Helper()
	request, err := http.NewRequest(method, endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if requestID != "" {
		request.Header.Set("X-Request-ID", requestID)
	}
	for name, values := range headers {
		request.Header[name] = values
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, endpoint, response.StatusCode, status, contents)
	}
	return contents, response.Header.Clone()
}

func equalHTTPJSON(left, right []byte) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil &&
		fmt.Sprintf("%#v", leftValue) == fmt.Sprintf("%#v", rightValue)
}

func cleanupHTTPIntegration(t *testing.T, database *postgres.Database, created bootstrap.Result, runID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := database.Exec(ctx, `DELETE FROM feedback.audit_logs WHERE request_id LIKE $1`, "http-"+runID+"-%"); err != nil {
		t.Logf("audit cleanup: %v", err)
	}
	if _, err := database.Exec(ctx, `DELETE FROM feedback.tenants WHERE id = $1::uuid`, created.TenantID); err != nil {
		t.Logf("tenant cleanup: %v", err)
	}
	if _, err := database.Exec(ctx, `DELETE FROM feedback.users WHERE id = $1::uuid`, created.PrincipalID); err != nil {
		t.Logf("user cleanup: %v", err)
	}
}

func requiredHTTPIntegrationEnvironment(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%sが必要です", name)
	}
	return value
}
