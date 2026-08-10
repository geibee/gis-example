package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
)

func TestDiscussionIdempotencyReplayAndMismatch(t *testing.T) {
	t.Parallel()
	want := discussion.Message{
		ID:       "11111111-1111-4111-8111-111111111111",
		ThreadID: "22222222-2222-4222-8222-222222222222",
		Body:     "replayed", CreatedAt: "2026-08-09T12:34:56.123Z", Version: 1,
	}
	body, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	tx := &discussionHelperTx{rowFn: func(sql string, arguments ...any) pgx.Row {
		if !strings.Contains(sql, "FROM feedback.idempotency_records") {
			t.Fatalf("unexpected query: %s", sql)
		}
		return discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*string) = strings.Repeat("a", 64)
			*destinations[1].(*[]byte) = append([]byte(nil), body...)
			return nil
		}}
	}}
	var got discussion.Message
	replayed, err := loadDiscussionIdempotency(
		context.Background(), tx, "tenant", "principal", createMessageEndpoint,
		"test-idempotency-key", strings.Repeat("a", 64), &got,
	)
	if err != nil || !replayed || got != want {
		t.Fatalf("replay=%v got=%+v err=%v", replayed, got, err)
	}
	if len(tx.execs) != 1 || !strings.Contains(tx.execs[0].sql, "pg_advisory_xact_lock") {
		t.Fatalf("lock exec=%+v", tx.execs)
	}
	wantLock := "principal\x1f" + createMessageEndpoint + "\x1ftest-idempotency-key"
	if tx.execs[0].arguments[0] != wantLock {
		t.Fatalf("lock domain=%q", tx.execs[0].arguments[0])
	}

	var mismatch discussion.Message
	_, err = loadDiscussionIdempotency(
		context.Background(), tx, "tenant", "principal", createMessageEndpoint,
		"test-idempotency-key", strings.Repeat("b", 64), &mismatch,
	)
	var domainError *discussion.Error
	if !errors.Is(err, discussion.ErrConflict) || !errors.As(err, &domainError) || domainError.Code != "idempotency.mismatch" {
		t.Fatalf("mismatch error=%v domain=%+v", err, domainError)
	}
}

func TestEnforceWriteRateLimitCommitsCountersThenMetricAndAudit(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	sequence := make([]string, 0, 3)
	tx := &discussionRateTx{counts: map[string]int{"tenant": 2, "principal": 3, "ip": 1}}
	tx.onCommit = func() {
		mu.Lock()
		sequence = append(sequence, "commit")
		mu.Unlock()
	}
	pool := &discussionRatePool{tx: tx, execFn: func(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.Contains(sql, "rate_limit_rejections_total"):
			sequence = append(sequence, "metric")
			if len(arguments) != 1 || arguments[0] != discussionTenantID {
				t.Fatalf("metric args=%v", arguments)
			}
		case strings.Contains(sql, "INSERT INTO feedback.audit_logs"):
			sequence = append(sequence, "audit")
			if arguments[4] != "principal-subject" || arguments[5] != "rate_limit" ||
				arguments[6] != "workspace" || arguments[7] != discussionWorkspaceID ||
				arguments[8] != "denied" || arguments[9] != "request-1" {
				t.Fatalf("audit args=%v", arguments)
			}
			if arguments[10] != `{"dimensions":["tenant","principal"]}` {
				t.Fatalf("audit changes=%v", arguments[10])
			}
		default:
			t.Fatalf("unexpected pool exec: %s", sql)
		}
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}}
	database := newTestDatabase(pool)
	exceeded, err := database.EnforceWriteRateLimit(context.Background(), discussion.RateLimitInput{
		Scope: auth.ResourceScope{
			TenantID: discussionTenantID, ApplicationID: discussionApplicationID, WorkspaceID: discussionWorkspaceID,
		},
		Principal: auth.Principal{Subject: "principal-subject"}, RemoteAddress: "192.0.2.1",
		PrincipalLimitPerMinute: 1, TenantLimitPerMinute: 1, IPLimitPerMinute: 1, RequestID: "request-1",
	})
	if err != nil || strings.Join(exceeded, ",") != "tenant,principal" {
		t.Fatalf("exceeded=%v err=%v", exceeded, err)
	}
	if strings.Join(sequence, ",") != "commit,metric,audit" {
		t.Fatalf("処理順=%v", sequence)
	}
	if len(tx.subjectHashes) != 3 {
		t.Fatalf("counter updates=%d", len(tx.subjectHashes))
	}
	for dimension, hash := range tx.subjectHashes {
		if len(hash) != 64 || strings.Contains(hash, "principal-subject") || strings.Contains(hash, "192.0.2.1") {
			t.Fatalf("%s subject_hash=%q", dimension, hash)
		}
	}
}

