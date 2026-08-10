package export

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
)

var applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

func ValidateRequest(request Request) error {
	if !applicationKeyPattern.MatchString(request.ApplicationKey) {
		return invalid("request.invalid", "applicationKey が不正です")
	}
	if _, err := ValidateKey(request.EnvironmentKey, "environmentKey", 100); err != nil {
		return err
	}
	if _, err := ValidateKey(request.ExternalWorkspaceKey, "externalWorkspaceKey", 200); err != nil {
		return err
	}
	if request.SessionID != nil {
		if _, err := uuid.Parse(*request.SessionID); err != nil {
			return invalid("request.invalid", "sessionId は UUID で指定してください")
		}
	}
	if request.Format != FormatCSV && request.Format != FormatXLSX {
		return invalid("request.invalid", "format は csv または xlsx を指定してください")
	}
	if _, err := ValidateKey(request.Locale, "locale", 35); err != nil {
		return err
	}
	if _, err := ValidateKey(request.Timezone, "timezone", 100); err != nil {
		return err
	}
	if _, err := time.LoadLocation(request.Timezone); err != nil {
		return invalid("request.invalid", "timezone はIANA timezone IDで指定してください")
	}
	return nil
}

func NormalizeRequest(request Request) Request {
	if request.Locale == "" {
		request.Locale = "ja-JP"
	}
	if request.Timezone == "" {
		request.Timezone = "Asia/Tokyo"
	}
	return request
}

func ValidateScopeKeys(applicationKey, environmentKey, workspaceKey string) (string, string, error) {
	if !applicationKeyPattern.MatchString(applicationKey) {
		return "", "", invalid("request.invalid", "applicationKey が不正です")
	}
	environment, err := ValidateKey(environmentKey, "environmentKey", 100)
	if err != nil {
		return "", "", err
	}
	workspace, err := ValidateKey(workspaceKey, "externalWorkspaceKey", 200)
	if err != nil {
		return "", "", err
	}
	return environment, workspace, nil
}

func ValidateKey(value, name string, maximum int) (string, error) {
	trimmed := strings.TrimSpace(value)
	if length := len(utf16.Encode([]rune(trimmed))); length == 0 || length > maximum {
		return "", invalid("request.invalid", fmt.Sprintf("%s は 1 文字以上 %d 文字以下で指定してください", name, maximum))
	}
	return trimmed, nil
}

func ValidateIdempotencyKey(value string) error {
	if value == "" {
		return invalid("idempotency.required", "Idempotency-Key が必要です")
	}
	if length := len(utf16.Encode([]rune(value))); length < 16 || length > 200 {
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

func invalid(code, detail string) error { return &Error{Kind: ErrInvalid, Code: code, Detail: detail} }
