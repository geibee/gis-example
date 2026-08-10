package differential

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBehaviorFixtureRoundTrip(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "feedback", "behavior", "http-v1.json"))
	if err != nil {
		t.Fatalf("fixtureを読めません: %v", err)
	}
	suite, err := LoadSuite(contents)
	if err != nil {
		t.Fatalf("fixtureが不正です: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/problem+json")
		writer.Header().Set("X-Request-ID", request.Header.Get("X-Request-ID")+"-dynamic")
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"code":"auth.unauthorized","requestId":"dynamic"}`))
	}))
	t.Cleanup(server.Close)

	first, err := Run(context.Background(), server.Client(), server.URL, suite)
	if err != nil {
		t.Fatalf("1回目の実行に失敗しました: %v", err)
	}
	second, err := Run(context.Background(), server.Client(), server.URL, suite)
	if err != nil {
		t.Fatalf("2回目の実行に失敗しました: %v", err)
	}
	if err := Compare(suite, first, second); err != nil {
		t.Fatalf("同じ実装の結果が一致しません: %v", err)
	}
}

func TestCompareDetectsStatusDifference(t *testing.T) {
	t.Parallel()
	suite := Suite{Version: "1", Cases: []Case{{ID: "fixture", Method: "GET", Path: "/feedback/v1/fixture"}}}
	err := Compare(
		suite,
		map[string]Result{"fixture": {Status: http.StatusOK}},
		map[string]Result{"fixture": {Status: http.StatusNotImplemented}},
	)
	if err == nil {
		t.Fatal("status差分を検出しませんでした")
	}
}
