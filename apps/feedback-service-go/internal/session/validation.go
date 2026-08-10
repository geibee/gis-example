package session

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
)

func ValidateCreate(request CreateRequest) error {
	if err := ValidateApplicationKey(request.ApplicationKey); err != nil {
		return err
	}
	if _, err := ValidateKey(request.EnvironmentKey, "environmentKey", 100); err != nil {
		return err
	}
	if _, err := ValidateKey(request.ExternalWorkspaceKey, "externalWorkspaceKey", 200); err != nil {
		return err
	}
	if _, err := ValidateKey(request.ManifestVersion, "manifestVersion", 100); err != nil {
		return err
	}
	if _, err := ValidateKey(request.Title, "title", 200); err != nil {
		return err
	}
	if request.Description != nil && utf16Length(*request.Description) > 5000 {
		return invalid("request.invalid", "description が長すぎます")
	}
	if request.Status != "" && !ValidStatus(request.Status) {
		return invalid("request.invalid", "status が不正です")
	}
	posting := request.OutOfScopePosting
	if posting == "" {
		posting = OutOfScopeWarn
	}
	if !validOutOfScopePosting(posting) {
		return invalid("request.invalid", "outOfScopePosting が不正です")
	}
	start, err := validateOptionalInstant(request.StartAt, "startAt")
	if err != nil {
		return err
	}
	end, err := validateOptionalInstant(request.EndAt, "endAt")
	if err != nil {
		return err
	}
	if start != nil && end != nil && end.Before(*start) {
		return invalid("request.invalid", "endAt は startAt 以後を指定してください")
	}
	return ValidateChildren(request.Scopes, request.Perspectives)
}

func NormalizeCreate(request CreateRequest) CreateRequest {
	request.Title = strings.TrimSpace(request.Title)
	if request.Status == "" {
		request.Status = StatusDraft
	}
	if request.OutOfScopePosting == "" {
		request.OutOfScopePosting = OutOfScopeWarn
	}
	if request.Scopes == nil {
		request.Scopes = []Scope{}
	}
	if request.Perspectives == nil {
		request.Perspectives = []Perspective{}
	}
	return request
}

func ValidatePatch(patch Patch, current Session) error {
	if patch.ExpectedVersion < 1 {
		return invalid("etag.invalid", "If-Match は応答された ETag をそのまま指定してください")
	}
	if patch.Empty() {
		return invalid("request.invalid", "PATCH body が空です")
	}
	if patch.Title != nil {
		if _, err := ValidateKey(*patch.Title, "title", 200); err != nil {
			return err
		}
	}
	if patch.Description.Present && patch.Description.Value != nil && utf16Length(*patch.Description.Value) > 5000 {
		return invalid("request.invalid", "description が長すぎます")
	}
	if patch.Status != nil && !ValidStatus(*patch.Status) {
		return invalid("request.invalid", "status が不正です")
	}
	if patch.OutOfScopePosting != nil && !validOutOfScopePosting(*patch.OutOfScopePosting) {
		return invalid("request.invalid", "outOfScopePosting が不正です")
	}
	if patch.StartAt.Present && patch.StartAt.Value != nil {
		if _, err := validateOptionalInstant(patch.StartAt.Value, "startAt"); err != nil {
			return err
		}
	}
	if patch.EndAt.Present && patch.EndAt.Value != nil {
		if _, err := validateOptionalInstant(patch.EndAt.Value, "endAt"); err != nil {
			return err
		}
	}

	// KotlinのElvis評価と同じく、明示nullは比較時だけ現在値へfallbackする。
	nextStart := current.StartAt
	if patch.StartAt.Present && patch.StartAt.Value != nil {
		nextStart = patch.StartAt.Value
	}
	nextEnd := current.EndAt
	if patch.EndAt.Present && patch.EndAt.Value != nil {
		nextEnd = patch.EndAt.Value
	}
	start, err := validateOptionalInstant(nextStart, "startAt")
	if err != nil {
		return err
	}
	end, err := validateOptionalInstant(nextEnd, "endAt")
	if err != nil {
		return err
	}
	if start != nil && end != nil && end.Before(*start) {
		return invalid("request.invalid", "endAt は startAt 以後を指定してください")
	}
	nextScopes := current.Scopes
	if patch.Scopes != nil {
		nextScopes = *patch.Scopes
	}
	nextPerspectives := current.Perspectives
	if patch.Perspectives != nil {
		nextPerspectives = *patch.Perspectives
	}
	if err := ValidateChildren(nextScopes, nextPerspectives); err != nil {
		return err
	}
	return nil
}

