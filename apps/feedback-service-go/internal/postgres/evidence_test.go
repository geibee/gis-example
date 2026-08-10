package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
)

func TestResolveEvidenceScopeHidesNonMember(t *testing.T) {
	t.Parallel()
	database := newTestDatabase(&evidencePool{rowFn: func(string, ...any) pgx.Row {
		return evidenceRow{err: pgx.ErrNoRows}
	}})
	_, err := database.ResolveEvidenceScope(context.Background(), userIDForEvidence, threadIDForEvidence)
	if !errors.Is(err, evidence.ErrNotFound) {
		t.Fatalf("ResolveEvidenceScope() error=%v, want ErrNotFound", err)
	}
	var domain *evidence.Error
	if !errors.As(err, &domain) || domain.Code != "resource.not_found" {
		t.Fatalf("domain error=%+v", domain)
	}
}

func TestGetEvidenceMetadata(t *testing.T) {
	t.Parallel()
	capturedAt := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	database := newTestDatabase(&evidencePool{rowFn: func(sql string, arguments ...any) pgx.Row {
		if !strings.Contains(sql, "FROM feedback.review_evidence") || len(arguments) != 1 {
			t.Fatalf("sql=%q args=%v", sql, arguments)
		}
		return evidenceRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*string) = threadIDForEvidence
			*destinations[1].(*string) = "evidence/object"
			*destinations[2].(*string) = "image/png"
			*destinations[3].(*int64) = 15
			*destinations[4].(*string) = strings.Repeat("a", 64)
			*destinations[5].(*int) = 1280
			*destinations[6].(*int) = 720
			*destinations[7].(*float64) = 2
			*destinations[8].(*time.Time) = capturedAt
			return nil
		}}
	}})
	metadata, err := database.GetEvidenceMetadata(context.Background(), threadIDForEvidence)
	if err != nil || metadata.ThreadID != threadIDForEvidence || metadata.ByteSize != 15 || metadata.CapturedAt != capturedAt {
		t.Fatalf("GetEvidenceMetadata()=%+v error=%v", metadata, err)
	}
}

func TestEnforceEvidenceQuota(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		count int64
		kind  error
	}{
		{name: "below", count: 9},
		{name: "at maximum", count: 10, kind: evidence.ErrQuotaExceeded},
		{name: "above", count: 11, kind: evidence.ErrQuotaExceeded},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			tx := &evidenceTx{rows: []pgx.Row{
				evidenceRow{scanFn: func(destinations ...any) error {
					*destinations[0].(*any) = nil
					return nil
				}},
				evidenceRow{scanFn: func(destinations ...any) error {
					*destinations[0].(*int64) = test.count
					return nil
				}},
			}}
			database := &Database{}
			err := database.EnforceEvidenceQuota(context.Background(), tx, workspaceIDForEvidence, 10)
			if test.kind == nil && err != nil {
				t.Fatalf("EnforceEvidenceQuota() error=%v", err)
			}
			if test.kind != nil && !errors.Is(err, test.kind) {
				t.Fatalf("EnforceEvidenceQuota() error=%v, want %v", err, test.kind)
			}
			if len(tx.queries) != 2 || !strings.Contains(tx.queries[0], "pg_advisory_xact_lock") ||
				!strings.Contains(tx.queries[1], "thread.workspace_id") {
				t.Fatalf("queries=%v", tx.queries)
			}
		})
	}
}

func TestInsertEvidenceMetadata(t *testing.T) {
	t.Parallel()
	attachment := validEvidenceAttachment()
	tx := &evidenceTx{}
	database := &Database{}
	if err := database.InsertEvidenceMetadata(context.Background(), tx, threadIDForEvidence, attachment); err != nil {
		t.Fatalf("InsertEvidenceMetadata() error=%v", err)
	}
	if len(tx.execs) != 1 || !strings.Contains(tx.execs[0].sql, "INSERT INTO feedback.review_evidence") ||
		len(tx.execs[0].arguments) != 10 || tx.execs[0].arguments[2] != attachment.ObjectKey {
		t.Fatalf("execs=%+v", tx.execs)
	}
	invalid := attachment
	invalid.ObjectKey = "../escape"
	if err := database.InsertEvidenceMetadata(context.Background(), tx, threadIDForEvidence, invalid); !errors.Is(err, evidence.ErrInvalidInput) {
		t.Fatalf("invalid attachment error=%v", err)
	}
}

func TestRecordEvidenceOperationalMetric(t *testing.T) {
	t.Parallel()
	var gotSQL string
	var gotArguments []any
	database := newTestDatabase(&evidencePool{execFn: func(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
		gotSQL, gotArguments = sql, arguments
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}})
	if err := database.RecordEvidenceStorageFailure(context.Background(), tenantIDForEvidence); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotSQL, "ON CONFLICT") || gotArguments[0] != "storage_failures_total" ||
		gotArguments[1] != tenantIDForEvidence {
		t.Fatalf("sql=%q args=%v", gotSQL, gotArguments)
	}
}

const (
	tenantIDForEvidence    = "11111111-1111-4111-8111-111111111111"
	workspaceIDForEvidence = "22222222-2222-4222-8222-222222222222"
	threadIDForEvidence    = "33333333-3333-4333-8333-333333333333"
	userIDForEvidence      = "44444444-4444-4444-8444-444444444444"
)

func validEvidenceAttachment() evidence.Attachment {
	return evidence.Attachment{
		ObjectKey: "evidence/object", ContentType: "image/png", ByteSize: 15, SHA256: strings.Repeat("a", 64),
		ViewportWidth: 1280, ViewportHeight: 720, PixelRatio: 2,
		CapturedAt: time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC),
	}
}

type evidenceRow struct {
	scanFn func(...any) error
	err    error
}

func (row evidenceRow) Scan(destinations ...any) error {
	if row.scanFn != nil {
		return row.scanFn(destinations...)
	}
	return row.err
}

type evidencePool struct {
	rowFn  func(string, ...any) pgx.Row
	execFn func(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (pool *evidencePool) Begin(context.Context) (managedTx, error) {
	return nil, errors.New("unexpected Begin")
}

func (pool *evidencePool) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if pool.execFn == nil {
		return pgconn.CommandTag{}, errors.New("unexpected Exec")
	}
	return pool.execFn(ctx, sql, arguments...)
}

func (pool *evidencePool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (pool *evidencePool) QueryRow(_ context.Context, sql string, arguments ...any) pgx.Row {
	return pool.rowFn(sql, arguments...)
}

func (pool *evidencePool) Ping(context.Context) error { return nil }
func (pool *evidencePool) Close()                     {}

type evidenceTx struct {
	rows    []pgx.Row
	queries []string
	execs   []evidenceExec
}

type evidenceExec struct {
	sql       string
	arguments []any
}

func (tx *evidenceTx) Exec(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	tx.execs = append(tx.execs, evidenceExec{sql: sql, arguments: append([]any(nil), arguments...)})
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (tx *evidenceTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (tx *evidenceTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.queries = append(tx.queries, sql)
	if len(tx.rows) == 0 {
		return evidenceRow{err: errors.New("unexpected QueryRow")}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}
