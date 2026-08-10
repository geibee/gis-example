package bootstrap

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
)

func TestRunnerRunProvisionAllResourcesInOneTransaction(t *testing.T) {
	t.Parallel()

	email := "owner@example.test"
	displayName := "Owner"
	tx := &recordingTx{
		rows: []pgx.Row{
			staticRow{value: "tenant-id"},
			staticRow{value: "application-id"},
			staticRow{value: "environment-id"},
			staticRow{value: "workspace-id"},
			staticRow{value: "principal-id"},
		},
	}
	transactor := &recordingTransactor{tx: tx}
	runner, err := NewRunner(transactor)
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	result, err := runner.Run(context.Background(), Input{
		TenantKey:              " tenant ",
		TenantDisplayName:      " Tenant ",
		ApplicationKey:         "web-gis",
		ApplicationDisplayName: " Web GIS ",
		EnvironmentKey:         " production ",
		EnvironmentBaseURL:     "https://app.example.test/review",
		AllowedOrigins: []string{
			" https://app.example.test ",
			"https://admin.example.test:8443",
			"https://app.example.test",
		},
		ExternalWorkspaceKey: " workspace-1 ",
		WorkspaceDisplayName: " Workspace ",
		Issuer:               "https://id.example.test/issuer/",
		Subject:              " owner ",
		Email:                &email,
		DisplayName:          &displayName,
		Permissions:          []Permission{PermissionRead, PermissionComment, PermissionRead},
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	wantResult := Result{
		TenantID:      "tenant-id",
		ApplicationID: "application-id",
		EnvironmentID: "environment-id",
		WorkspaceID:   "workspace-id",
		PrincipalID:   "principal-id",
	}
	if result != wantResult {
		t.Fatalf("Run() result = %#v, want %#v", result, wantResult)
	}
	if transactor.calls.Load() != 1 {
		t.Fatalf("transaction count = %d, want 1", transactor.calls.Load())
	}
	if len(tx.queries) != 5 || len(tx.execs) != 2 {
		t.Fatalf("queries=%d execs=%d, want 5/2", len(tx.queries), len(tx.execs))
	}

	if got := tx.queries[0].args[1]; got != "tenant" {
		t.Errorf("tenant key = %#v", got)
	}
	if got := tx.queries[2].args[4]; !reflect.DeepEqual(got, []string{
		"https://app.example.test", "https://admin.example.test:8443",
	}) {
		t.Errorf("allowed origins = %#v", got)
	}
	if got := tx.queries[2].args[5]; got != "https://id.example.test/issuer" {
		t.Errorf("issuer = %#v", got)
	}
	wantPermissions := []string{"feedback.comment", "feedback.read"}
	for index, call := range tx.execs {
		if !reflect.DeepEqual(call.args[2], wantPermissions) {
			t.Errorf("exec %d permissions = %#v, want %#v", index, call.args[2], wantPermissions)
		}
		if !strings.Contains(call.sql, "ON CONFLICT") {
			t.Errorf("exec %d is not idempotent upsert: %s", index, call.sql)
		}
	}
	for index, call := range tx.queries {
		if !strings.Contains(call.sql, "ON CONFLICT") {
			t.Errorf("query %d is not idempotent upsert: %s", index, call.sql)
		}
	}
}

func TestRunnerRunReturnsApplicationTenantConflict(t *testing.T) {
	t.Parallel()

	tx := &recordingTx{rows: []pgx.Row{
		staticRow{value: "tenant-id"},
		staticRow{err: pgx.ErrNoRows},
	}}
	transactor := &recordingTransactor{tx: tx}
	runner, err := NewRunner(transactor)
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	_, err = runner.Run(context.Background(), validInput())
	if !errors.Is(err, ErrApplicationKeyConflict) {
		t.Fatalf("Run() error = %v, want ErrApplicationKeyConflict", err)
	}
	if len(tx.queries) != 2 || len(tx.execs) != 0 {
		t.Fatalf("queries=%d execs=%d", len(tx.queries), len(tx.execs))
	}
}

func TestRunnerRunRejectsInvalidInputBeforeTransaction(t *testing.T) {
	t.Parallel()

	tests := map[string]func(*Input){
		"tenant key":      func(input *Input) { input.TenantKey = " " },
		"application key": func(input *Input) { input.ApplicationKey = "Web_GIS" },
		"environment URL": func(input *Input) { input.EnvironmentBaseURL = "http://example.test" },
		"origin path":     func(input *Input) { input.AllowedOrigins = []string{"https://example.test/path"} },
		"origin userinfo": func(input *Input) { input.AllowedOrigins = []string{"https://user@example.test"} },
		"origin query":    func(input *Input) { input.AllowedOrigins = []string{"https://example.test?x=1"} },
		"origin empty fragment": func(input *Input) {
			input.AllowedOrigins = []string{"https://example.test#"}
		},
		"empty origins":         func(input *Input) { input.AllowedOrigins = nil },
		"issuer fragment":       func(input *Input) { input.Issuer = "https://id.example.test#fragment" },
		"issuer empty fragment": func(input *Input) { input.Issuer = "https://id.example.test#" },
		"unknown permission":    func(input *Input) { input.Permissions = []Permission{"feedback.root"} },
		"empty permissions":     func(input *Input) { input.Permissions = nil },
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			input := validInput()
			mutate(&input)
			transactor := &recordingTransactor{tx: &recordingTx{}}
			runner, err := NewRunner(transactor)
			if err != nil {
				t.Fatalf("NewRunner() error = %v", err)
			}
			if _, err := runner.Run(context.Background(), input); err == nil {
				t.Fatal("不正入力が受理されました")
			}
			if transactor.calls.Load() != 0 {
				t.Fatal("入力検証前にtransactionが開始されました")
			}
		})
	}
}

