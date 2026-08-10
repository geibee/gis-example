package contract

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const frozenOperationCount = 42

var pathParameterPattern = regexp.MustCompile(`\{[^}/]+\}`)

func TestGeneratedHandlerRegistersEveryFrozenOperation(t *testing.T) {
	t.Parallel()

	var _ ServerInterface = Unimplemented{}

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("OpenAPI生成物を読み込めません: %v", err)
	}
	mux := newRecordingServeMux()
	handler := HandlerFromMuxWithBaseURL(Unimplemented{}, mux, "/feedback/v1")
	operationCount := 0
	expectedPatterns := make([]string, 0, frozenOperationCount)
	operationIDs := make(map[string]struct{}, frozenOperationCount)
	for path, pathItem := range spec.Paths.Map() {
		for method, operation := range pathItem.Operations() {
			operationCount++
			if operation.OperationID == "" {
				t.Errorf("operationIdがありません: %s %s", method, path)
			}
			if _, duplicated := operationIDs[operation.OperationID]; duplicated {
				t.Errorf("operationIdが重複しています: %s", operation.OperationID)
			}
			operationIDs[operation.OperationID] = struct{}{}
			expectedPatterns = append(expectedPatterns, strings.ToUpper(method)+" /feedback/v1"+path)
			requestPath := "/feedback/v1" + pathParameterPattern.ReplaceAllString(path, "00000000-0000-4000-8000-000000000001")
			request := httptest.NewRequest(strings.ToUpper(method), requestPath, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code == http.StatusNotFound || response.Code == http.StatusMethodNotAllowed {
				t.Errorf("未登録operation: %s %s (%s), status=%d", method, path, operation.OperationID, response.Code)
			}
		}
	}
	if operationCount != frozenOperationCount {
		t.Fatalf("OpenAPI operation数が変化しました: got=%d want=%d", operationCount, frozenOperationCount)
	}
	slices.Sort(expectedPatterns)
	actualPatterns := slices.Clone(mux.patterns)
	slices.Sort(actualPatterns)
	if !slices.Equal(actualPatterns, expectedPatterns) {
		t.Fatalf("OpenAPIと登録routeが双方向一致しません:\nactual=%v\nexpected=%v", actualPatterns, expectedPatterns)
	}
}

type recordingServeMux struct {
	patterns []string
	delegate *http.ServeMux
}

func newRecordingServeMux() *recordingServeMux {
	return &recordingServeMux{delegate: http.NewServeMux()}
}

func (mux *recordingServeMux) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	mux.patterns = append(mux.patterns, pattern)
	mux.delegate.HandleFunc(pattern, handler)
}

func (mux *recordingServeMux) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	mux.delegate.ServeHTTP(writer, request)
}
