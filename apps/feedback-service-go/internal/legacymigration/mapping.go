package legacymigration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
)

type legacyManifest struct {
	Routes []legacyManifestRoute `json:"routes"`
}

type legacyManifestRoute struct {
	PageKey  string `json:"pageKey"`
	Template string `json:"template"`
}

func mapThreads(snapshot Snapshot, manifest json.RawMessage) ([]MappedThread, error) {
	var parsedManifest legacyManifest
	if err := json.Unmarshal(manifest, &parsedManifest); err != nil || len(parsedManifest.Routes) == 0 {
		return nil, invalidSnapshot("manifest routesを読み取れません")
	}
	result := make([]MappedThread, 0, len(snapshot.Threads))
	for _, thread := range snapshot.Threads {
		location, err := mapLocation(thread, parsedManifest, manifest)
		if err != nil {
			return nil, err
		}
		target, err := mapTarget(thread)
		if err != nil {
			return nil, err
		}
		result = append(result, MappedThread{Source: thread, Location: location, Target: target})
	}
	return result, nil
}

func mapLocation(thread ThreadSnapshot, manifest legacyManifest, manifestRaw json.RawMessage) (json.RawMessage, error) {
	if thread.PageRoute == nil {
		return nil, invalidSnapshot("thread " + thread.ID + ": pageRouteがありません")
	}
	uri, err := url.Parse(*thread.PageRoute)
	if err != nil || uri.Path == "" {
		return nil, invalidSnapshot("thread " + thread.ID + ": pageRouteが不正です")
	}
	var selected *legacyManifestRoute
	var pathParameters map[string]string
	for index := range manifest.Routes {
		candidate := &manifest.Routes[index]
		parameters := routeParameters(candidate.Template, uri.Path)
		if parameters != nil && candidate.PageKey == thread.PageID {
			selected, pathParameters = candidate, parameters
			break
		}
	}
	if selected == nil {
		for index := range manifest.Routes {
			candidate := &manifest.Routes[index]
			parameters := routeParameters(candidate.Template, uri.Path)
			if parameters != nil {
				selected, pathParameters = candidate, parameters
				break
			}
		}
	}
	if selected == nil {
		return nil, invalidSnapshot("thread " + thread.ID + ": pageRouteはmanifestに登録されていません")
	}
	location := map[string]any{
		"schemaVersion": "1", "pageKey": selected.PageKey, "routeTemplate": selected.Template,
		"pathParameters": pathParameters,
	}
	query := parseLegacyQuery(uri.RawQuery)
	if len(query) != 0 {
		location["queryParameters"] = query
	}
	raw, err := json.Marshal(location)
	if err != nil {
		return nil, err
	}
	sanitized, err := discussion.SanitizeLocation(raw, manifestRaw)
	if err != nil {
		return nil, invalidSnapshot("thread " + thread.ID + ": locationを変換できません")
	}
	return sanitized, nil
}