func TestValidationMatchesKotlinUTF16LengthAndLocalHTTPRule(t *testing.T) {
	t.Parallel()

	if _, err := validateText(strings.Repeat("𠮷", 100), "value", 200); err != nil {
		t.Fatalf("UTF-16 200 code units should be valid: %v", err)
	}
	if _, err := validateText(strings.Repeat("𠮷", 101), "value", 200); err == nil {
		t.Fatal("UTF-16 202 code units should be invalid")
	}
	for _, value := range []string{
		"http://localhost:8080",
		"http://127.0.0.1:8080",
		"http://[::1]:8080",
		"https://example.test",
	} {
		if _, err := validateOrigin(value); err != nil {
			t.Errorf("validateOrigin(%q) error = %v", value, err)
		}
	}
	if _, err := validateOrigin("http://localhost.example.test"); err == nil {
		t.Fatal("localhost suffix hostでinsecure HTTPが許可されました")
	}
}

func TestParseEnvironmentNormalizesBootstrapContract(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"FEEDBACK_BOOTSTRAP_TENANT_KEY":               " tenant ",
		"FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME":      " Tenant ",
		"FEEDBACK_BOOTSTRAP_APPLICATION_KEY":          "web-gis",
		"FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME": " Web GIS ",
		"FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY":          " prod ",
		"FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL":     "https://app.example.test/review",
		"FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS":          "https://app.example.test, https://admin.example.test,https://app.example.test",
		"FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY":   " workspace ",
		"FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME":   " Workspace ",
		"FEEDBACK_BOOTSTRAP_ISSUER":                   "https://issuer.example.test/",
		"FEEDBACK_BOOTSTRAP_SUBJECT":                  " owner ",
		"FEEDBACK_BOOTSTRAP_EMAIL":                    "owner@example.test",
		"FEEDBACK_BOOTSTRAP_DISPLAY_NAME":             "Owner",
		"FEEDBACK_BOOTSTRAP_PERMISSIONS":              "feedback.read, feedback.admin,feedback.read",
	}
	input, err := ParseEnvironment(func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	})
	if err != nil {
		t.Fatalf("ParseEnvironment() error = %v", err)
	}
	if input.TenantKey != "tenant" || input.EnvironmentKey != "prod" || input.Subject != "owner" {
		t.Fatalf("keyの正規化が不正です: %#v", input)
	}
	if input.Issuer != "https://issuer.example.test" {
		t.Fatalf("issuer = %q", input.Issuer)
	}
	if !reflect.DeepEqual(input.AllowedOrigins, []string{
		"https://app.example.test", "https://admin.example.test",
	}) {
		t.Fatalf("AllowedOrigins = %#v", input.AllowedOrigins)
	}
	if !reflect.DeepEqual(input.Permissions, []Permission{PermissionAdmin, PermissionRead}) {
		t.Fatalf("Permissions = %#v", input.Permissions)
	}
}

