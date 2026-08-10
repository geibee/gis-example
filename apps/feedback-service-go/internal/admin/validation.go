package admin

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

var applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

func validateWorkspace(input WorkspaceInput) (WorkspaceInput, error) {
	if !applicationKeyPattern.MatchString(input.ApplicationKey) {
		return WorkspaceInput{}, invalid("applicationKeyが不正です")
	}
	workspaceKey := strings.TrimSpace(input.ExternalWorkspaceKey)
	if utf16Length(workspaceKey) < 1 || utf16Length(workspaceKey) > 200 {
		return WorkspaceInput{}, invalid("externalWorkspaceKeyは1文字以上200文字以下で指定してください")
	}
	input.ExternalWorkspaceKey = workspaceKey
	return input, nil
}

func validateCreate(input MembershipCreate) (MembershipCreate, error) {
	if utf16Length(strings.TrimSpace(input.Issuer)) < 1 || utf16Length(strings.TrimSpace(input.Issuer)) > 1000 {
		return MembershipCreate{}, invalid("issuerは1文字以上1000文字以下で指定してください")
	}
	if utf16Length(strings.TrimSpace(input.Subject)) < 1 || utf16Length(strings.TrimSpace(input.Subject)) > 200 {
		return MembershipCreate{}, invalid("subjectは1文字以上200文字以下で指定してください")
	}
	permissions, err := validatePermissions(input.Permissions)
	if err != nil {
		return MembershipCreate{}, err
	}
	input.Permissions = permissions
	return input, nil
}

func validatePatch(input MembershipPatch) (MembershipPatch, error) {
	permissions, err := validatePermissions(input.Permissions)
	if err != nil {
		return MembershipPatch{}, err
	}
	input.Permissions = permissions
	return input, nil
}

func validatePermissions(values []auth.Permission) ([]auth.Permission, error) {
	if len(values) == 0 {
		return nil, invalid("permissionsはFeedback permissionを重複なく1件以上指定してください")
	}
	seen := make(map[auth.Permission]struct{}, len(values))
	for _, permission := range values {
		if !auth.IsValidPermission(permission) {
			return nil, invalid("permissionsはFeedback permissionを重複なく1件以上指定してください")
		}
		if _, exists := seen[permission]; exists {
			return nil, invalid("permissionsはFeedback permissionを重複なく1件以上指定してください")
		}
		seen[permission] = struct{}{}
	}
	result := append([]auth.Permission(nil), values...)
	slices.Sort(result)
	return result, nil
}

func validateUUID(raw string, name string) (string, error) {
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return "", invalid(name + "はUUIDで指定してください")
	}
	return parsed.String(), nil
}

func validateExpectedVersion(value int) error {
	if value <= 0 {
		return invalid("If-Matchが不正です")
	}
	return nil
}

func validateIdempotency(key string, hash string) error {
	if utf16Length(key) < 16 || utf16Length(key) > 200 {
		return invalid("Idempotency-Keyは16文字以上200文字以下で指定してください")
	}
	if len(hash) != 64 {
		return invalid("request hashが不正です")
	}
	for _, character := range hash {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return invalid("request hashが不正です")
		}
	}
	return nil
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }
