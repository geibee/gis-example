// Package differential compares Kotlin and Go HTTP behavior against the same fixture sequence.
package differential

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
)

const maxResponseBytes = 32 << 20

// Suite is the machine-readable behavior contract shared by both implementations.
type Suite struct {
	Version     string `json:"version"`
	Description string `json:"description"`
	Cases       []Case `json:"cases"`
}

// Case defines one request and the nondeterministic values excluded from comparison.
type Case struct {
	ID                 string            `json:"id"`
	Method             string            `json:"method"`
	Path               string            `json:"path"`
	Headers            map[string]string `json:"headers,omitempty"`
	Body               json.RawMessage   `json:"body,omitempty"`
	CompareHeaders     []string          `json:"compareHeaders,omitempty"`
	IgnoreHeaders      []string          `json:"ignoreHeaders,omitempty"`
	IgnoreJSONPointers []string          `json:"ignoreJsonPointers,omitempty"`
}

// Result contains only response data covered by the compatibility contract.
type Result struct {
	Status  int
	Headers http.Header
	Body    []byte
}

// LoadSuite decodes a fixture and rejects ambiguous or unsafe requests.
func LoadSuite(contents []byte) (Suite, error) {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var suite Suite
	if err := decoder.Decode(&suite); err != nil {
		return Suite{}, fmt.Errorf("behavior fixtureをdecodeできません: %w", err)
	}
	if suite.Version != "1" || len(suite.Cases) == 0 {
		return Suite{}, errors.New("behavior fixtureはversion=1と1件以上のcaseが必要です")
	}
	seen := make(map[string]struct{}, len(suite.Cases))
	for _, fixture := range suite.Cases {
		if fixture.ID == "" || fixture.Method == "" || !strings.HasPrefix(fixture.Path, "/feedback/v1/") {
			return Suite{}, fmt.Errorf("behavior fixture caseが不正です: id=%q method=%q path=%q", fixture.ID, fixture.Method, fixture.Path)
		}
		if _, duplicated := seen[fixture.ID]; duplicated {
			return Suite{}, fmt.Errorf("behavior fixture idが重複しています: %s", fixture.ID)
		}
		seen[fixture.ID] = struct{}{}
	}
	return suite, nil
}

// Run executes every case against one isolated implementation.
func Run(ctx context.Context, client *http.Client, baseURL string, suite Suite) (map[string]Result, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("比較先URLが不正です: %q", baseURL)
	}
	results := make(map[string]Result, len(suite.Cases))
	for _, fixture := range suite.Cases {
		requestURL, err := base.Parse(fixture.Path)
		if err != nil || requestURL.Host != base.Host {
			return nil, fmt.Errorf("case %sのpathが不正です", fixture.ID)
		}
		request, err := http.NewRequestWithContext(ctx, fixture.Method, requestURL.String(), bytes.NewReader(fixture.Body))
		if err != nil {
			return nil, fmt.Errorf("case %sのrequestを作成できません: %w", fixture.ID, err)
		}
		for name, value := range fixture.Headers {
			request.Header.Set(name, value)
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("case %sのrequestに失敗しました: %w", fixture.ID, err)
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil {
			return nil, fmt.Errorf("case %sのresponseを読めません: read=%v close=%v", fixture.ID, readErr, closeErr)
		}
		if len(body) > maxResponseBytes {
			return nil, fmt.Errorf("case %sのresponseが上限を超えました", fixture.ID)
		}
		results[fixture.ID] = Result{Status: response.StatusCode, Headers: response.Header.Clone(), Body: body}
	}
	return results, nil
}

// Compare checks status, selected headers, and normalized JSON or binary bodies.
func Compare(suite Suite, kotlinResults, goResults map[string]Result) error {
	for _, fixture := range suite.Cases {
		left, leftOK := kotlinResults[fixture.ID]
		right, rightOK := goResults[fixture.ID]
		if !leftOK || !rightOK {
			return fmt.Errorf("case %sの結果が不足しています: kotlin=%t go=%t", fixture.ID, leftOK, rightOK)
		}
		if left.Status != right.Status {
			return fmt.Errorf("case %sのstatus差分: kotlin=%d go=%d", fixture.ID, left.Status, right.Status)
		}
		ignoredHeaders := canonicalSet(fixture.IgnoreHeaders)
		for _, header := range fixture.CompareHeaders {
			if _, ignored := ignoredHeaders[http.CanonicalHeaderKey(header)]; ignored {
				continue
			}
			if !reflect.DeepEqual(left.Headers.Values(header), right.Headers.Values(header)) {
				return fmt.Errorf("case %sのheader差分: %s kotlin=%v go=%v", fixture.ID, header, left.Headers.Values(header), right.Headers.Values(header))
			}
		}
		if err := compareBody(fixture, left, right); err != nil {
			return err
		}
	}
	return nil
}

func compareBody(fixture Case, left, right Result) error {
	if isJSON(left.Headers.Get("Content-Type")) && isJSON(right.Headers.Get("Content-Type")) {
		leftJSON, err := normalizedJSON(left.Body, fixture.IgnoreJSONPointers)
		if err != nil {
			return fmt.Errorf("case %sのKotlin JSONが不正です: %w", fixture.ID, err)
		}
		rightJSON, err := normalizedJSON(right.Body, fixture.IgnoreJSONPointers)
		if err != nil {
			return fmt.Errorf("case %sのGo JSONが不正です: %w", fixture.ID, err)
		}
		if !reflect.DeepEqual(leftJSON, rightJSON) {
			return fmt.Errorf("case %sのJSON差分: kotlin=%v go=%v", fixture.ID, leftJSON, rightJSON)
		}
		return nil
	}
	if !bytes.Equal(left.Body, right.Body) {
		return fmt.Errorf("case %sのbody byte列が一致しません", fixture.ID)
	}
	return nil
}

func normalizedJSON(body []byte, ignoredPointers []string) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	for _, pointer := range ignoredPointers {
		if err := deleteJSONPointer(value, pointer); err != nil {
			return nil, err
		}
	}
	return value, nil
}

func deleteJSONPointer(value any, pointer string) error {
	if pointer == "" || pointer[0] != '/' {
		return fmt.Errorf("JSON Pointerが不正です: %q", pointer)
	}
	parts := strings.Split(pointer[1:], "/")
	current := value
	for index, rawPart := range parts {
		part := strings.ReplaceAll(strings.ReplaceAll(rawPart, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return fmt.Errorf("JSON Pointerがobject外を参照します: %q", pointer)
		}
		if index == len(parts)-1 {
			delete(object, part)
			return nil
		}
		next, exists := object[part]
		if !exists {
			return nil
		}
		current = next
	}
	return nil
}

func isJSON(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(contentType), "application/json") ||
		strings.HasPrefix(strings.ToLower(contentType), "application/problem+json")
}

func canonicalSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[http.CanonicalHeaderKey(value)] = struct{}{}
	}
	return result
}
