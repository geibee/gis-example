package observability

import (
	"fmt"
	"net/http"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// TraceOptions はglobal providerに依存せずtracerとpropagatorを注入する。
type TraceOptions struct {
	Tracer     trace.Tracer
	Propagator propagation.TextMapPropagator
	SpanName   func(*http.Request) string
}

// TraceMiddleware はW3C trace contextを抽出し、server spanとaccess log相関IDを作る。
func TraceMiddleware(options TraceOptions) func(http.Handler) http.Handler {
	tracer := options.Tracer
	if tracer == nil {
		tracer = noop.NewTracerProvider().Tracer("feedback-service/http")
	}
	propagator := options.Propagator
	if propagator == nil {
		propagator = propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		)
	}
	spanName := options.SpanName
	if spanName == nil {
		spanName = func(request *http.Request) string { return "HTTP " + request.Method }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			parentContext := propagator.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
			ctx, span := tracer.Start(
				parentContext,
				spanName(request),
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(
					attribute.String("http.request.method", request.Method),
					attribute.String("url.path", request.URL.Path),
				),
			)
			spanContext := span.SpanContext()
			if spanContext.IsValid() {
				ctx = httpapi.WithLogFields(ctx, httpapi.LogFields{
					TraceID: spanContext.TraceID().String(),
					SpanID:  spanContext.SpanID().String(),
				})
			} else {
				ctx = httpapi.WithLogFields(ctx, httpapi.LogFields{})
			}
			request = request.WithContext(ctx)
			observer := &traceResponseObserver{ResponseWriter: writer}
			defer func() {
				if request.Pattern != "" {
					span.SetAttributes(attribute.String("http.route", request.Pattern))
				}
				fields := httpapi.LogFieldsFromContext(ctx)
				if fields.RequestID != "" {
					span.SetAttributes(attribute.String("request.id", fields.RequestID))
				}
				if recovered := recover(); recovered != nil {
					panicError := fmt.Errorf("HTTP handler panic: %v", recovered)
					span.RecordError(panicError)
					span.SetStatus(codes.Error, "handler panic")
					span.SetAttributes(attribute.Int("http.response.status_code", http.StatusInternalServerError))
					span.End()
					panic(recovered)
				}
				status := observer.statusCode()
				span.SetAttributes(attribute.Int("http.response.status_code", status))
				if status >= http.StatusInternalServerError {
					span.SetStatus(codes.Error, http.StatusText(status))
				}
				span.End()
			}()
			next.ServeHTTP(observer, request)
		})
	}
}

type traceResponseObserver struct {
	http.ResponseWriter
	status int
}

func (writer *traceResponseObserver) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *traceResponseObserver) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

func (writer *traceResponseObserver) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *traceResponseObserver) statusCode() int {
	if writer.status == 0 {
		return http.StatusOK
	}
	return writer.status
}
