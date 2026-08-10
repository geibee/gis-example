package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteErrorUsesFrozenProblemShape(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet, "/feedback/v1/me", nil)
	request = request.WithContext(WithLogFields(request.Context(), LogFields{RequestID: "request-1"}))
	recorder := httptest.NewRecorder()
	apiError := NewAPIError(http.StatusTooManyRequests, "/problems/rate_limit.exceeded", "rate_limit.exceeded", "上限です")
	apiError.Header.Set("Retry-After", "60")
	WriteError(recorder, request, apiError)

	if recorder.Code != http.StatusTooManyRequests || recorder.Header().Get("Content-Type") != problemContentType {
		t.Fatalf("status/content-typeが不正です: %d %q", recorder.Code, recorder.Header().Get("Content-Type"))
	}
	if recorder.Header().Get("Retry-After") != "60" {
		t.Fatal("API error headerが欠落しました")
	}
	var problem Problem
	if err := json.Unmarshal(recorder.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Status != 429 || problem.Code != "rate_limit.exceeded" || problem.RequestID != "request-1" || problem.Detail == nil {
		t.Fatalf("Problem Detailsが不正です: %+v", problem)
	}
}

func TestProblemFromErrorDoesNotExposeInternalError(t *testing.T) {
	t.Parallel()
	validation := ProblemFromError(&ValidationError{Code: "request.invalid_json", Message: "bad json"})
	if validation.Status != 400 || validation.Problem.Type != "/problems/request.invalid-json" {
		t.Fatalf("validation mappingが不正です: %+v", validation)
	}
	internal := ProblemFromError(errors.New("secret database password"))
	if internal.Status != 500 || internal.Problem.Detail != nil || strings.Contains(internal.Error(), "password") {
		t.Fatalf("内部errorが公開されました: %+v", internal)
	}
}

func TestDecodeJSONRequestStrictMatrix(t *testing.T) {
	t.Parallel()
	type payload struct {
		Name string `json:"name"`
	}
	tests := []struct {
		name       string
		body       string
		maximum    int64
		wantStatus int
	}{
		{name: "valid", body: `{"name":"ok"}`, maximum: 100},
		{name: "empty", body: ``, maximum: 100, wantStatus: 400},
		{name: "null", body: `null`, maximum: 100, wantStatus: 400},
		{name: "unknown field", body: `{"name":"ok","unknown":1}`, maximum: 100, wantStatus: 400},
		{name: "trailing value", body: `{"name":"ok"}{}`, maximum: 100, wantStatus: 400},
		{name: "too large", body: `{"name":"0123456789"}`, maximum: 5, wantStatus: 413},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			var decoded payload
			err := DecodeJSONRequest(request, &decoded, test.maximum)
			if test.wantStatus == 0 {
				if err != nil || decoded.Name != "ok" {
					t.Fatalf("valid JSONをdecodeできません: %+v %v", decoded, err)
				}
				return
			}
			var apiError *APIError
			if !errors.As(err, &apiError) || apiError.Status != test.wantStatus {
				t.Fatalf("期待status=%d, error=%v", test.wantStatus, err)
			}
		})
	}
}

func TestRecoveryMiddlewareWritesProblemAndLogsPanic(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := RequestIDMiddleware(func() (string, error) { return "recovery-request", nil })(
		RecoveryMiddleware(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("database-password-must-not-leak")
		})),
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != 500 || !strings.Contains(recorder.Body.String(), `"requestId":"recovery-request"`) {
		t.Fatalf("recovery responseが不正です: %d %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "database-password") == true {
		t.Fatal("panic detailがresponseへ漏洩しました")
	}
	if !strings.Contains(logs.String(), "database-password") || !strings.Contains(logs.String(), "recovery-request") {
		t.Fatalf("panicの内部logが不足しています: %s", logs.String())
	}
}

func TestRecoveryMiddlewareDoesNotCorruptCommittedResponse(t *testing.T) {
	t.Parallel()
	handler := RecoveryMiddleware(nil)(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte("accepted"))
		panic("late panic")
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusAccepted || recorder.Body.String() != "accepted" {
		t.Fatalf("commit済みresponseを破損しました: %d %q", recorder.Code, recorder.Body.String())
	}
}
