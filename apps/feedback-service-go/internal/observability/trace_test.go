package observability

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

type parentCapturingTracer struct {
	trace.Tracer
	parent trace.SpanContext
}

func (tracer *parentCapturingTracer) Start(
	ctx context.Context,
	spanName string,
	options ...trace.SpanStartOption,
) (context.Context, trace.Span) {
	tracer.parent = trace.SpanContextFromContext(ctx)
	return tracer.Tracer.Start(ctx, spanName, options...)
}

func TestTraceMiddlewareExtractsW3CContext(t *testing.T) {
	t.Parallel()
	capture := &parentCapturingTracer{Tracer: noop.NewTracerProvider().Tracer("test")}
	var fields httpapi.LogFields
	handler := TraceMiddleware(TraceOptions{Tracer: capture})(http.HandlerFunc(
		func(_ http.ResponseWriter, request *http.Request) {
			fields = httpapi.LogFieldsFromContext(request.Context())
		},
	))
	request := httptest.NewRequest(http.MethodGet, "/feedback/v1/me", nil)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if !capture.parent.IsValid() || capture.parent.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" || !capture.parent.IsRemote() {
		t.Fatalf("remote parentを抽出できません: %+v", capture.parent)
	}
	if fields.TraceID == "" || fields.SpanID == "" {
		t.Fatalf("log correlationへtrace IDが伝播しません: %+v", fields)
	}
}

func TestTraceMiddlewareRejectsMalformedContext(t *testing.T) {
	t.Parallel()
	capture := &parentCapturingTracer{Tracer: noop.NewTracerProvider().Tracer("test")}
	var fields httpapi.LogFields
	handler := TraceMiddleware(TraceOptions{Tracer: capture})(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		fields = httpapi.LogFieldsFromContext(request.Context())
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("traceparent", "00-not-a-trace-id-00f067aa0ba902b7-01")
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if capture.parent.IsValid() {
		t.Fatalf("不正traceparentを受理しました: %+v", capture.parent)
	}
	if fields.TraceID != "" || fields.SpanID != "" {
		t.Fatalf("無効なzero trace IDをlog相関へ設定しました: %+v", fields)
	}
}
