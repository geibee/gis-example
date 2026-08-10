// Package httpapi contains HTTP-facing validation and contract mapping.
package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

var (
	applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	pageKeyPattern        = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`)
	parameterKeyPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	queryKeyPattern       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)
	routeParameterPattern = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)\}`)
)

// ValidationError is converted to a stable request.invalid Problem Details response.
type ValidationError struct {
	Code    string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// ParameterPolicy defines how a location parameter may be persisted.
type ParameterPolicy struct {
	Persistence string `json:"persistence"`
}

// ManifestRoute is the validated route portion of application manifest v1.
type ManifestRoute struct {
	PageKey         string                      `json:"pageKey"`
	Template        string                      `json:"template"`
	Label           string                      `json:"label"`
	Group           *string                     `json:"group,omitempty"`
	Parameters      *map[string]ParameterPolicy `json:"parameters,omitempty"`
	QueryParameters *map[string]ParameterPolicy `json:"queryParameters,omitempty"`
	Aliases         *[]string                   `json:"aliases,omitempty"`
}

// Manifest is the strongly typed application manifest v1 contract.
type Manifest struct {
	SchemaVersion   string          `json:"schemaVersion"`
	ApplicationKey  string          `json:"applicationKey"`
	DisplayName     string          `json:"displayName"`
	ManifestVersion string          `json:"manifestVersion"`
	Routes          []ManifestRoute `json:"routes"`
}

// Location is a validated and persistence-policy-sanitized host location.
type Location struct {
	SchemaVersion   string            `json:"schemaVersion"`
	PageKey         string            `json:"pageKey"`
	RouteTemplate   string            `json:"routeTemplate"`
	PathParameters  map[string]string `json:"pathParameters"`
	QueryParameters map[string]string `json:"queryParameters,omitempty"`
}

// DecodeManifest rejects unknown fields and trailing JSON before semantic validation.
func DecodeManifest(body []byte, pathApplicationKey string) (Manifest, error) {
	if err := rejectManifestNulls(body); err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	if err := decodeStrict(body, &manifest); err != nil {
		return Manifest{}, invalid("request.invalid_json", "manifest JSONが不正です: %v", err)
	}
	if err := ValidateManifest(manifest, pathApplicationKey); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// ValidateManifest enforces the invariants in the frozen JSON Schema and Kotlin validator.
func ValidateManifest(manifest Manifest, pathApplicationKey string) error {
	if manifest.SchemaVersion != "1" {
		return invalid("request.invalid", "未対応のmanifest schemaVersionです")
	}
	if err := ValidateApplicationKey(pathApplicationKey); err != nil {
		return err
	}
	if manifest.ApplicationKey != pathApplicationKey {
		return invalid("request.invalid", "pathとmanifestのapplicationKeyが一致しません")
	}
	if _, err := ValidateKey(manifest.DisplayName, "displayName", 200); err != nil {
		return err
	}
	if _, err := ValidateKey(manifest.ManifestVersion, "manifestVersion", 100); err != nil {
		return err
	}
	if len(manifest.Routes) < 1 || len(manifest.Routes) > 500 {
		return invalid("request.invalid", "routesは1件以上500件以下で指定してください")
	}
	pageKeys := make(map[string]struct{}, len(manifest.Routes))
	templates := make(map[string]struct{}, len(manifest.Routes))
	for index, route := range manifest.Routes {
		if !pageKeyPattern.MatchString(route.PageKey) || utf16Length(route.PageKey) > 100 {
			return invalid("request.invalid", "routes[%d].pageKeyが不正です", index)
		}
		if _, exists := pageKeys[route.PageKey]; exists {
			return invalid("request.invalid", "pageKeyが重複しています: %s", route.PageKey)
		}
		pageKeys[route.PageKey] = struct{}{}
		if err := addRouteTemplate(templates, route.Template, fmt.Sprintf("routes[%d].template", index)); err != nil {
			return err
		}
		if _, err := ValidateKey(route.Label, fmt.Sprintf("routes[%d].label", index), 200); err != nil {
			return err
		}
		if route.Group != nil {
			if _, err := ValidateKey(*route.Group, fmt.Sprintf("routes[%d].group", index), 100); err != nil {
				return err
			}
		}
		expectedPathKeys := make(map[string]struct{})
		for _, match := range routeParameterPattern.FindAllStringSubmatch(route.Template, -1) {
			expectedPathKeys[match[1]] = struct{}{}
		}
		if err := validatePolicies(route.Parameters, parameterKeyPattern, fmt.Sprintf("routes[%d].parameters", index), expectedPathKeys); err != nil {
			return err
		}
		if err := validatePolicies(route.QueryParameters, queryKeyPattern, fmt.Sprintf("routes[%d].queryParameters", index), nil); err != nil {
			return err
		}
		if route.Aliases != nil {
			if len(*route.Aliases) > 20 {
				return invalid("request.invalid", "routes[%d].aliasesは20件以下で指定してください", index)
			}
			for _, alias := range *route.Aliases {
				if err := addRouteTemplate(templates, alias, "alias"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// SanitizeLocation applies the manifest persistence policy to request location values.
func SanitizeLocation(
	manifest Manifest,
	pageKey string,
	routeTemplate string,
	pathParametersJSON string,
	queryParametersJSON *string,
) (Location, error) {
	var route *ManifestRoute
	for index := range manifest.Routes {
		candidate := &manifest.Routes[index]
		if candidate.PageKey != pageKey {
			continue
		}
		if candidate.Template == routeTemplate || contains(candidate.Aliases, routeTemplate) {
			route = candidate
			break
		}
	}
	if route == nil {
		return Location{}, invalid("location.unregistered", "locationは登録済みmanifest routeと一致しません")
	}
	pathValues, err := decodeStringObject(pathParametersJSON, "pathParameters", 4000)
	if err != nil {
		return Location{}, err
	}
	queryValues := map[string]string{}
	if queryParametersJSON != nil {
		queryValues, err = decodeStringObject(*queryParametersJSON, "queryParameters", 8000)
		if err != nil {
			return Location{}, err
		}
	}
	pathPolicies := dereferencePolicies(route.Parameters)
	if !sameKeys(pathValues, pathPolicies) {
		return Location{}, invalid("request.invalid", "pathParametersはmanifest parameterと一致させてください")
	}
	sanitizedPath, err := sanitizeParameters(pathValues, pathPolicies, 500)
	if err != nil {
		return Location{}, err
	}
	sanitizedQuery, err := sanitizeParameters(queryValues, dereferencePolicies(route.QueryParameters), 1000)
	if err != nil {
		return Location{}, err
	}
	return Location{
		SchemaVersion:   "1",
		PageKey:         pageKey,
		RouteTemplate:   routeTemplate,
		PathParameters:  sanitizedPath,
		QueryParameters: sanitizedQuery,
	}, nil
}

// ValidateApplicationKey validates the stable application key wire format.
func ValidateApplicationKey(value string) error {
	if !applicationKeyPattern.MatchString(value) {
		return invalid("request.invalid", "applicationKeyが不正です")
	}
	return nil
}

// ValidateUUID はpath parameterをcanonical UUID文字列へ正規化する。
func ValidateUUID(value, name string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", invalid("request.invalid", "%sはUUIDで指定してください", name)
	}
	return parsed.String(), nil
}

// ValidateIdempotencyKey はKotlin String.lengthと同じUTF-16 code unit数で境界を検証する。
func ValidateIdempotencyKey(value string) (string, error) {
	length := utf16Length(value)
	if length < 16 || length > 200 {
		return "", invalid("request.invalid", "Idempotency-Keyは16文字以上200文字以下で指定してください")
	}
	return value, nil
}

// ParseRequiredETag は必須If-MatchをKotlin互換のversionへ変換する。
func ParseRequiredETag(value string) (int, error) {
	if value == "" {
		return 0, invalid("etag.required", "If-Matchが必要です")
	}
	return parseETag(value)
}

// ParseLimit は省略時50、指定時1..200だけを受理する。
func ParseLimit(value *int) (int, error) {
	if value == nil {
		return 50, nil
	}
	if *value < 1 || *value > 200 {
		return 0, invalid("request.invalid", "limitは1以上200以下で指定してください")
	}
	return *value, nil
}

// DecodeCursor はoffset cursorの長さ、URL-safe base64、非負整数をfail-closedで検証する。
func DecodeCursor(value *string) (int, error) {
	if value == nil {
		return 0, nil
	}
	if utf16Length(*value) > 2000 {
		return 0, invalid("request.invalid", "cursorが長すぎます")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*value)
	if err != nil || !strings.HasPrefix(string(decoded), "offset:") {
		return 0, invalid("request.invalid", "cursorが不正です")
	}
	offset, err := strconv.ParseInt(strings.TrimPrefix(string(decoded), "offset:"), 10, 32)
	if err != nil || offset < 0 {
		return 0, invalid("request.invalid", "cursorが不正です")
	}
	return int(offset), nil
}

func EncodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("offset:" + strconv.Itoa(offset)))
}

// CanonicalJSONSHA256 はKotlin JsonElementの再encodeと同様に空白を除き、objectの入力順を保ってhash化する。
func CanonicalJSONSHA256(body []byte) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var canonical bytes.Buffer
	if err := writeCanonicalJSON(decoder, &canonical); err != nil {
		return "", invalid("request.invalid_json", "request JSONが不正です: %v", err)
	}
	if token, err := decoder.Token(); err == nil {
		return "", invalid("request.invalid_json", "request JSONに複数の値があります: %v", token)
	} else if !errors.Is(err, io.EOF) {
		return "", invalid("request.invalid_json", "request JSONが不正です: %v", err)
	}
	hash := sha256.Sum256(canonical.Bytes())
	return hex.EncodeToString(hash[:]), nil
}

func writeCanonicalJSON(decoder *json.Decoder, output *bytes.Buffer) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return writeJSONToken(output, token)
	}
	switch delimiter {
	case '{':
		output.WriteByte('{')
		first := true
		for decoder.More() {
			if !first {
				output.WriteByte(',')
			}
			first = false
			name, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := writeJSONToken(output, name); err != nil {
				return err
			}
			output.WriteByte(':')
			if err := writeCanonicalJSON(decoder, output); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("JSON objectが閉じられていません")
		}
		output.WriteByte('}')
	case '[':
		output.WriteByte('[')
		first := true
		for decoder.More() {
			if !first {
				output.WriteByte(',')
			}
			first = false
			if err := writeCanonicalJSON(decoder, output); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("JSON arrayが閉じられていません")
		}
		output.WriteByte(']')
	default:
		return fmt.Errorf("JSON delimiterが不正です: %q", delimiter)
	}
	return nil
}

func writeJSONToken(output *bytes.Buffer, token any) error {
	if number, ok := token.(json.Number); ok {
		output.WriteString(number.String())
		return nil
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(token); err != nil {
		return err
	}
	output.Write(bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'}))
	return nil
}

func ValidateSessionStatus(value string) (string, error) {
	if value != "draft" && value != "open" && value != "closed" {
		return "", invalid("request.invalid", "session statusが不正です")
	}
	return value, nil
}

func ValidateThreadStatus(value string) (string, error) {
	if value != "open" && value != "resolved" {
		return "", invalid("request.invalid", "thread statusが不正です")
	}
	return value, nil
}

// ValidateKey trims and validates a bounded non-empty value.
func ValidateKey(value, name string, maximum int) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf16Length(trimmed) > maximum {
		return "", invalid("request.invalid", "%sは1文字以上%d文字以下で指定してください", name, maximum)
	}
	return trimmed, nil
}

func decodeStrict(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON値が複数あります")
		}
		return err
	}
	return nil
}

