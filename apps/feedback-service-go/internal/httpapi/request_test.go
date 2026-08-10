package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestValidRequestIDMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		value string
		valid bool
	}{
		{value: "a", valid: true},
		{value: "ABC-123_.:xyz", valid: true},
		{value: strings.Repeat("a", 200), valid: true},
		{value: "", valid: false},
		{value: strings.Repeat("a", 201), valid: false},
		{value: "with space", valid: false},
		{value: "日本語", valid: false},
		{value: "line\nbreak", valid: false},
	}
	for _, test := range tests {
		if actual := ValidRequestID(test.value); actual != test.valid {
			t.Errorf("ValidRequestID(%q)=%t, want %t", test.value, actual, test.valid)
		}
	}
}

func TestGenerateRequestIDReturnsValidUUIDV4Shape(t *testing.T) {
	t.Parallel()
	requestID, err := GenerateRequestID()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(requestID, "-")
	if !ValidRequestID(requestID) || len(parts) != 5 ||
		len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 ||
		parts[2][0] != '4' || !strings.Contains("89ab", parts[3][0:1]) {
		t.Fatalf("UUID v4形式ではありません: %q", requestID)
	}
}

func TestRequestIDMiddlewarePreservesOrReplaces(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		incoming string
		want     string
	}{
		{name: "preserve", incoming: "client-request:1", want: "client-request:1"},
		{name: "generate missing", want: "generated-request"},
		{name: "replace invalid", incoming: "invalid request", want: "generated-request"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			handler := RequestIDMiddleware(func() (string, error) { return "generated-request", nil })(
				http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
					_, _ = writer.Write([]byte(RequestIDFromContext(request.Context())))
				}),
			)
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set(requestIDHeader, test.incoming)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Header().Get(requestIDHeader) != test.want || recorder.Body.String() != test.want {
				t.Fatalf("request ID引継ぎが不正です: header=%q body=%q", recorder.Header().Get(requestIDHeader), recorder.Body.String())
			}
		})
	}
}

func TestRequestIDMiddlewareFailsClosedWhenGeneratorFails(t *testing.T) {
	t.Parallel()
	called := false
	handler := RequestIDMiddleware(func() (string, error) { return "", errors.New("entropy unavailable") })(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }),
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if called || recorder.Code != 500 || recorder.Header().Get("Content-Type") != problemContentType {
		t.Fatalf("generator障害をfail-closedにできません: called=%t status=%d", called, recorder.Code)
	}
}

func TestAccessLogIncludesStableContextFields(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	times := []time.Time{time.Unix(0, 0), time.Unix(0, int64(15*time.Millisecond))}
	index := 0
	handler := RequestIDMiddleware(func() (string, error) { return "access-request", nil })(
		AccessLogMiddleware(AccessLogOptions{
			Logger: logger,
			Now: func() time.Time {
				value := times[index]
				index++
				return value
			},
		})(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			_ = WithLogFields(request.Context(), LogFields{
				Tenant: "tenant-a", Application: "app-a", Environment: "prod",
				Workspace: "workspace-a", EventID: "event-a",
			})
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte("ok"))
		})),
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/feedback/v1/threads?secret=x", nil))
	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"requestId": "access-request", "tenant": "tenant-a", "application": "app-a",
		"environment": "prod", "workspace": "workspace-a", "eventId": "event-a",
		"httpMethod": "POST", "httpPath": "/feedback/v1/threads",
	} {
		if record[key] != want {
			t.Errorf("log[%s]=%v, want %v", key, record[key], want)
		}
	}
	if record["status"] != float64(http.StatusCreated) || strings.Contains(output.String(), "secret=x") {
		t.Fatalf("statusまたはquery秘匿が不正です: %s", output.String())
	}
}

func TestAccessLogRecordsPanicAs500AndRethrows(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	handler := AccessLogMiddleware(AccessLogOptions{
		Logger: slog.New(slog.NewJSONHandler(&output, nil)),
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("panicがrecovery middlewareへ伝播しません")
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/panic", nil))
	}()
	if !strings.Contains(output.String(), `"status":500`) {
		t.Fatalf("panic statusを500で記録しません: %s", output.String())
	}
}

func TestLogFieldsConcurrentUpdatesAreRaceSafe(t *testing.T) {
	t.Parallel()
	ctx := WithLogFields(t.Context(), LogFields{RequestID: "race-request"})
	var waitGroup sync.WaitGroup
	for index := 0; index < 100; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_ = WithLogFields(ctx, LogFields{EventID: "event"})
			_ = LogFieldsFromContext(ctx)
		}()
	}
	waitGroup.Wait()
	if fields := LogFieldsFromContext(ctx); fields.RequestID != "race-request" || fields.EventID != "event" {
		t.Fatalf("concurrent field更新が不正です: %+v", fields)
	}
}
