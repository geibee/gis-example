package export

import (
	"context"
	"errors"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type exportWorkerStore struct {
	claimed     *Claimed
	prepared    Prepared
	completeErr error
	completed   bool
	failed      bool
}

func (store *exportWorkerStore) ClaimExport(context.Context) (*Claimed, error) {
	claimed := store.claimed
	store.claimed = nil
	return claimed, nil
}

func (store *exportWorkerStore) PrepareExport(context.Context, Claimed) (Prepared, error) {
	return store.prepared, nil
}

func (store *exportWorkerStore) CompleteExport(context.Context, Claimed, string, int) error {
	store.completed = true
	return store.completeErr
}

func (store *exportWorkerStore) FailExport(context.Context, Claimed, string) error {
	store.failed = true
	return nil
}

func TestWorkerRetainsObjectWhenDatabaseCompletionMayHaveCommitted(t *testing.T) {
	t.Parallel()
	objects, err := objectstore.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := &exportWorkerStore{
		claimed: &Claimed{
			ID: "job", TenantID: "tenant", WorkspaceID: "workspace", Format: FormatCSV,
			Locale: "ja-JP", Timezone: "Asia/Tokyo", ClaimToken: "claim",
		},
		prepared:    Prepared{RetentionDays: 7},
		completeErr: errors.New("DB completion failure"),
	}
	worker, err := NewWorker(store, objects, "exports/")
	if err != nil {
		t.Fatal(err)
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed || !store.completed || !store.failed {
		t.Fatalf("processed=%v completed=%v failed=%v err=%v", processed, store.completed, store.failed, err)
	}
	refs, err := objects.List(context.Background(), "exports/")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].Key != "exports/tenant/workspace/job-claim.csv" {
		t.Fatalf("commit結果不明objectがorphan回収前に消えました: %+v", refs)
	}
}
