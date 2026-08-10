package bootstrap

import (
	"fmt"
	"os"
	"strings"
)

// EnvironmentLookup は環境変数の取得を抽象化し、secret値を引数やfileへ渡さない。
type EnvironmentLookup func(string) (string, bool)

// FromEnv はprocess環境からbootstrap入力を読み取る。
func FromEnv() (Input, error) {
	return ParseEnvironment(os.LookupEnv)
}

// ParseEnvironment はKotlin版と同じFEEDBACK_BOOTSTRAP_*契約をdecodeし、
// 正規化済みの入力を返す。
func ParseEnvironment(lookup EnvironmentLookup) (Input, error) {
	if lookup == nil {
		return Input{}, fmt.Errorf("environment lookupが未設定です")
	}
	required := func(name string) (string, error) {
		value, ok := lookup(name)
		if !ok || strings.TrimSpace(value) == "" {
			return "", fmt.Errorf("%sが未設定です", name)
		}
		return value, nil
	}

	values := make(map[string]string, 13)
	for _, name := range []string{
		"FEEDBACK_BOOTSTRAP_TENANT_KEY",
		"FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME",
		"FEEDBACK_BOOTSTRAP_APPLICATION_KEY",
		"FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME",
		"FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY",
		"FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL",
		"FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS",
		"FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY",
		"FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME",
		"FEEDBACK_BOOTSTRAP_ISSUER",
		"FEEDBACK_BOOTSTRAP_SUBJECT",
		"FEEDBACK_BOOTSTRAP_PERMISSIONS",
	} {
		value, err := required(name)
		if err != nil {
			return Input{}, err
		}
		values[name] = value
	}

	permissions := make([]Permission, 0)
	for _, raw := range strings.Split(values["FEEDBACK_BOOTSTRAP_PERMISSIONS"], ",") {
		permissions = append(permissions, Permission(strings.TrimSpace(raw)))
	}
	input := Input{
		TenantKey:              values["FEEDBACK_BOOTSTRAP_TENANT_KEY"],
		TenantDisplayName:      values["FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME"],
		ApplicationKey:         values["FEEDBACK_BOOTSTRAP_APPLICATION_KEY"],
		ApplicationDisplayName: values["FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME"],
		EnvironmentKey:         values["FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY"],
		EnvironmentBaseURL:     values["FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL"],
		AllowedOrigins:         strings.Split(values["FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS"], ","),
		ExternalWorkspaceKey:   values["FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY"],
		WorkspaceDisplayName:   values["FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME"],
		Issuer:                 values["FEEDBACK_BOOTSTRAP_ISSUER"],
		Subject:                values["FEEDBACK_BOOTSTRAP_SUBJECT"],
		Email:                  optionalEnvironment(lookup, "FEEDBACK_BOOTSTRAP_EMAIL"),
		DisplayName:            optionalEnvironment(lookup, "FEEDBACK_BOOTSTRAP_DISPLAY_NAME"),
		Permissions:            permissions,
	}
	validated, err := validateInput(input)
	if err != nil {
		return Input{}, err
	}
	return validated.toInput(), nil
}

func optionalEnvironment(lookup EnvironmentLookup, name string) *string {
	value, ok := lookup(name)
	if !ok || strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