func addRouteTemplate(templates map[string]struct{}, value, subject string) error {
	if !strings.HasPrefix(value, "/") || utf16Length(value) > 500 || strings.ContainsAny(value, "?#") || strings.Contains(value, "//") {
		return invalid("request.invalid", "%sが不正です", subject)
	}
	stripped := routeParameterPattern.ReplaceAllString(value, "x")
	if strings.ContainsAny(stripped, "{}") {
		return invalid("request.invalid", "%sのparameterが不正です", subject)
	}
	if _, exists := templates[value]; exists {
		return invalid("request.invalid", "route template/aliasが重複しています: %s", value)
	}
	templates[value] = struct{}{}
	return nil
}

func validatePolicies(
	policies *map[string]ParameterPolicy,
	keyPattern *regexp.Regexp,
	subject string,
	expectedKeys map[string]struct{},
) error {
	values := dereferencePolicies(policies)
	for key, policy := range values {
		if !keyPattern.MatchString(key) {
			return invalid("request.invalid", "%sのparameter名が不正です: %s", subject, key)
		}
		if policy.Persistence != "store" && policy.Persistence != "hash" && policy.Persistence != "discard" {
			return invalid("request.invalid", "%s.%s.persistenceが不正です", subject, key)
		}
	}
	if expectedKeys != nil && !sameKeySets(values, expectedKeys) {
		return invalid("request.invalid", "%sはtemplate parameterと一致させてください", subject)
	}
	return nil
}

