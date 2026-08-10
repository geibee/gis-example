package postgres

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	sessiondomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestResourceScopeSourceUsesFixedAllowlist(t *testing.T) {
	t.Parallel()
	tests := []struct {
		kind       string
		wantTable  string
		wantColumn string
		wantJoin   string
	}{
		{kind: sessiondomain.ResourceKindSession, wantTable: "feedback.review_sessions r", wantColumn: "r.id"},
		{kind: sessiondomain.ResourceKindThread, wantTable: "feedback.feedback_threads r", wantColumn: "r.id"},
		{
			kind: sessiondomain.ResourceKindMessage, wantTable: "feedback.feedback_messages m", wantColumn: "m.id",
			wantJoin: "JOIN feedback.feedback_threads r ON r.id = m.thread_id",
		},
		{kind: sessiondomain.ResourceKindExport, wantTable: "feedback.export_jobs r", wantColumn: "r.id"},
		{kind: sessiondomain.ResourceKindBackup, wantTable: "feedback.backup_runs r", wantColumn: "r.id"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.kind, func(t *testing.T) {
			t.Parallel()
			table, column, joins, ok := resourceScopeSource(test.kind)
			if !ok || table != test.wantTable || column != test.wantColumn || joins != test.wantJoin {
				t.Fatalf("resourceScopeSource(%q) = %q, %q, %q, %v", test.kind, table, column, joins, ok)
			}
		})
	}
	for _, invalid := range []string{"", "SESSION", "session; DROP TABLE feedback.tenants", "workspace"} {
		if table, _, _, ok := resourceScopeSource(invalid); ok || table != "" {
			t.Fatalf("resourceScopeSource(%q) accepted: %q", invalid, table)
		}
	}
}

func TestSessionDomainErrorsUseSharedSentinels(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		kind error
		code string
	}{
		{name: "not found", err: notFoundError(), kind: usecase.ErrNotFound, code: "resource.not_found"},
		{name: "version", err: versionMismatchError(), kind: usecase.ErrVersionMismatch, code: "resource.version_mismatch"},
		{name: "open conflict", err: openSessionConflict(), kind: usecase.ErrConflict, code: "session.open_conflict"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var domainError *usecase.DomainError
			if !errors.Is(test.err, test.kind) || !errors.As(test.err, &domainError) || domainError.Code != test.code {
				t.Fatalf("error = %v", test.err)
			}
		})
	}
}

func TestUniqueViolationTraversesWrappedErrors(t *testing.T) {
	t.Parallel()
	postgresError := &pgconn.PgError{Code: "23505"}
	if !uniqueViolation(errors.Join(errors.New("context"), postgresError)) {
		t.Fatal("wrapped 23505を検出できません")
	}
	if uniqueViolation(&pgconn.PgError{Code: "23503"}) || uniqueViolation(errors.New("plain")) {
		t.Fatal("23505以外をunique violationとして扱いました")
	}
}

func TestOptionalStringPreservesEmptyAndNull(t *testing.T) {
	t.Parallel()
	empty := ""
	if optionalString(nil) != nil {
		t.Fatal("nilがSQL nullになりません")
	}
	if got, ok := optionalString(&empty).(string); !ok || got != "" {
		t.Fatalf("empty string = %#v", optionalString(&empty))
	}
}

func TestIdempotencyLockDomainSeparator(t *testing.T) {
	t.Parallel()
	// Kotlin正本の区切りを維持し、principal/endpoint/keyの単純連結衝突を防ぐ。
	value := idempotencyLockValue("principal", sessionEndpoint, "test-idempotency-key")
	if strings.Count(value, "\x1f") != 2 || !strings.Contains(value, sessionEndpoint) {
		t.Fatalf("lock value = %q", value)
	}
}
