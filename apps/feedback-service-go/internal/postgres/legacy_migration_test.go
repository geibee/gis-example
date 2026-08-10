package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/legacymigration"
)

func TestApplyLegacyMigrationClassifiesCommitUnknown(t *testing.T) {
	t.Parallel()
	commitFailure := errors.New("network lost after COMMIT")
	tx := &legacyManagedTx{commitErr: commitFailure}
	database := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) { return tx, nil }})

	err := database.ApplyLegacyMigration(context.Background(), emptyLegacyPlan())
	if !errors.Is(err, legacymigration.ErrCommitUnknown) || !errors.Is(err, commitFailure) {
		t.Fatalf("error = %v", err)
	}
	if tx.deleteSQLSeen {
		t.Fatal("commit不明時にrollback用DELETEを実行しました")
	}
}

func TestApplyLegacyMigrationDoesNotClassifyCallbackFailureAsCommitUnknown(t *testing.T) {
	t.Parallel()
	callbackFailure := errors.New("insert failed")
	tx := &legacyManagedTx{execErr: callbackFailure}
	database := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) { return tx, nil }})

	err := database.ApplyLegacyMigration(context.Background(), emptyLegacyPlan())
	if !errors.Is(err, callbackFailure) || errors.Is(err, legacymigration.ErrCommitUnknown) {
		t.Fatalf("error = %v", err)
	}
}

func TestLegacyJSONEqualIgnoresJSONBFormatting(t *testing.T) {
	t.Parallel()
	if !legacyJSONEqual([]byte(`{"b":2,"a":1}`), []byte(`{ "a": 1, "b": 2 }`)) {
		t.Fatal("意味的に同じJSONが不一致になりました")
	}
	if legacyJSONEqual([]byte(`{"a":1}`), []byte(`{"a":2}`)) {
		t.Fatal("異なるJSONが一致しました")
	}
}

func emptyLegacyPlan() legacymigration.ApplyPlan {
	return legacymigration.ApplyPlan{
		Snapshot: legacymigration.Snapshot{SourceSystem: "legacy", Sessions: []legacymigration.SessionSnapshot{},
			Threads: []legacymigration.ThreadSnapshot{}, Messages: []legacymigration.MessageSnapshot{},
			MessageVersions: []legacymigration.MessageVersionSnapshot{}, Evidence: []legacymigration.EvidenceSnapshot{},
			Audits: []legacymigration.AuditSnapshot{}, Outbox: []legacymigration.OutboxSnapshot{}},
		Scope: legacymigration.Scope{
			ApplicationID: "046e393c-a152-4a4f-b717-649383169fae",
			EnvironmentID: "1a331b1c-4f78-43ce-b21d-50846580ca50",
			WorkspaceID:   "98e2498f-b455-43f9-a13e-3bedebf78aab",
		},
		Report: legacymigration.Report{
			RunID: "c6bd0379-59dc-483e-8a6a-a9113b9b36f1", SourceChecksum: "checksum", Differences: []string{},
		},
	}
}

type legacyManagedTx struct {
	execErr       error
	commitErr     error
	deleteSQLSeen bool
}

func (tx *legacyManagedTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	if len(sql) >= 6 && sql[:6] == "DELETE" {
		tx.deleteSQLSeen = true
	}
	if tx.execErr != nil {
		return pgconn.CommandTag{}, tx.execErr
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}
func (*legacyManagedTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query")
}
func (*legacyManagedTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}
func (tx *legacyManagedTx) Commit(context.Context) error { return tx.commitErr }
func (*legacyManagedTx) Rollback(context.Context) error  { return nil }