func mapTarget(thread ThreadSnapshot) (json.RawMessage, error) {
	var source map[string]json.RawMessage
	if err := json.Unmarshal(thread.TargetMetadata, &source); err != nil {
		return nil, invalidSnapshot("thread " + thread.ID + ": targetMetadataが不正です")
	}
	require := func(name string) (json.RawMessage, error) {
		value, exists := source[name]
		if !exists {
			return nil, invalidSnapshot("thread " + thread.ID + ": target." + name + "がありません")
		}
		return value, nil
	}
	target := make(map[string]any)
	target["schemaVersion"] = "1"
	switch thread.TargetType {
	case "UI_ELEMENT":
		target["kind"] = "ui-element"
		for sourceName, targetName := range map[string]string{"feedbackTargetId": "elementKey", "relativeX": "relativeX", "relativeY": "relativeY"} {
			value, err := require(sourceName)
			if err != nil {
				return nil, err
			}
			target[targetName] = value
		}
	case "SCREEN_POSITION":
		target["kind"] = "screen-position"
		for _, name := range []string{"relativeX", "relativeY"} {
			value, err := require(name)
			if err != nil {
				return nil, err
			}
			target[name] = value
		}
	case "MAP_FEATURE":
		target["kind"], target["provider"] = "map-feature", "maplibre"
		for sourceName, targetName := range map[string]string{
			"source": "sourceKey", "featureId": "featureKey", "longitude": "longitude", "latitude": "latitude",
		} {
			value, err := require(sourceName)
			if err != nil {
				return nil, err
			}
			target[targetName] = value
		}
		if value, exists := source["sourceLayer"]; exists {
			target["sourceLayer"] = value
		}
	case "MAP_POSITION":
		target["kind"] = "map-position"
		for _, name := range []string{"longitude", "latitude"} {
			value, err := require(name)
			if err != nil {
				return nil, err
			}
			target[name] = value
		}
	default:
		return nil, invalidSnapshot("thread " + thread.ID + ": targetTypeが不正です")
	}
	raw, err := json.Marshal(target)
	if err != nil {
		return nil, err
	}
	validated, err := discussion.ValidateTarget(raw)
	if err != nil {
		return nil, invalidSnapshot("thread " + thread.ID + ": targetが不正です")
	}
	return validated, nil
}

var routeParameterPattern = regexp.MustCompile(`^\{([A-Za-z_][A-Za-z0-9_]*)\}$`)

func routeParameters(template string, path string) map[string]string {
	templateParts := splitRoute(template)
	pathParts := splitRoute(path)
	if len(templateParts) != len(pathParts) {
		return nil
	}
	result := make(map[string]string)
	for index, expected := range templateParts {
		actual := pathParts[index]
		match := routeParameterPattern.FindStringSubmatch(expected)
		if match == nil {
			if expected != actual {
				return nil
			}
			continue
		}
		decoded, err := url.QueryUnescape(actual)
		if err != nil {
			return nil
		}
		result[match[1]] = decoded
	}
	return result
}

func splitRoute(value string) []string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return []string{}
	}
	return strings.Split(trimmed, "/")
}

func parseLegacyQuery(raw string) map[string]string {
	result := make(map[string]string)
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		decodedName, nameErr := url.QueryUnescape(name)
		decodedValue, valueErr := url.QueryUnescape(value)
		if nameErr == nil && valueErr == nil {
			result[decodedName] = decodedValue
		}
	}
	return result
}

var sensitiveAuditFragments = []string{
	"password", "secret", "token", "credential", "apikey", "api_key", "body", "evidence",
}

func SanitizeAuditChanges(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, invalidSnapshot("audit changesが不正です")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, invalidSnapshot("audit changesはobjectで指定してください")
	}
	sanitized := sanitizeAuditElement(object, "changes")
	return json.Marshal(sanitized)
}

func sanitizeAuditElement(value any, fieldName string) any {
	for _, fragment := range sensitiveAuditFragments {
		if strings.Contains(strings.ToLower(fieldName), fragment) {
			return "***"
		}
	}
	var result any
	switch typed := value.(type) {
	case map[string]any:
		mapped := make(map[string]any, len(typed))
		for key, child := range typed {
			mapped[key] = sanitizeAuditElement(child, key)
		}
		result = mapped
	case []any:
		limit := min(len(typed), 100)
		mapped := make([]any, limit)
		for index := range limit {
			mapped[index] = sanitizeAuditElement(typed[index], fieldName)
		}
		result = mapped
	default:
		result = value
	}
	encoded, _ := json.Marshal(result)
	if len(encoded) <= 1000 {
		return result
	}
	hash := sha256.Sum256(encoded)
	return map[string]any{
		"truncated": true,
		"sizeChars": len(utf16.Encode([]rune(string(encoded)))),
		"sha256":    hex.EncodeToString(hash[:])[:16],
	}
}
