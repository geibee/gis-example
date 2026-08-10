package bootstrap

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

var applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

type validatedInput struct {
	tenantKey              string
	tenantDisplayName      string
	applicationKey         string
	applicationDisplayName string
	environmentKey         string
	environmentBaseURL     string
	allowedOrigins         []string
	externalWorkspaceKey   string
	workspaceDisplayName   string
	issuer                 string
	subject                string
	email                  *string
	displayName            *string
	permissions            []string
}

func (input validatedInput) toInput() Input {
	permissions := make([]Permission, len(input.permissions))
	for index, value := range input.permissions {
		permissions[index] = Permission(value)
	}
	return Input{
		TenantKey:              input.tenantKey,
		TenantDisplayName:      input.tenantDisplayName,
		ApplicationKey:         input.applicationKey,
		ApplicationDisplayName: input.applicationDisplayName,
		EnvironmentKey:         input.environmentKey,
		EnvironmentBaseURL:     input.environmentBaseURL,
		AllowedOrigins:         append([]string(nil), input.allowedOrigins...),
		ExternalWorkspaceKey:   input.externalWorkspaceKey,
		WorkspaceDisplayName:   input.workspaceDisplayName,
		Issuer:                 input.issuer,
		Subject:                input.subject,
		Email:                  cloneString(input.email),
		DisplayName:            cloneString(input.displayName),
		Permissions:            permissions,
	}
}

func validateInput(input Input) (validatedInput, error) {
	tenantKey, err := validateText(input.TenantKey, "tenantKey", 100)
	if err != nil {
		return validatedInput{}, err
	}
	tenantDisplayName, err := validateText(input.TenantDisplayName, "tenantDisplayName", 200)
	if err != nil {
		return validatedInput{}, err
	}
	if !applicationKeyPattern.MatchString(input.ApplicationKey) {
		return validatedInput{}, errors.New("applicationKeyが不正です")
	}
	applicationDisplayName, err := validateText(input.ApplicationDisplayName, "applicationDisplayName", 200)
	if err != nil {
		return validatedInput{}, err
	}
	environmentKey, err := validateText(input.EnvironmentKey, "environmentKey", 100)
	if err != nil {
		return validatedInput{}, err
	}
	environmentBaseURL, err := validateServiceURL(input.EnvironmentBaseURL, "environment base URL", 2000)
	if err != nil {
		return validatedInput{}, err
	}
	if len(input.AllowedOrigins) == 0 {
		return validatedInput{}, errors.New("allowedOriginsは1件以上必要です")
	}
	allowedOrigins := make([]string, 0, len(input.AllowedOrigins))
	seenOrigins := make(map[string]struct{}, len(input.AllowedOrigins))
	for _, raw := range input.AllowedOrigins {
		origin, originErr := validateOrigin(strings.TrimSpace(raw))
		if originErr != nil {
			return validatedInput{}, originErr
		}
		if _, exists := seenOrigins[origin]; exists {
			continue
		}
		seenOrigins[origin] = struct{}{}
		allowedOrigins = append(allowedOrigins, origin)
	}
	externalWorkspaceKey, err := validateText(input.ExternalWorkspaceKey, "externalWorkspaceKey", 200)
	if err != nil {
		return validatedInput{}, err
	}
	workspaceDisplayName, err := validateText(input.WorkspaceDisplayName, "workspaceDisplayName", 200)
	if err != nil {
		return validatedInput{}, err
	}
	issuer, err := validateServiceURL(input.Issuer, "issuer", 1000)
	if err != nil {
		return validatedInput{}, err
	}
	issuer = strings.TrimRight(issuer, "/")
	subject, err := validateText(input.Subject, "subject", 200)
	if err != nil {
		return validatedInput{}, err
	}
	email, err := validateOptional(input.Email, "email", 320)
	if err != nil {
		return validatedInput{}, err
	}
	displayName, err := validateOptional(input.DisplayName, "displayName", 200)
	if err != nil {
		return validatedInput{}, err
	}
	permissions, err := validatePermissions(input.Permissions)
	if err != nil {
		return validatedInput{}, err
	}

	return validatedInput{
		tenantKey:              tenantKey,
		tenantDisplayName:      tenantDisplayName,
		applicationKey:         input.ApplicationKey,
		applicationDisplayName: applicationDisplayName,
		environmentKey:         environmentKey,
		environmentBaseURL:     environmentBaseURL,
		allowedOrigins:         allowedOrigins,
		externalWorkspaceKey:   externalWorkspaceKey,
		workspaceDisplayName:   workspaceDisplayName,
		issuer:                 issuer,
		subject:                subject,
		email:                  email,
		displayName:            displayName,
		permissions:            permissions,
	}, nil
}

func validatePermissions(values []Permission) ([]string, error) {
	if len(values) == 0 {
		return nil, errors.New("permissionsは1件以上必要です")
	}
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !auth.IsValidPermission(value) {
			return nil, fmt.Errorf("不明なfeedback permissionです: %s", value)
		}
		unique[string(value)] = struct{}{}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func validateText(raw string, name string, maximum int) (string, error) {
	value := strings.TrimSpace(raw)
	length := utf16Length(value)
	if length == 0 || length > maximum {
		return "", fmt.Errorf("%sは1文字以上%d文字以下で指定してください", name, maximum)
	}
	return value, nil
}

func validateOptional(raw *string, name string, maximum int) (*string, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	if utf16Length(*raw) > maximum {
		return nil, fmt.Errorf("%sは%d文字以下で指定してください", name, maximum)
	}
	value := *raw
	return &value, nil
}

func validateOrigin(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("originが不正です: %w", err)
	}
	localHTTP := parsed.Scheme == "http" && isLocalHost(parsed.Hostname())
	if (parsed.Scheme != "https" && !localHTTP) || parsed.Hostname() == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || strings.Contains(raw, "#") {
		return "", fmt.Errorf("originはhttps://host[:port]（ローカル開発だけhttp://localhost）で指定してください: %s", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

func validateServiceURL(raw string, name string, maximum int) (string, error) {
	if utf16Length(raw) > maximum {
		return "", fmt.Errorf("%sは%d文字以下で指定してください", name, maximum)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%sが不正です: %w", name, err)
	}
	localHTTP := parsed.Scheme == "http" && isLocalHost(parsed.Hostname())
	if (parsed.Scheme != "https" && !localHTTP) || parsed.Hostname() == "" || parsed.User != nil ||
		parsed.Fragment != "" || strings.Contains(raw, "#") {
		return "", fmt.Errorf("%sはuserinfo/fragmentを含まないhttps URL（ローカル開発だけhttp://localhost）で指定してください", name)
	}
	return raw, nil
}

func isLocalHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
