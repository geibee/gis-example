package observability

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestMetricsPreserveNamesAndOperationalLabels(t *testing.T) {
	t.Parallel()
	provider := OperationalMetricsProviderFunc(func(context.Context) ([]OperationalMetric, error) {
		return []OperationalMetric{
			{Name: "feedback_posts_total", Type: OperationalCounter, Value: 3, Labels: map[string]string{"tenant": "tenant-\"a"}},
			{Name: "feedback_outbox_lag_seconds", Type: OperationalGauge, Value: 1.5, Labels: map[string]string{"tenant": "tenant-a"}},
		}, nil
	})
	metrics, err := NewMetrics(MetricsOptions{Operational: provider, LatencyBuckets: []float64{0.1, 1}})
	if err != nil {
		t.Fatal(err)
	}
	metrics.RecordRequest(50*time.Millisecond, http.StatusOK)
	metrics.RecordRequest(200*time.Millisecond, http.StatusInternalServerError)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.Header.Set("Accept", "application/openmetrics-text")
	metrics.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 200 || !strings.HasPrefix(recorder.Header().Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("metrics responseが不正です: %d %q %s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "feedback_api_latency_seconds_bucket{") {
			t.Fatalf("Kotlin v1にないmetric行が公開されました: %q", line)
		}
	}
	for _, expected := range []string{
		"feedback_api_requests_total 2",
		"feedback_api_errors_total 1",
		"feedback_api_latency_seconds_count 2",
		"feedback_api_latency_seconds_sum 0.25",
		`feedback_posts_total{tenant="tenant-\"a"} 3`,
		`feedback_outbox_lag_seconds{tenant="tenant-a"} 1.5`,
	} {
		if !strings.Contains(body, expected) {
			t.Errorf("metric %qがありません:\n%s", expected, body)
		}
	}
	if strings.Contains(body, "go_gc_duration") {
		t.Fatal("global/default collectorがprivate registryへ混入しました")
	}
}

func TestMetricsMiddlewareExcludesMetricsEndpoint(t *testing.T) {
	t.Parallel()
	metrics, err := NewMetrics(MetricsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	handler := metrics.Middleware(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/failure" {
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	for _, path := range []string{"/ok", "/failure", "/metrics", "/metrics/not-found"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(recorder.Body.String(), "feedback_api_requests_total 2") ||
		!strings.Contains(recorder.Body.String(), "feedback_api_errors_total 1") {
		t.Fatalf("middleware counterが不正です:\n%s", recorder.Body.String())
	}
}

func TestMetricsExposeExactlyFrozenV1Series(t *testing.T) {
	t.Parallel()
	provider := OperationalMetricsProviderFunc(func(context.Context) ([]OperationalMetric, error) {
		result := make([]OperationalMetric, 0, 9)
		for _, name := range []string{
			"feedback_posts_total", "feedback_storage_failures_total", "feedback_delivery_failures_total",
		} {
			result = append(result, OperationalMetric{Name: name, Type: OperationalCounter, Labels: map[string]string{"tenant": "tenant"}})
		}
		for _, name := range []string{
			"feedback_tenant_evidence_bytes", "feedback_tenant_thread_count", "feedback_tenant_export_count",
			"feedback_delivery_failure_count", "feedback_outbox_lag_seconds", "feedback_purge_backlog",
		} {
			result = append(result, OperationalMetric{Name: name, Type: OperationalGauge, Labels: map[string]string{"tenant": "tenant"}})
		}
		return result, nil
	})
	metrics, err := NewMetrics(MetricsOptions{Operational: provider})
	if err != nil {
		t.Fatal(err)
	}
	metrics.RecordRequest(time.Millisecond, http.StatusOK)
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	got := make([]string, 0, 13)
	for _, line := range strings.Split(strings.TrimSpace(recorder.Body.String()), "\n") {
		name := strings.Fields(line)[0]
		if label := strings.IndexByte(name, '{'); label >= 0 {
			name = name[:label]
		}
		got = append(got, name)
	}
	want := []string{
		"feedback_api_requests_total", "feedback_api_errors_total",
		"feedback_api_latency_seconds_count", "feedback_api_latency_seconds_sum",
		"feedback_posts_total", "feedback_storage_failures_total", "feedback_delivery_failures_total",
		"feedback_tenant_evidence_bytes", "feedback_tenant_thread_count", "feedback_tenant_export_count",
		"feedback_delivery_failure_count", "feedback_outbox_lag_seconds", "feedback_purge_backlog",
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("metric series mismatch\ngot =%v\nwant=%v\nbody=%s", got, want, recorder.Body.String())
	}
}

func TestMetricsMiddlewareRecordsPanicAsError(t *testing.T) {
	t.Parallel()
	metrics, err := NewMetrics(MetricsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	handler := metrics.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	func() {
		defer func() { _ = recover() }()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/panic", nil))
	}()
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(recorder.Body.String(), "feedback_api_requests_total 1") ||
		!strings.Contains(recorder.Body.String(), "feedback_api_errors_total 1") {
		t.Fatalf("panic requestのmetricが不正です:\n%s", recorder.Body.String())
	}
}

func TestMetricsProviderFailureFailsScrape(t *testing.T) {
	t.Parallel()
	metrics, err := NewMetrics(MetricsOptions{Operational: OperationalMetricsProviderFunc(
		func(context.Context) ([]OperationalMetric, error) { return nil, errors.New("database unavailable") },
	)})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("provider障害をfail-closedにできません: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestMetricsRejectDuplicateRegistryRegistration(t *testing.T) {
	t.Parallel()
	registry := prometheus.NewRegistry()
	if _, err := NewMetrics(MetricsOptions{Registry: registry}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewMetrics(MetricsOptions{Registry: registry}); err == nil {
		t.Fatal("同名collectorの重複登録を受理しました")
	}
}

func TestMetricsRejectInvalidLatencyBuckets(t *testing.T) {
	t.Parallel()
	for _, buckets := range [][]float64{{0.2, 0.1}, {0}, {-1, 1}} {
		if _, err := NewMetrics(MetricsOptions{LatencyBuckets: buckets}); err == nil {
			t.Fatalf("不正bucketを受理しました: %v", buckets)
		}
	}
}

func TestMetricsConcurrentRecordAndScrape(t *testing.T) {
	t.Parallel()
	metrics, err := NewMetrics(MetricsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var waitGroup sync.WaitGroup
	for index := 0; index < 100; index++ {
		waitGroup.Add(2)
		go func() {
			defer waitGroup.Done()
			metrics.RecordRequest(time.Millisecond, http.StatusOK)
		}()
		go func() {
			defer waitGroup.Done()
			recorder := httptest.NewRecorder()
			metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
			if recorder.Code != 200 {
				t.Errorf("concurrent scrape status=%d", recorder.Code)
			}
		}()
	}
	waitGroup.Wait()
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(recorder.Body.String(), "feedback_api_requests_total 100") {
		t.Fatalf("concurrent counterが不正です:\n%s", recorder.Body.String())
	}
}
