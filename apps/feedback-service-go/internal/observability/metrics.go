package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const defaultOperationalMetricsTimeout = 2 * time.Second

var prometheusMetricNamePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

// OperationalMetricType はDB由来metricのcounter/gauge意味を保持する。
type OperationalMetricType uint8

const (
	OperationalCounter OperationalMetricType = iota + 1
	OperationalGauge
)

// OperationalMetric はproviderからprivate registryへ渡す1 sampleである。
type OperationalMetric struct {
	Name   string
	Help   string
	Type   OperationalMetricType
	Value  float64
	Labels map[string]string
}

// OperationalMetricsProvider はscrape時点のDB由来metric snapshotを返す。
type OperationalMetricsProvider interface {
	CollectOperationalMetrics(context.Context) ([]OperationalMetric, error)
}

// OperationalMetricsProviderFunc は関数をproviderとして利用可能にする。
type OperationalMetricsProviderFunc func(context.Context) ([]OperationalMetric, error)

func (provider OperationalMetricsProviderFunc) CollectOperationalMetrics(ctx context.Context) ([]OperationalMetric, error) {
	return provider(ctx)
}

// MetricsOptions はprivate registryと運用metric providerを明示注入する。
type MetricsOptions struct {
	Registry           *prometheus.Registry
	Operational        OperationalMetricsProvider
	OperationalTimeout time.Duration
	LatencyBuckets     []float64
}

// Metrics は既存名のrequest counter/error counter/latency histogramを所有する。
type Metrics struct {
	registry *prometheus.Registry
	requests prometheus.Counter
	errors   prometheus.Counter
	latency  prometheus.Histogram
}

// NewMetrics はglobal registryを使わず、指定または新規private registryへcollectorを登録する。
func NewMetrics(options MetricsOptions) (*Metrics, error) {
	registry := options.Registry
	if registry == nil {
		registry = prometheus.NewRegistry()
	}
	buckets := options.LatencyBuckets
	if len(buckets) == 0 {
		buckets = prometheus.DefBuckets
	}
	if err := validateLatencyBuckets(buckets); err != nil {
		return nil, err
	}
	metrics := &Metrics{
		registry: registry,
		requests: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feedback_api_requests_total",
			Help: "完了したFeedback API request数（/metricsを除く）。",
		}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "feedback_api_errors_total",
			Help: "status 400以上で完了したFeedback API request数。",
		}),
		latency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "feedback_api_latency_seconds",
			Help:    "Feedback API request latency（秒）。",
			Buckets: append([]float64(nil), buckets...),
		}),
	}
	collectors := []prometheus.Collector{metrics.requests, metrics.errors, metrics.latency}
	if options.Operational != nil {
		timeout := options.OperationalTimeout
		if timeout <= 0 {
			timeout = defaultOperationalMetricsTimeout
		}
		collectors = append(collectors, &operationalCollector{provider: options.Operational, timeout: timeout})
	}
	registered := make([]prometheus.Collector, 0, len(collectors))
	for _, collector := range collectors {
		if err := registry.Register(collector); err != nil {
			for _, previous := range registered {
				registry.Unregister(previous)
			}
			return nil, fmt.Errorf("feedback metricを登録できません: %w", err)
		}
		registered = append(registered, collector)
	}
	return metrics, nil
}

// Registry はこのinstance専用のgathererを返す。
func (metrics *Metrics) Registry() *prometheus.Registry { return metrics.registry }

// RecordRequest はKotlin版と同じstatus境界と非負latencyでcounterを更新する。
func (metrics *Metrics) RecordRequest(elapsed time.Duration, status int) {
	if elapsed < 0 {
		elapsed = 0
	}
	metrics.requests.Inc()
	metrics.latency.Observe(elapsed.Seconds())
	if status >= http.StatusBadRequest {
		metrics.errors.Inc()
	}
}

// Middleware はKotlin版と同じ/metrics prefixを除く完了requestを記録する。
func (metrics *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/metrics") {
			next.ServeHTTP(writer, request)
			return
		}
		startedAt := time.Now()
		observer := &metricResponseObserver{ResponseWriter: writer}
		defer func() {
			recovered := recover()
			status := observer.statusCode()
			if recovered != nil {
				status = http.StatusInternalServerError
			}
			metrics.RecordRequest(time.Since(startedAt), status)
			if recovered != nil {
				panic(recovered)
			}
		}()
		next.ServeHTTP(observer, request)
	})
}