func TestEnforceWriteRateLimitDoesNotAuditAllowedRequest(t *testing.T) {
	t.Parallel()
	tx := &discussionRateTx{counts: map[string]int{"tenant": 1, "principal": 1, "ip": 1}}
	pool := &discussionRatePool{tx: tx, execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
		t.Fatal("許可requestでtransaction外writeが発生しました")
		return pgconn.CommandTag{}, nil
	}}
	database := newTestDatabase(pool)
	exceeded, err := database.EnforceWriteRateLimit(context.Background(), discussion.RateLimitInput{
		Scope: auth.ResourceScope{TenantID: discussionTenantID}, Principal: auth.Principal{Subject: "subject"},
		RemoteAddress: "192.0.2.1", PrincipalLimitPerMinute: 1, TenantLimitPerMinute: 1, IPLimitPerMinute: 1,
	})
	if err != nil || len(exceeded) != 0 {
		t.Fatalf("exceeded=%v err=%v", exceeded, err)
	}
}

func TestRecordDiscussionQuotaRejectionIsBestEffortAndSelective(t *testing.T) {
	t.Parallel()
	called := 0
	pool := &discussionRatePool{execFn: func(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
		called++
		if !strings.Contains(sql, "operational_metric_counters") ||
			arguments[0] != "evidence_quota_rejections_total" || arguments[1] != discussionTenantID {
			t.Fatalf("sql=%s args=%v", sql, arguments)
		}
		return pgconn.CommandTag{}, errors.New("metric unavailable")
	}}
	database := newTestDatabase(pool)
	database.recordDiscussionQuotaRejection(context.Background(), discussionTenantID, errors.New("other"))
	if called != 0 {
		t.Fatal("非quota errorでmetricを記録しました")
	}
	database.recordDiscussionQuotaRejection(context.Background(), discussionTenantID, &evidence.Error{
		Kind: evidence.ErrQuotaExceeded, Code: "evidence.quota_exceeded", Detail: "quota",
	})
	if called != 1 {
		t.Fatalf("quota metric call=%d", called)
	}
}