func TestParseEnvironmentRequiresEveryMandatoryValue(t *testing.T) {
	t.Parallel()

	if _, err := ParseEnvironment(func(string) (string, bool) { return "", false }); err == nil ||
		!strings.Contains(err.Error(), "FEEDBACK_BOOTSTRAP_TENANT_KEY") {
		t.Fatalf("ParseEnvironment() error = %v", err)
	}
	if _, err := ParseEnvironment(nil); err == nil {
		t.Fatal("nil lookupが受理されました")
	}
}

func TestRunnerRunRequiresSingleRowForMembership(t *testing.T) {
	t.Parallel()

	tx := &recordingTx{
		rows: []pgx.Row{
			staticRow{value: "tenant-id"},
			staticRow{value: "application-id"},
			staticRow{value: "environment-id"},
			staticRow{value: "workspace-id"},
			staticRow{value: "principal-id"},
		},
		execTags: []pgconn.CommandTag{pgconn.NewCommandTag("INSERT 0 0")},
	}
	runner, err := NewRunner(&recordingTransactor{tx: tx})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	if _, err := runner.Run(context.Background(), validInput()); err == nil || !strings.Contains(err.Error(), "更新件数") {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestRunnerRunAcceptsUnchangedWorkspaceMembership(t *testing.T) {
	t.Parallel()

	tx := &recordingTx{
		rows: []pgx.Row{
			staticRow{value: "tenant-id"},
			staticRow{value: "application-id"},
			staticRow{value: "environment-id"},
			staticRow{value: "workspace-id"},
			staticRow{value: "principal-id"},
		},
		execTags: []pgconn.CommandTag{
			pgconn.NewCommandTag("INSERT 0 1"),
			pgconn.NewCommandTag("INSERT 0 0"),
		},
	}
	runner, err := NewRunner(&recordingTransactor{tx: tx})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	if _, err := runner.Run(context.Background(), validInput()); err != nil {
		t.Fatalf("同じpermissionの冪等再実行が失敗しました: %v", err)
	}
}

func validInput() Input {
	return Input{
		TenantKey:              "tenant",
		TenantDisplayName:      "Tenant",
		ApplicationKey:         "web-gis",
		ApplicationDisplayName: "Web GIS",
		EnvironmentKey:         "production",
		EnvironmentBaseURL:     "https://app.example.test/review",
		AllowedOrigins:         []string{"https://app.example.test"},
		ExternalWorkspaceKey:   "workspace-1",
		WorkspaceDisplayName:   "Workspace",
		Issuer:                 "https://id.example.test",
		Subject:                "owner",
		Permissions:            []Permission{PermissionAdmin},
	}
}

type recordingTransactor struct {
	tx    postgres.Tx
	err   error
	calls atomic.Int32
}

func (t *recordingTransactor) InTransaction(ctx context.Context, fn postgres.TxFunc) error {
	t.calls.Add(1)
	if t.err != nil {
		return t.err
	}
	return fn(ctx, t.tx)
}

type sqlCall struct {
	sql  string
	args []any
}

type recordingTx struct {
	rows     []pgx.Row
	execTags []pgconn.CommandTag
	queries  []sqlCall
	execs    []sqlCall
}

func (t *recordingTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	t.queries = append(t.queries, sqlCall{sql: sql, args: append([]any(nil), args...)})
	if len(t.rows) == 0 {
		return staticRow{err: errors.New("unexpected QueryRow")}
	}
	row := t.rows[0]
	t.rows = t.rows[1:]
	return row
}

func (t *recordingTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (t *recordingTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execs = append(t.execs, sqlCall{sql: sql, args: append([]any(nil), args...)})
	if len(t.execTags) == 0 {
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}
	tag := t.execTags[0]
	t.execTags = t.execTags[1:]
	return tag, nil
}

type staticRow struct {
	value string
	err   error
}

func (r staticRow) Scan(destinations ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(destinations) != 1 {
		return errors.New("unexpected destination count")
	}
	destination, ok := destinations[0].(*string)
	if !ok {
		return errors.New("unexpected destination type")
	}
	*destination = r.value
	return nil
}
