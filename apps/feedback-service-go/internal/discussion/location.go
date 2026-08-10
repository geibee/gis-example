package discussion

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
)

type manifestRoute struct {
	pageKey         string
	template        string
	aliases         []string
	parameters      map[string]string
	queryParameters map[string]string
}

// SanitizeLocation はmanifestのpersistence policyに従いlocationを保存可能な形へ変換する。
func SanitizeLocation(locationRaw json.RawMessage, manifestRaw json.RawMessage) (json.RawMessage, error) {
	location, err := decodeObject(locationRaw, "location")
	if err != nil {
		return nil, err
	}
	if err := requireKeys(
		location,
		[]string{"schemaVersion", "pageKey", "routeTemplate", "pathParameters"},
		[]string{"queryParameters"}, "location",
	); err != nil {
		return nil, err
	}
	schemaVersion, err := stringValue(location, "schemaVersion", "location")
	if err != nil || schemaVersion != "1" {
		return nil, invalid("request.invalid", "location.schemaVersionは1を指定してください")
	}
	pageKey, err := stringValue(location, "pageKey", "location")
	if err != nil {
		return nil, err
	}
	routeTemplate, err := stringValue(location, "routeTemplate", "location")
	if err != nil {
		return nil, err
	}
	routes, err := parseManifestRoutes(manifestRaw)
	if err != nil {
		return nil, fmt.Errorf("manifest routeを読み取れません: %w", err)
	}
	var selected *manifestRoute
	for index := range routes {
		candidate := &routes[index]
		if candidate.pageKey != pageKey ||
			(candidate.template != routeTemplate && !contains(candidate.aliases, routeTemplate)) {
			continue
		}
		selected = candidate
		break
	}
	if selected == nil {
		return nil, invalid("location.unregistered", "locationは登録済みmanifest routeと一致しません")
	}

	pathValues, err := decodeObject(location["pathParameters"], "location.pathParameters")
	if err != nil {
		return nil, err
	}
	if !sameKeys(pathValues, selected.parameters) {
		return nil, invalid("request.invalid", "pathParametersはmanifest parameterと一致させてください")
	}
	queryValues := map[string]json.RawMessage{}
	if raw, ok := location["queryParameters"]; ok {
		queryValues, err = decodeObject(raw, "location.queryParameters")
		if err != nil {
			return nil, err
		}
	}
	sanitizedPath, err := sanitizeParameters(pathValues, selected.parameters, 500)
	if err != nil {
		return nil, err
	}
	sanitizedQuery, err := sanitizeParameters(queryValues, selected.queryParameters, 1000)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"schemaVersion":  "1",
		"pageKey":        pageKey,
		"routeTemplate":  routeTemplate,
		"pathParameters": sanitizedPath,
	}
	if len(sanitizedQuery) != 0 {
		result["queryParameters"] = sanitizedQuery
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("locationをencodeできません: %w", err)
	}
	return encoded, nil
}

func parseManifestRoutes(raw json.RawMessage) ([]manifestRoute, error) {
	manifest, err := decodeObject(raw, "manifest")
	if err != nil {
		return nil, err
	}
	var routeValues []json.RawMessage
	if err := json.Unmarshal(manifest["routes"], &routeValues); err != nil {
		return nil, err
	}
	routes := make([]manifestRoute, 0, len(routeValues))
	for index, rawRoute := range routeValues {
		object, err := decodeObject(rawRoute, fmt.Sprintf("manifest.routes[%d]", index))
		if err != nil {
			return nil, err
		}
		pageKey, err := stringValue(object, "pageKey", "manifest route")
		if err != nil {
			return nil, err
		}
		template, err := stringValue(object, "template", "manifest route")
		if err != nil {
			return nil, err
		}
		aliases := make([]string, 0)
		if rawAliases, ok := object["aliases"]; ok {
			if err := json.Unmarshal(rawAliases, &aliases); err != nil {
				return nil, err
			}
		}
		parameters, err := parseParameterPolicies(object["parameters"])
		if err != nil {
			return nil, err
		}
		queryParameters, err := parseParameterPolicies(object["queryParameters"])
		if err != nil {
			return nil, err
		}
		routes = append(routes, manifestRoute{
			pageKey: pageKey, template: template, aliases: aliases,
			parameters: parameters, queryParameters: queryParameters,
		})
	}
	return routes, nil
}

func parseParameterPolicies(raw json.RawMessage) (map[string]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]string{}, nil
	}
	values, err := decodeObject(raw, "parameter policies")
	if err != nil {
		return nil, err
	}
	result := make(map[string]string, len(values))
	for name, rawPolicy := range values {
		policy, err := decodeObject(rawPolicy, "parameter policy")
		if err != nil {
			return nil, err
		}
		persistence, err := stringValue(policy, "persistence", "parameter policy")
		if err != nil {
			return nil, err
		}
		result[name] = persistence
	}
	return result, nil
}

func sanitizeParameters(
	values map[string]json.RawMessage,
	policies map[string]string,
	maximum int,
) (map[string]string, error) {
	result := make(map[string]string)
	// error順序を安定させ、DB jsonbのobject key順序に依存させない。
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		persistence, ok := policies[key]
		if !ok {
			continue
		}
		value, err := primitiveContent(values[key])
		if err != nil {
			return nil, invalid("request.invalid", "parameter "+key+"はprimitiveで指定してください")
		}
		if utf16Length(value) > maximum {
			return nil, invalid("request.invalid", "parameter "+key+"が長すぎます")
		}
		switch persistence {
		case "store":
			result[key] = value
		case "hash":
			hash := sha256.Sum256([]byte(value))
			result[key] = "sha256:" + hex.EncodeToString(hash[:])
		case "discard":
		default:
			return nil, fmt.Errorf("manifest persistence policyが不正です: %q", persistence)
		}
	}
	return result, nil
}

func primitiveContent(raw json.RawMessage) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	switch typed := value.(type) {
	case string:
		return typed, nil
	case json.Number:
		return typed.String(), nil
	case bool:
		return strconv.FormatBool(typed), nil
	case nil:
		return "null", nil
	default:
		return "", errors.New("not a primitive")
	}
}

func sameKeys(left map[string]json.RawMessage, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if _, ok := right[key]; !ok {
			return false
		}
	}
	return true
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
