package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
)

const problemContentType = "application/problem+json"

// Problem は凍結済みOpenAPIのRFC 7807拡張形式である。
type Problem = contract.FeedbackProblem

// APIError はstatus、Problem Details、追加headerを一体で伝える。
type APIError struct {
	Status  int
	Problem Problem
	Header  http.Header
}

func (err *APIError) Error() string {
	if err.Problem.Detail != nil {
		return *err.Problem.Detail
	}
	if err.Problem.Title != "" {
		return err.Problem.Title
	}
	return http.StatusText(err.Status)
}

// NewAPIError は安定したProblem Detailsを持つAPI errorを作る。
func NewAPIError(status int, problemType, code, detail string) *APIError {
	var detailPointer *string
	if detail != "" {
		detailPointer = &detail
	}
	return &APIError{
		Status: status,
		Problem: Problem{
			Type:   problemType,
			Title:  http.StatusText(status),
			Status: status,
			Detail: detailPointer,
			Code:   code,
		},
		Header: make(http.Header),
	}
}

// WriteProblem は必須fieldとcontent typeを固定してProblem Detailsを書き込む。
func WriteProblem(writer http.ResponseWriter, status int, problem Problem) {
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	problem.Status = status
	if problem.Title == "" {
		problem.Title = http.StatusText(status)
	}
	if problem.Type == "" {
		problem.Type = "/problems/internal-error"
	}
	if problem.Code == "" {
		problem.Code = "internal.error"
	}
	if problem.RequestID == "" {
		problem.RequestID = "unknown"
	}
	body, err := json.Marshal(problem)
	if err != nil {
		body = []byte(`{"type":"/problems/internal-error","title":"Internal Server Error","status":500,"code":"internal.error","requestId":"unknown"}`)
		status = http.StatusInternalServerError
	}
	writer.Header().Set("Content-Type", problemContentType)
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

// WriteError は既知errorをProblem Detailsへ写像し、未知errorのdetailを公開しない。
func WriteError(writer http.ResponseWriter, request *http.Request, err error) {
	problemError := ProblemFromError(err)
	for key, values := range problemError.Header {
		for _, value := range values {
			writer.Header().Add(key, value)
		}
	}
	problem := problemError.Problem
	problem.RequestID = RequestIDFromContext(request.Context())
	WriteProblem(writer, problemError.Status, problem)
}

// ProblemFromError はvalidation errorとAPI errorをwire上の形式へ変換する。
func ProblemFromError(err error) *APIError {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError
	}
	var validationError *ValidationError
	if errors.As(err, &validationError) {
		problemType := "/problems/" + validationError.Code
		if validationError.Code == "request.invalid_json" {
			problemType = "/problems/request.invalid-json"
		}
		return NewAPIError(http.StatusBadRequest, problemType, validationError.Code, validationError.Message)
	}
	return NewAPIError(http.StatusInternalServerError, "/problems/internal-error", "internal.error", "")
}

// DecodeJSONRequest はbody上限、unknown field、複数JSON値、top-level nullを拒否する。
func DecodeJSONRequest(request *http.Request, target any, maximumBytes int64) error {
	if request == nil || request.Body == nil {
		return invalidJSON(errors.New("request bodyがありません"))
	}
	if target == nil {
		return errors.New("JSON decode先がnilです")
	}
	if maximumBytes <= 0 {
		return errors.New("JSON body上限は正数で指定してください")
	}
	limited := io.LimitReader(request.Body, maximumBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return invalidJSON(err)
	}
	if int64(len(body)) > maximumBytes {
		return NewAPIError(
			http.StatusRequestEntityTooLarge,
			"/problems/request-too-large",
			"request.too_large",
			fmt.Sprintf("request bodyは%d bytes以下で指定してください", maximumBytes),
		)
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return invalidJSON(errors.New("JSON objectを指定してください"))
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalidJSON(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("JSON値が複数あります")
		}
		return invalidJSON(err)
	}
	return nil
}

func invalidJSON(err error) *APIError {
	detail := "request JSONが不正です"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		detail += ": " + err.Error()
	}
	return NewAPIError(http.StatusBadRequest, "/problems/request.invalid-json", "request.invalid_json", detail)
}

// RecoveryMiddleware はpanicを500 Problemへ変換し、stack traceはlogだけへ記録する。
func RecoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			observer := ObserveResponse(writer)
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				if recovered == http.ErrAbortHandler {
					panic(recovered)
				}
				logger.ErrorContext(
					request.Context(),
					"Feedback Service request failed",
					slog.Any("error", recovered),
					slog.String("requestId", RequestIDFromContext(request.Context())),
					slog.String("stack", string(debug.Stack())),
				)
				if !observer.Committed() {
					WriteError(observer, request, fmt.Errorf("panic: %v", recovered))
				}
			}()
			next.ServeHTTP(observer, request)
		})
	}
}
