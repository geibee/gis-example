package discussion

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var routeParameterPattern = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// BuildDeepLink は保存済みlocationとmanifest policyから既存v1 URLを復元する。
func BuildDeepLink(
	baseURL string,
	deepLinkThreadParameter string,
	manifestRaw json.RawMessage,
	locationRaw json.RawMessage,
	threadID string,
) (string, error) {
	location, err := decodeObject(locationRaw, "location")
	if err != nil {
		return "", err
	}
	pageKey, err := stringValue(location, "pageKey", "location")
	if err != nil {
		return "", err
	}
	routeTemplate, err := stringValue(location, "routeTemplate", "location")
	if err != nil {
		return "", err
	}
	routes, err := parseManifestRoutes(manifestRaw)
	if err != nil {
		return "", fmt.Errorf("manifest routeを読み取れません: %w", err)
	}
	var route *manifestRoute
	for index := range routes {
		candidate := &routes[index]
		if candidate.pageKey == pageKey &&
			(candidate.template == routeTemplate || contains(candidate.aliases, routeTemplate)) {
			route = candidate
			break
		}
	}
	fallback := strings.TrimRight(baseURL, "/") + "/"
	if route == nil {
		return appendQuery(fallback, map[string]string{deepLinkThreadParameter: threadID}), nil
	}

	pathValues := map[string]json.RawMessage{}
	if raw, ok := location["pathParameters"]; ok {
		pathValues, err = decodeObject(raw, "location.pathParameters")
		if err != nil {
			return "", err
		}
	}
	path := routeTemplate
	for _, match := range routeParameterPattern.FindAllStringSubmatch(routeTemplate, -1) {
		name := match[1]
		rawValue, ok := pathValues[name]
		if !ok || route.parameters[name] != "store" {
			return appendQuery(fallback, map[string]string{deepLinkThreadParameter: threadID}), nil
		}
		value, err := primitiveContent(rawValue)
		if err != nil || strings.HasPrefix(value, "sha256:") {
			return appendQuery(fallback, map[string]string{deepLinkThreadParameter: threadID}), nil
		}
		path = strings.ReplaceAll(path, match[0], encodeURLPart(value))
	}

	queryValues := map[string]json.RawMessage{}
	if raw, ok := location["queryParameters"]; ok {
		queryValues, err = decodeObject(raw, "location.queryParameters")
		if err != nil {
			return "", err
		}
	}
	query := make(map[string]string)
	for name, rawValue := range queryValues {
		if route.queryParameters[name] != "store" {
			continue
		}
		value, valueErr := primitiveContent(rawValue)
		if valueErr != nil {
			return "", valueErr
		}
		query[name] = value
	}
	query[deepLinkThreadParameter] = threadID
	return appendQuery(strings.TrimRight(baseURL, "/")+path, query), nil
}

func appendQuery(rawURL string, values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// PostgreSQL jsonb object key順序（byte length、同長はbyte順）へ合わせる。
	sort.Slice(keys, func(left, right int) bool {
		if len(keys[left]) != len(keys[right]) {
			return len(keys[left]) < len(keys[right])
		}
		return keys[left] < keys[right]
	})
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, encodeURLPart(key)+"="+encodeURLPart(values[key]))
	}
	separator := "?"
	if strings.Contains(rawURL, "?") {
		separator = "&"
	}
	return rawURL + separator + strings.Join(parts, "&")
}

func encodeURLPart(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
