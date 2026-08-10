package backup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type backupWorkerStore struct {
	claimed       *Claimed
	prepared      PreparedArchive
	completeErr   error
	scheduled     bool
	completed     bool
	failed        bool
	failedAttempt int
}

func (store *backupWorkerStore) ScheduleDueBackups(context.Context, time.Time) (int, error) {
	store.scheduled = true
	return 0, nil
}

func (store *backupWorkerStore) ClaimBackup(context.Context) (*Claimed, error) {
	claimed := store.claimed
	store.claimed = nil
	return claimed, nil
}

func (store *backupWorkerStore) PrepareBackup(context.Context, Claimed) (PreparedArchive, error) {
	return store.prepared, nil
}

func (store *backupWorkerStore) CompleteBackup(
	_ context.Context, _ Claimed, _ PreparedArchive, _ string, _ ArchiveResult,
) error {
	store.completed = true
	return store.completeErr
}

func (store *backupWorkerStore) FailBackup(_ context.Context, claimed Claimed, _ string, _ int) error {
	store.failed = true
	store.failedAttempt = claimed.Attempt
	return nil
}

func TestWorkerKeepsAttemptObjectWhenDatabaseCompletionFails(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	evidence, err := objectstore.NewLocal(directory + "/evidence")
	if err != nil {
		t.Fatal(err)
	}
	backups, err := objectstore.NewLocal(directory + "/backups")
	if err != nil {
		t.Fatal(err)
	}
	claimed := Claimed{
		ID: "run", TenantID: "tenant", WorkspaceID: "workspace", Kind: KindFull,
		ScheduledFor: "2026-08-09T01:02:03Z", ClaimToken: "claim", Attempt: 2,
	}
	store := &backupWorkerStore{
		claimed: &claimed,
		prepared: PreparedArchive{
			RunID: claimed.ID, Kind: claimed.Kind, ScheduledFor: claimed.ScheduledFor,
			CSVEntries: []CSVEntry{{Path: "threads.csv", Header: []string{"id"}}},
		},
		completeErr: errors.New("DB completion failure"),
	}
	worker, err := NewWorker(store, evidence, backups, "backups/", 5)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := worker.RunOnce(context.Background(), time.Date(2026, 8, 9, 1, 2, 3, 0, time.UTC))
	if err != nil || !processed || !store.scheduled || !store.completed || !store.failed || store.failedAttempt != 2 {
		t.Fatalf("processed=%v store=%+v err=%v", processed, store, err)
	}
	refs, err := backups.List(context.Background(), "backups/")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 {
		t.Fatalf("回復対象のattempt固有object=%+v", refs)
	}
	expected := "backups/tenant/workspace/2026/08/2026-08-09T01-02-03Z--full-run-attempt-2-claim.zip"
	if refs[0].Key != expected {
		t.Fatalf("object key=%q want=%q", refs[0].Key, expected)
	}
}
