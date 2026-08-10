package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestAuthenticationMiddlewareReturnsAuditedProblem(t *testing.T) {
	t.Parallel()
	authenticator := &fakeBearerAuthenticator{err: auth.ErrInvalidToken}
	handler := RequestIDMiddleware(func() (string, error) { return "generated-request-id", nil })(
		AuthenticationMiddleware(authenticator)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("未認証requestがhandlerへ到達しました")
		})),
	)
	request := httptest.NewRequest(http.MethodGet, "/feedback/v1/me", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || response.Header().Get("Content-Type") != problemContentType {
		t.Fatalf("status=%d content-type=%q body=%s", response.Code, response.Header().Get("Content-Type"), response.Body)
	}
	var problem Problem
	if err := json.Unmarshal(response.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Type != "/problems/authentication-required" || problem.Title != "認証が必要です" ||
		problem.Code != "auth.required" || problem.RequestID != "generated-request-id" {
		t.Fatalf("problem = %+v", problem)
	}
	if authenticator.calls != 1 || authenticator.rawToken != "" || authenticator.requestID != "generated-request-id" {
		t.Fatalf("authenticator = %+v", authenticator)
	}
}

func TestAuthenticationMiddlewareAcceptsOneBearerAndExemptsCapabilities(t *testing.T) {
	t.Parallel()
	authenticator := &fakeBearerAuthenticator{principal: auth.Principal{UserID: "user-id", Subject: "subject"}}
	reached := false
	handler := AuthenticationMiddleware(authenticator)(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		reached = true
		if request.URL.Path == "/feedback/v1/me" {
			principal, err := PrincipalFromContext(request.Context())
			if err != nil || principal.Subject != "subject" {
				t.Fatalf("principal=%+v err=%v", principal, err)
			}
		}
	}))
	request := httptest.NewRequest(http.MethodGet, "/feedback/v1/me", nil)
	request.Header.Set("Authorization", "Bearer token-value")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if !reached || authenticator.rawToken != "token-value" || authenticator.calls != 1 {
		t.Fatalf("reached=%v authenticator=%+v", reached, authenticator)
	}

	reached = false
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/feedback/v1/capabilities", nil))
	if !reached || authenticator.calls != 1 {
		t.Fatal("capabilitiesで認証が実行されました")
	}
}

func TestETagParserMatchesKotlinContract(t *testing.T) {
	t.Parallel()
	for _, value := range []string{`"v1"`, `W/"v42"`} {
		if _, err := parseETag(value); err != nil {
			t.Fatalf("parseETag(%q) error = %v", value, err)
		}
	}
	for _, value := range []string{"v1", `"v0"`, `"v01"`, `w/"v1"`, `"v999999999999999999999999999"`} {
		if _, err := parseETag(value); err == nil {
			t.Fatalf("parseETag(%q)が不正値を受理しました", value)
		}
	}
}

func TestMapServiceErrorHidesIndividualResource(t *testing.T) {
	t.Parallel()
	mapped := mapServiceError(&auth.AuthorizationError{HideExistence: true})
	var apiError *APIError
	if !errors.As(mapped, &apiError) || apiError.Status != http.StatusNotFound || apiError.Problem.Code != "resource.not_found" {
		t.Fatalf("mapped = %#v", mapped)
	}
}

func TestProductionAPIRejectsPartialWiring(t *testing.T) {
	t.Parallel()
	handler, err := NewAPIHandler(&usecase.Service{})
	if err != nil {
		t.Fatal(err)
	}
	err = handler.ValidateComplete()
	if err == nil || !strings.Contains(err.Error(), "sessions") || !strings.Contains(err.Error(), "retention") ||
		!strings.Contains(err.Error(), "discussion-settings") {
		t.Fatalf("partial wiring error = %v", err)
	}
}

type fakeBearerAuthenticator struct {
	principal auth.Principal
	err       error
	calls     int
	rawToken  string
	requestID string
}

func (value *fakeBearerAuthenticator) Authenticate(
	_ context.Context,
	rawToken string,
	requestID string,
) (auth.Principal, error) {
	value.calls++
	value.rawToken = rawToken
	value.requestID = requestID
	return value.principal, value.err
}
