package httpapi

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const requestIDHeader = "X-Request-ID"

type requestContextKey struct{}

type requestState struct {
	mu     sync.RWMutex
	fields LogFields
}

// LogFields はHTTPとbackground eventの相関に必要な安定field群である。
type LogFields struct {
	RequestID   string
	Tenant      string
	Application string
	Environment string
	Workspace   string
	EventID     string
	TraceID     string
	SpanID      string
}

// RequestIDGenerator は検証前のrequest ID候補を生成する。
type RequestIDGenerator func() (string, error)

// ValidRequestID はKotlin版と同じ1〜200文字のASCII allowlistを検証する。
func ValidRequestID(value string) bool {
	if len(value) < 1 || len(value) > 200 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("-_.:", character) {
			continue
		}
		return false
	}
	return true
}

// GenerateRequestID は暗号学的乱数からUUID v4形式のIDを作る。
func GenerateRequestID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("request IDを生成できません: %w", err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16],
	), nil
}

// RequestIDMiddleware は有効な受信IDを引き継ぎ、それ以外は新規IDへ置き換える。
func RequestIDMiddleware(generator RequestIDGenerator) func(http.Handler) http.Handler {
	if generator == nil {
		generator = GenerateRequestID
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			requestID := request.Header.Get(requestIDHeader)
			if !ValidRequestID(requestID) {
				var err error
				requestID, err = generator()
				if err != nil || !ValidRequestID(requestID) {
					WriteProblem(writer, http.StatusInternalServerError, Problem{
						Type: "/problems/internal-error", Title: "Internal Server Error",
						Status: http.StatusInternalServerError, Code: "internal.error", RequestID: "unknown",
					})
					return
				}
			}
			contextWithFields := WithLogFields(request.Context(), LogFields{RequestID: requestID})
			request = request.WithContext(contextWithFields)
			writer.Header().Set(requestIDHeader, requestID)
			next.ServeHTTP(writer, request)
		})
	}
}

// WithLogFields は既存request stateを更新し、未初期化なら新しいstateをcontextへ追加する。
func WithLogFields(ctx context.Context, fields LogFields) context.Context {
	state, ok := ctx.Value(requestContextKey{}).(*requestState)
	if !ok {
		state = &requestState{}
		ctx = context.WithValue(ctx, requestContextKey{}, state)
	}
	state.merge(fields)
	return ctx
}

// LogFieldsFromContext は現在の相関field snapshotを返す。
func LogFieldsFromContext(ctx context.Context) LogFields {
	state, ok := ctx.Value(requestContextKey{}).(*requestState)
	if !ok {
		return LogFields{}
	}
	state.mu.RLock()
	defer state.mu.RUnlock()
	return state.fields
}

// RequestIDFromContext はrequest IDを返し、未設定時はunknownを返す。
func RequestIDFromContext(ctx context.Context) string {
	requestID := LogFieldsFromContext(ctx).RequestID
	if requestID == "" {
		return "unknown"
	}
	return requestID
}

func (state *requestState) merge(update LogFields) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if update.RequestID != "" {
		state.fields.RequestID = update.RequestID
	}
	if update.Tenant != "" {
		state.fields.Tenant = update.Tenant
	}
	if update.Application != "" {
		state.fields.Application = update.Application
	}
	if update.Environment != "" {
		state.fields.Environment = update.Environment
	}
	if update.Workspace != "" {
		state.fields.Workspace = update.Workspace
	}
	if update.EventID != "" {
		state.fields.EventID = update.EventID
	}
	if update.TraceID != "" {
		state.fields.TraceID = update.TraceID
	}
	if update.SpanID != "" {
		state.fields.SpanID = update.SpanID
	}
}

// LoggerWithContext は相関fieldを付加したloggerを返す。
func LoggerWithContext(ctx context.Context, logger *slog.Logger) *slog.Logger {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	fields := LogFieldsFromContext(ctx)
	attributes := logAttributes(fields)
	arguments := make([]any, len(attributes))
	for index := range attributes {
		arguments[index] = attributes[index]
	}
	return logger.With(arguments...)
}

// AccessLogOptions はaccess log middlewareの依存を定義する。
type AccessLogOptions struct {
	Logger *slog.Logger
	Now    func() time.Time
	Skip   func(*http.Request) bool
}

// AccessLogMiddleware はbody/headerを記録せず、固定keyのstructured access logを出力する。
func AccessLogMiddleware(options AccessLogOptions) func(http.Handler) http.Handler {
	logger := options.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	skip := options.Skip
	if skip == nil {
		skip = func(request *http.Request) bool { return strings.HasPrefix(request.URL.Path, "/health/") }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			ctx := WithLogFields(request.Context(), LogFields{})
			request = request.WithContext(ctx)
			if skip(request) {
				next.ServeHTTP(writer, request)
				return
			}
			startedAt := now()
			observer := ObserveResponse(writer)
			defer func() {
				recovered := recover()
				status := observer.Status()
				if recovered != nil {
					status = http.StatusInternalServerError
				}
				fields := LogFieldsFromContext(ctx)
				attributes := logAttributes(fields)
				attributes = append(attributes,
					slog.String("httpMethod", request.Method),
					slog.String("httpPath", request.URL.Path),
					slog.Int("status", status),
					slog.Int64("responseBytes", observer.BytesWritten()),
					slog.Duration("duration", now().Sub(startedAt)),
				)
				logger.LogAttrs(ctx, slog.LevelInfo, "HTTP request completed", attributes...)
				if recovered != nil {
					panic(recovered)
				}
			}()
			next.ServeHTTP(observer, request)
		})
	}
}

func logAttributes(fields LogFields) []slog.Attr {
	return []slog.Attr{
		slog.String("requestId", valueOrUnknown(fields.RequestID)),
		slog.String("tenant", fields.Tenant),
		slog.String("application", fields.Application),
		slog.String("environment", fields.Environment),
		slog.String("workspace", fields.Workspace),
		slog.String("eventId", fields.EventID),
		slog.String("traceId", fields.TraceID),
		slog.String("spanId", fields.SpanID),
	}
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}