// Handler はclassic Prometheus text 0.0.4を返すprivate registry handlerである。
func (metrics *Metrics) Handler() http.Handler {
	handler := promhttp.HandlerFor(metrics.registry, promhttp.HandlerOpts{
		ErrorHandling:      promhttp.HTTPErrorOnError,
		DisableCompression: true,
	})
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		request = request.Clone(request.Context())
		request.Header.Set("Accept", "text/plain; version=0.0.4")
		request.Header.Del("Accept-Encoding")
		captured := &metricsResponse{header: make(http.Header)}
		handler.ServeHTTP(captured, request)
		for name, values := range captured.header {
			if strings.EqualFold(name, "Content-Length") {
				continue
			}
			writer.Header()[name] = append([]string(nil), values...)
		}
		status := captured.status
		if status == 0 {
			status = http.StatusOK
		}
		writer.WriteHeader(status)
		body := captured.body.Bytes()
		if status == http.StatusOK {
			body = v1MetricsBody(body)
		}
		_, _ = writer.Write(body)
	})
}

// v1MetricsBody はKotlin v1が公開しないHELP/TYPEとhistogram bucketを除く。
// count/sum、既存counter/gauge名、label/valueはPrometheus clientのescape/formatをそのまま使う。
func v1MetricsBody(body []byte) []byte {
	var output bytes.Buffer
	for len(body) > 0 {
		line := body
		if newline := bytes.IndexByte(body, '\n'); newline >= 0 {
			line = body[:newline+1]
			body = body[newline+1:]
		} else {
			body = nil
		}
		trimmed := bytes.TrimSuffix(line, []byte{'\n'})
		if bytes.HasPrefix(trimmed, []byte("#")) ||
			bytes.HasPrefix(trimmed, []byte("feedback_api_latency_seconds_bucket{")) {
			continue
		}
		output.Write(line)
	}
	return output.Bytes()
}

type metricsResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (response *metricsResponse) Header() http.Header { return response.header }

func (response *metricsResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *metricsResponse) Write(body []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(body)
}

type metricResponseObserver struct {
	http.ResponseWriter
	status int
}

func (writer *metricResponseObserver) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *metricResponseObserver) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

func (writer *metricResponseObserver) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *metricResponseObserver) statusCode() int {
	if writer.status == 0 {
		return http.StatusOK
	}
	return writer.status
}

type operationalCollector struct {
	provider OperationalMetricsProvider
	timeout  time.Duration
}

// Describeを空にすることで登録時DB I/Oを避けるunchecked collectorにする。
func (*operationalCollector) Describe(_ chan<- *prometheus.Desc) {}

func (collector *operationalCollector) Collect(output chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), collector.timeout)
	defer cancel()
	type collectionResult struct {
		metrics []OperationalMetric
		err     error
	}
	result := make(chan collectionResult, 1)
	go func() {
		metrics, err := collector.provider.CollectOperationalMetrics(ctx)
		result <- collectionResult{metrics: metrics, err: err}
	}()
	var metrics []OperationalMetric
	var err error
	select {
	case collected := <-result:
		metrics, err = collected.metrics, collected.err
	case <-ctx.Done():
		err = fmt.Errorf("operational metric収集がtimeoutしました: %w", ctx.Err())
	}
	if err != nil {
		output <- prometheus.NewInvalidMetric(
			prometheus.NewDesc("feedback_operational_metrics_error", "operational metric収集失敗", nil, nil),
			err,
		)
		return
	}
	for _, metric := range metrics {
		collected, err := newOperationalMetric(metric)
		if err != nil {
			output <- prometheus.NewInvalidMetric(
				prometheus.NewDesc("feedback_operational_metrics_error", "operational metricが不正", nil, nil),
				err,
			)
			continue
		}
		output <- collected
	}
}

func validateLatencyBuckets(buckets []float64) error {
	previous := math.Inf(-1)
	for _, bucket := range buckets {
		if math.IsNaN(bucket) || math.IsInf(bucket, 0) || bucket <= 0 || bucket <= previous {
			return errors.New("latency bucketは有限な正数を昇順で指定してください")
		}
		previous = bucket
	}
	return nil
}

func newOperationalMetric(metric OperationalMetric) (prometheus.Metric, error) {
	if !prometheusMetricNamePattern.MatchString(metric.Name) {
		return nil, fmt.Errorf("metric名が不正です: %q", metric.Name)
	}
	if math.IsNaN(metric.Value) || math.IsInf(metric.Value, 0) {
		return nil, fmt.Errorf("metric %sの値が有限数ではありません", metric.Name)
	}
	valueType := prometheus.UntypedValue
	switch metric.Type {
	case OperationalCounter:
		if metric.Value < 0 {
			return nil, fmt.Errorf("counter %sは非負でなければなりません", metric.Name)
		}
		valueType = prometheus.CounterValue
	case OperationalGauge:
		valueType = prometheus.GaugeValue
	default:
		return nil, errors.New("operational metric typeが不正です")
	}
	help := metric.Help
	if help == "" {
		help = metric.Name
	}
	description := prometheus.NewDesc(metric.Name, help, nil, metric.Labels)
	return prometheus.NewConstMetric(description, valueType, metric.Value)
}