func decodeStringObject(raw, name string, maximum int) (map[string]string, error) {
	if utf16Length(raw) < 2 || utf16Length(raw) > maximum {
		return nil, invalid("request.invalid", "%sが不正です", name)
	}
	var rawValues map[string]json.RawMessage
	if err := decodeStrict([]byte(raw), &rawValues); err != nil || rawValues == nil {
		return nil, invalid("request.invalid", "%sはJSON objectとして指定してください", name)
	}
	result := make(map[string]string, len(rawValues))
	for key, encoded := range rawValues {
		var value string
		if isJSONNull(encoded) || json.Unmarshal(encoded, &value) != nil {
			return nil, invalid("request.invalid", "%sはstring値だけを含むJSON objectとして指定してください", name)
		}
		result[key] = value
	}
	return result, nil
}

func rejectManifestNulls(body []byte) error {
	var root struct {
		Routes []map[string]json.RawMessage `json:"routes"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return invalid("request.invalid_json", "manifest JSONが不正です: %v", err)
	}
	for index, route := range root.Routes {
		for _, name := range []string{"group", "parameters", "queryParameters", "aliases"} {
			if value, exists := route[name]; exists && isJSONNull(value) {
				return invalid("request.invalid_json", "routes[%d].%sにnullは指定できません", index, name)
			}
		}
	}
	return nil
}

func isJSONNull(value []byte) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func sanitizeParameters(values map[string]string, policies map[string]ParameterPolicy, maximum int) (map[string]string, error) {
	result := make(map[string]string)
	for key, value := range values {
		policy, exists := policies[key]
		if !exists {
			continue
		}
		if utf16Length(value) > maximum {
			return nil, invalid("request.invalid", "parameter %sが長すぎます", key)
		}
		switch policy.Persistence {
		case "store":
			result[key] = value
		case "hash":
			hash := sha256.Sum256([]byte(value))
			result[key] = "sha256:" + hex.EncodeToString(hash[:])
		case "discard":
		}
	}
	return result, nil
}

func dereferencePolicies(value *map[string]ParameterPolicy) map[string]ParameterPolicy {
	if value == nil {
		return map[string]ParameterPolicy{}
	}
	return *value
}

func contains(values *[]string, candidate string) bool {
	if values == nil {
		return false
	}
	for _, value := range *values {
		if value == candidate {
			return true
		}
	}
	return false
}

func sameKeys(left map[string]string, right map[string]ParameterPolicy) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if _, exists := right[key]; !exists {
			return false
		}
	}
	return true
}

func sameKeySets(left map[string]ParameterPolicy, right map[string]struct{}) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if _, exists := right[key]; !exists {
			return false
		}
	}
	return true
}

// utf16Length matches Kotlin String.length, which counts UTF-16 code units.
func utf16Length(value string) int {
	length := 0
	for _, codePoint := range value {
		length++
		if codePoint > 0xffff {
			length++
		}
	}
	return length
}

func invalid(code, format string, arguments ...any) error {
	return &ValidationError{Code: code, Message: fmt.Sprintf(format, arguments...)}
}