func TestDiscussionTimestampUsesJavaInstantGrouping(t *testing.T) {
	t.Parallel()
	created := time.Date(2026, 8, 9, 12, 34, 56, 123400000, time.FixedZone("JST", 9*60*60))
	message, err := scanDiscussionMessage(discussionRow{scanFn: func(destinations ...any) error {
		*destinations[0].(*string) = "message"
		*destinations[1].(*string) = "thread"
		*destinations[2].(*string) = "principal"
		*destinations[5].(*string) = "body"
		*destinations[6].(*time.Time) = created
		*destinations[8].(*int) = 1
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if message.CreatedAt != "2026-08-09T03:34:56.123400Z" {
		t.Fatalf("createdAt=%q", message.CreatedAt)
	}
}

func TestCreateThreadRollsBackAfterPartialWrite(t *testing.T) {
	t.Parallel()
	want := errors.New("message insert failed")
	tx := &discussionCreateTx{rows: []pgx.Row{
		discussionRow{err: pgx.ErrNoRows},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*string) = "open"
			*destinations[1].(*string) = "deny"
			*destinations[2].(*string) = "v1"
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*time.Time) = time.Now()
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*[]byte) = []byte(`{"routes":[{"pageKey":"home","template":"/"}]}`)
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*bool) = true
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*bool) = true
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*int) = 1
			return nil
		}},
	}, execFn: func(sql string, _ []any) error {
		if strings.Contains(sql, "INSERT INTO feedback.feedback_messages") {
			return want
		}
		return nil
	}}
	database := newTestDatabase(&discussionCreatePool{tx: tx})
	result, err := database.CreateThread(context.Background(), discussion.CreateThreadInput{
		Scope: auth.ResourceScope{
			TenantID: discussionTenantID, ApplicationID: discussionApplicationID,
			EnvironmentID: "44444444-4444-4444-8444-444444444444", WorkspaceID: discussionWorkspaceID,
		},
		SessionID: "55555555-5555-4555-8555-555555555555",
		ThreadID:  "66666666-6666-4666-8666-666666666666",
		Principal: auth.Principal{Subject: "principal"},
		Request: discussion.ThreadCreateRequest{
			Location:        []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`),
			Target:          []byte(`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`),
			PerspectiveCode: "ux", Body: "body",
		},
		IdempotencyKey: "test-idempotency-key", RequestHash: strings.Repeat("a", 64),
	})
	if !errors.Is(err, want) || result.EvidenceCleanup != discussion.CleanupNone {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d", tx.commits, tx.rollbacks)
	}
	joined := strings.Join(tx.execSQL, "\n")
	if !strings.Contains(joined, "feedback.feedback_threads") ||
		strings.Contains(joined, "feedback.feedback_change_journal") ||
		strings.Contains(joined, "feedback.notification_outbox") ||
		strings.Contains(joined, "INSERT INTO feedback.idempotency_records") {
		t.Fatalf("rollback前後のSQL境界が不正です:\n%s", joined)
	}
}

func TestCreateThreadCommitFailureDefersEvidenceCleanup(t *testing.T) {
	t.Parallel()
	commitErr := errors.New("connection lost during commit")
	now := time.Date(2026, 8, 9, 0, 0, 0, 123000000, time.UTC)
	messageID := "77777777-7777-4777-8777-777777777777"
	threadID := "66666666-6666-4666-8666-666666666666"
	messageScan := func(destinations ...any) error {
		*destinations[0].(*string) = messageID
		*destinations[1].(*string) = threadID
		*destinations[2].(*string) = "principal"
		*destinations[5].(*string) = "body"
		*destinations[6].(*time.Time) = now
		*destinations[8].(*int) = 1
		return nil
	}
	tx := &discussionCreateTx{commitErr: commitErr}
	tx.rows = []pgx.Row{
		discussionRow{err: pgx.ErrNoRows},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*string) = "open"
			*destinations[1].(*string) = "deny"
			*destinations[2].(*string) = "v1"
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*time.Time) = now
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*[]byte) = []byte(`{"routes":[{"pageKey":"home","template":"/"}]}`)
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*bool) = true
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*bool) = true
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*any) = nil
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*int64) = 0
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*int) = 1
			return nil
		}},
		discussionRow{scanFn: messageScan},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*string) = threadID
			*destinations[1].(*string) = "55555555-5555-4555-8555-555555555555"
			*destinations[2].(*int) = 1
			*destinations[3].(*[]byte) = []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`)
			*destinations[4].(*[]byte) = []byte(`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`)
			*destinations[5].(*string) = "ux"
			*destinations[6].(*string) = "open"
			*destinations[7].(*string) = "principal"
			*destinations[10].(*time.Time) = now
			*destinations[11].(*time.Time) = now
			*destinations[12].(*int) = 1
			return nil
		}},
		discussionRow{scanFn: func(destinations ...any) error {
			*destinations[0].(*bool) = true
			return nil
		}},
	}
	tx.queryFn = func(sql string) (pgx.Rows, error) {
		if !strings.Contains(sql, "FROM feedback.feedback_messages") {
			return nil, errors.New("unexpected Query")
		}
		return &discussionRows{scans: []func(...any) error{messageScan}}, nil
	}
	database := newTestDatabase(&discussionCreatePool{tx: tx})
	attachment := validEvidenceAttachment()
	result, err := database.CreateThread(context.Background(), discussion.CreateThreadInput{
		Scope: auth.ResourceScope{
			TenantID: discussionTenantID, TenantKey: "tenant", ApplicationID: discussionApplicationID,
			EnvironmentID: "44444444-4444-4444-8444-444444444444", WorkspaceID: discussionWorkspaceID,
			ApplicationKey: "application", EnvironmentKey: "test", ExternalWorkspaceKey: "workspace",
		},
		SessionID: "55555555-5555-4555-8555-555555555555", ThreadID: threadID,
		Principal: auth.Principal{Subject: "principal"},
		Request: discussion.ThreadCreateRequest{
			Location:        []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`),
			Target:          []byte(`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`),
			PerspectiveCode: "ux", Body: "body",
		},
		Evidence: &attachment, EvidenceMaximum: 10,
		IdempotencyKey: "test-idempotency-key", RequestHash: strings.Repeat("a", 64),
	})
	if !errors.Is(err, discussion.ErrCommitUnknown) || result.EvidenceCleanup != discussion.CleanupDeferToOrphanSweep {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("commits=%d rollbacks=%d", tx.commits, tx.rollbacks)
	}
	joined := strings.Join(tx.execSQL, "\n")
	for _, required := range []string{
		"feedback.feedback_threads", "feedback.feedback_messages", "feedback.review_evidence",
		"feedback.feedback_change_journal", "feedback.notification_outbox", "feedback.idempotency_records",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("commit直前のtransaction SQLに%sがありません:\n%s", required, joined)
		}
	}
}

const (
	discussionTenantID      = "11111111-1111-4111-8111-111111111111"
	discussionApplicationID = "22222222-2222-4222-8222-222222222222"
	discussionWorkspaceID   = "33333333-3333-4333-8333-333333333333"
)

type discussionExec struct {
	sql       string
	arguments []any
}

type discussionRow struct {
	scanFn func(...any) error
	err    error
}

func (row discussionRow) Scan(destinations ...any) error {
	if row.scanFn != nil {
		return row.scanFn(destinations...)
	}
	return row.err
}

type discussionHelperTx struct {
	execs []discussionExec
	rowFn func(string, ...any) pgx.Row
}

func (tx *discussionHelperTx) Exec(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	tx.execs = append(tx.execs, discussionExec{sql: sql, arguments: append([]any(nil), arguments...)})
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *discussionHelperTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (tx *discussionHelperTx) QueryRow(_ context.Context, sql string, arguments ...any) pgx.Row {
	return tx.rowFn(sql, arguments...)
}

type discussionRateTx struct {
	counts        map[string]int
	subjectHashes map[string]string
	onCommit      func()
}

func (tx *discussionRateTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unexpected transaction Exec")
}

func (tx *discussionRateTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected transaction Query")
}

func (tx *discussionRateTx) QueryRow(_ context.Context, sql string, arguments ...any) pgx.Row {
	if !strings.Contains(sql, "write_rate_limit_counters") {
		return discussionRow{err: errors.New("unexpected transaction QueryRow")}
	}
	dimension := arguments[1].(string)
	if tx.subjectHashes == nil {
		tx.subjectHashes = make(map[string]string)
	}
	tx.subjectHashes[dimension] = arguments[2].(string)
	return discussionRow{scanFn: func(destinations ...any) error {
		*destinations[0].(*int) = tx.counts[dimension]
		return nil
	}}
}

func (tx *discussionRateTx) Commit(context.Context) error {
	if tx.onCommit != nil {
		tx.onCommit()
	}
	return nil
}

func (tx *discussionRateTx) Rollback(context.Context) error { return nil }

type discussionRatePool struct {
	tx     *discussionRateTx
	execFn func(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (pool *discussionRatePool) Begin(context.Context) (managedTx, error) {
	if pool.tx == nil {
		return nil, errors.New("unexpected Begin")
	}
	return pool.tx, nil
}

func (pool *discussionRatePool) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	return pool.execFn(ctx, sql, arguments...)
}

func (pool *discussionRatePool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (pool *discussionRatePool) QueryRow(context.Context, string, ...any) pgx.Row {
	return discussionRow{err: errors.New("unexpected QueryRow")}
}

func (pool *discussionRatePool) Ping(context.Context) error { return nil }
func (pool *discussionRatePool) Close()                     {}

type discussionCreateTx struct {
	rows      []pgx.Row
	execFn    func(string, []any) error
	queryFn   func(string) (pgx.Rows, error)
	execSQL   []string
	commits   int
	rollbacks int
	commitErr error
}

func (tx *discussionCreateTx) Exec(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	tx.execSQL = append(tx.execSQL, sql)
	if tx.execFn != nil {
		if err := tx.execFn(sql, arguments); err != nil {
			return pgconn.CommandTag{}, err
		}
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (tx *discussionCreateTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if tx.queryFn == nil {
		return nil, errors.New("unexpected Query")
	}
	return tx.queryFn(sql)
}

func (tx *discussionCreateTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if len(tx.rows) == 0 {
		return discussionRow{err: errors.New("unexpected QueryRow")}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}

func (tx *discussionCreateTx) Commit(context.Context) error {
	tx.commits++
	return tx.commitErr
}

func (tx *discussionCreateTx) Rollback(context.Context) error {
	tx.rollbacks++
	return nil
}

type discussionCreatePool struct{ tx *discussionCreateTx }

func (pool *discussionCreatePool) Begin(context.Context) (managedTx, error) { return pool.tx, nil }
func (pool *discussionCreatePool) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unexpected pool Exec")
}
func (pool *discussionCreatePool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected pool Query")
}
func (pool *discussionCreatePool) QueryRow(context.Context, string, ...any) pgx.Row {
	return discussionRow{err: errors.New("unexpected pool QueryRow")}
}
func (pool *discussionCreatePool) Ping(context.Context) error { return nil }
func (pool *discussionCreatePool) Close()                     {}

type discussionRows struct {
	scans  []func(...any) error
	index  int
	closed bool
}

func (rows *discussionRows) Close() { rows.closed = true }
func (rows *discussionRows) Err() error {
	return nil
}
func (rows *discussionRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (rows *discussionRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}
func (rows *discussionRows) Next() bool {
	if rows.index >= len(rows.scans) {
		rows.closed = true
		return false
	}
	return true
}
func (rows *discussionRows) Scan(destinations ...any) error {
	if rows.index >= len(rows.scans) {
		return errors.New("Scan without Next")
	}
	scan := rows.scans[rows.index]
	rows.index++
	return scan(destinations...)
}
func (rows *discussionRows) Values() ([]any, error) { return nil, errors.New("unexpected Values") }
func (rows *discussionRows) RawValues() [][]byte    { return nil }
func (rows *discussionRows) Conn() *pgx.Conn        { return nil }