func ValidateChildren(scopes []Scope, perspectives []Perspective) error {
	scopeKeys := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		route := "<null>"
		if scope.RouteTemplate != nil {
			route = "<value>" + *scope.RouteTemplate
		}
		key := scope.PageKey + "\x00" + route
		if _, exists := scopeKeys[key]; exists {
			return invalid("request.invalid", "scope が重複しています")
		}
		scopeKeys[key] = struct{}{}
		if _, err := ValidateKey(scope.PageKey, "scope.pageKey", 100); err != nil {
			return err
		}
		if scope.RouteTemplate != nil && utf16Length(*scope.RouteTemplate) > 500 {
			return invalid("request.invalid", "scope.routeTemplate が長すぎます")
		}
		if len(scope.PerspectiveCodes) > 100 {
			return invalid("request.invalid", "scope.perspectiveCodes は100件以下で指定してください")
		}
		assigned := make(map[string]struct{}, len(scope.PerspectiveCodes))
		for _, code := range scope.PerspectiveCodes {
			if _, err := ValidateKey(code, "scope.perspectiveCodes", 100); err != nil {
				return err
			}
			if _, exists := assigned[code]; exists {
				return invalid("request.invalid", "scope.perspectiveCodes が重複しています")
			}
			assigned[code] = struct{}{}
		}
	}
	perspectiveCodes := make(map[string]string, len(perspectives))
	for _, perspective := range perspectives {
		if _, exists := perspectiveCodes[perspective.Code]; exists {
			return invalid("request.invalid", "perspective code が重複しています")
		}
		perspectiveCodes[perspective.Code] = perspective.Status
		if _, err := ValidateKey(perspective.Code, "perspective.code", 100); err != nil {
			return err
		}
		if _, err := ValidateKey(perspective.Label, "perspective.label", 200); err != nil {
			return err
		}
		if perspective.Status != PerspectiveActive && perspective.Status != PerspectiveFuture &&
			perspective.Status != PerspectiveOutOfScope {
			return invalid("request.invalid", "perspective.status が不正です")
		}
		if perspective.Guidance != nil && utf16Length(*perspective.Guidance) > 5000 {
			return invalid("request.invalid", "perspective.guidance が長すぎます")
		}
	}
	for _, scope := range scopes {
		for _, code := range scope.PerspectiveCodes {
			status, exists := perspectiveCodes[code]
			if !exists {
				return invalid("request.invalid", "scope.perspectiveCodes に未定義の観点があります")
			}
			if status != PerspectiveActive {
				return invalid("request.invalid", "scope.perspectiveCodes には今回確認する観点だけを指定してください")
			}
		}
	}
	return nil
}

func ValidateApplicationKey(value string) error {
	if !applicationKeyPattern.MatchString(value) {
		return invalid("request.invalid", "applicationKey が不正です")
	}
	return nil
}

func ValidateKey(value, name string, maximum int) (string, error) {
	trimmed := strings.TrimSpace(value)
	length := utf16Length(trimmed)
	if length == 0 || length > maximum {
		return "", invalid("request.invalid", fmt.Sprintf("%s は 1 文字以上 %d 文字以下で指定してください", name, maximum))
	}
	return trimmed, nil
}

func ValidateUUID(value, name string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", invalid("request.invalid", fmt.Sprintf("%s は UUID で指定してください", name))
	}
	return parsed.String(), nil
}

func ValidStatus(value string) bool {
	return value == StatusDraft || value == StatusOpen || value == StatusClosed
}

func ValidateIdempotencyKey(value string) error {
	if value == "" {
		return invalid("idempotency.required", "Idempotency-Key が必要です")
	}
	length := utf16Length(value)
	if length < 16 || length > 200 {
		return invalid("request.invalid", "Idempotency-Key は 16 文字以上 200 文字以下で指定してください")
	}
	return nil
}

func ValidateRequestHash(value string) error {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || value != strings.ToLower(value) {
		return invalid("request.invalid", "request hash が不正です")
	}
	return nil
}

func EncodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("offset:%d", offset)))
}

func DecodeCursor(cursor *string) (int, error) {
	if cursor == nil {
		return 0, nil
	}
	if utf16Length(*cursor) > 2000 {
		return 0, invalid("request.invalid", "cursor が長すぎます")
	}
	decoded, err := decodeBase64URL(*cursor)
	if err != nil {
		return 0, invalid("request.invalid", "cursor が不正です")
	}
	raw := string(decoded)
	if !strings.HasPrefix(raw, "offset:") {
		return 0, invalid("request.invalid", "cursor が不正です")
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(raw, "offset:"))
	if err != nil || offset < 0 {
		return 0, invalid("request.invalid", "cursor が不正です")
	}
	return offset, nil
}

func NormalizeLimit(limit *int) (int, error) {
	if limit == nil {
		return 50, nil
	}
	if *limit < 1 || *limit > 200 {
		return 0, invalid("request.invalid", "limit は 1 以上 200 以下で指定してください")
	}
	return *limit, nil
}

func decodeBase64URL(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err == nil {
		return decoded, nil
	}
	return base64.URLEncoding.DecodeString(value)
}

func validOutOfScopePosting(value string) bool {
	return value == OutOfScopeAllow || value == OutOfScopeWarn || value == OutOfScopeDeny
}

func validateOptionalInstant(value *string, name string) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil, invalid("request.invalid", fmt.Sprintf("%s は RFC 3339 date-time で指定してください", name))
	}
	return &parsed, nil
}

func utf16Length(value string) int {
	if !utf8.ValidString(value) {
		return 0
	}
	return len(utf16.Encode([]rune(value)))
}

func invalid(code, detail string) error {
	return &ValidationError{Code: code, Detail: detail}
}
