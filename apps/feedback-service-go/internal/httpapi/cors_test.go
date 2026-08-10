package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateOriginMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		origin string
		valid  bool
	}{
		{origin: "https://example.com", valid: true},
		{origin: "https://example.com:8443", valid: true},
		{origin: "http://localhost:3000", valid: true},
		{origin: "http://127.0.0.1", valid: true},
		{origin: "http://[::1]:3000", valid: true},
		{origin: "http://example.com", valid: false},
		{origin: "https://example.com/", valid: false},
		{origin: "https://example.com/path", valid: false},
		{origin: "https://example.com?query", valid: false},
		{origin: "https://user@example.com", valid: false},
		{origin: " https://example.com", valid: false},
		{origin: "null", valid: false},
		{origin: "", valid: false},
	}
	for _, test := range tests {
		t.Run(test.origin, func(t *testing.T) {
			t.Parallel()
			_, err := ValidateOrigin(test.origin)
			if (err == nil) != test.valid {
				t.Fatalf("ValidateOrigin(%q) error=%v, valid=%t", test.origin, err, test.valid)
			}
		})
	}
}

func TestCORSMiddlewarePolicyMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		origin      string
		method      string
		resolver    CORSPolicyResolver
		wantStatus  int
		wantAllowed bool
		wantNext    bool
	}{
		{name: "originなし", method: http.MethodGet, resolver: nil, wantStatus: 202, wantNext: true},
		{name: "許可", origin: "https://allowed.example", method: http.MethodGet, resolver: allowOrigin(true, nil), wantStatus: 202, wantAllowed: true, wantNext: true},
		{name: "preflight", origin: "https://allowed.example", method: http.MethodOptions, resolver: allowOrigin(true, nil), wantStatus: 204, wantAllowed: true},
		{name: "拒否", origin: "https://denied.example", method: http.MethodGet, resolver: allowOrigin(false, nil), wantStatus: 403},
		{name: "不正", origin: "http://remote.example", method: http.MethodGet, resolver: allowOrigin(true, nil), wantStatus: 403},
		{name: "DB障害", origin: "https://allowed.example", method: http.MethodGet, resolver: allowOrigin(false, errors.New("db down")), wantStatus: 500},
		{name: "resolver未設定", origin: "https://allowed.example", method: http.MethodGet, resolver: nil, wantStatus: 500},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			called := false
			handler := CORSMiddleware(test.resolver, nil)(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				called = true
				writer.Header().Add("Vary", "Accept-Encoding")
				writer.WriteHeader(http.StatusAccepted)
			}))
			request := httptest.NewRequest(test.method, "/feedback/v1/me", nil)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != test.wantStatus || called != test.wantNext {
				t.Fatalf("status/nextが不正です: status=%d called=%t", recorder.Code, called)
			}
			allowed := recorder.Header().Get("Access-Control-Allow-Origin") != ""
			if allowed != test.wantAllowed {
				t.Fatalf("fail-closedに違反しました: headers=%v", recorder.Header())
			}
			if test.wantAllowed {
				if !strings.Contains(strings.Join(recorder.Header().Values("Vary"), ","), "Origin") {
					t.Fatal("Vary: Originがありません")
				}
			}
			if test.method == http.MethodOptions && recorder.Header().Get("Access-Control-Max-Age") != "600" {
				t.Fatal("preflight headerが不足しています")
			}
		})
	}
}

func allowOrigin(allowed bool, err error) CORSPolicyResolverFunc {
	return func(context.Context, string) (bool, error) { return allowed, err }
}
