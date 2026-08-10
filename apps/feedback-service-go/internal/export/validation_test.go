package export

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestValidateRequestTable(t *testing.T) {
	t.Parallel()
	valid := Request{
		ApplicationKey: "app", EnvironmentKey: "production", ExternalWorkspaceKey: "workspace",
		Format: FormatCSV, Locale: "ja-JP", Timezone: "Asia/Tokyo",
	}
	tests := map[string]func(*Request){
		"format":   func(value *Request) { value.Format = "pdf" },
		"locale":   func(value *Request) { value.Locale = "" },
		"timezone": func(value *Request) { value.Timezone = "Mars/Olympus" },
		"session":  func(value *Request) { value.SessionID = exportString("invalid") },
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			request := valid
			mutate(&request)
			if err := ValidateRequest(request); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ValidateRequest() error = %v", err)
			}
		})
	}
}

func TestValidateRequestAcceptsUUIDTextAcceptedByParser(t *testing.T) {
	t.Parallel()
	id := strings.ToUpper(uuid.NewString())
	request := Request{
		ApplicationKey: "app", EnvironmentKey: "production", ExternalWorkspaceKey: "workspace",
		SessionID: &id, Format: FormatCSV, Locale: "ja-JP", Timezone: "Asia/Tokyo",
	}
	if err := ValidateRequest(request); err != nil {
		t.Fatalf("PostgreSQL UUID castと互換な表記が拒否されました: %v", err)
	}
}

func TestValidateIdempotencyAndHash(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", "short", strings.Repeat("x", 201)} {
		if err := ValidateIdempotencyKey(value); !errors.Is(err, ErrInvalid) {
			t.Fatalf("idempotency %q error=%v", value, err)
		}
	}
	if err := ValidateRequestHash(strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRequestHash(strings.Repeat("A", 64)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("uppercase hash error=%v", err)
	}
}

func exportString(value string) *string { return &value }
