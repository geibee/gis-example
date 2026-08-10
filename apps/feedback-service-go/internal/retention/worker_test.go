package retention

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

func TestWorkerPurgesAllClassesAndSafeOrphans(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	evidenceObjects := &objectStoreFake{refs: []objectstore.Ref{
		{Key: "evidence/orphan", LastModified: now.Add(-2 * time.Hour)},
		{Key: "evidence/referenced", LastModified: now.Add(-2 * time.Hour)},
		{Key: "evidence/fresh", LastModified: now.Add(-time.Minute)},
	}}
	exportObjects := &objectStoreFake{refs: []objectstore.Ref{
		{Key: "exports/orphan", LastModified: now.Add(-2 * time.Hour)},
		{Key: "exports/referenced", LastModified: now.Add(-2 * time.Hour)},
		{Key: "backups/orphan", LastModified: now.Add(-2 * time.Hour)},
		{Key: "backups/referenced", LastModified: now.Add(-2 * time.Hour)},
	}}
	store := &workerStoreFake{
		evidenceExists: map[string]bool{"evidence/referenced": true},
		exportExists:   map[string]bool{"exports/referenced": true},
		backupExists:   map[string]bool{"backups/referenced": true},
	}
	worker, err := NewWorker(store, evidenceObjects, exportObjects, WorkerSettings{
		EvidencePrefix: "evidence/", ExportPrefix: "exports/", BackupPrefix: "backups/",
		OrphanGrace: time.Hour, BatchSize: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if !worked || store.internalCalls != 1 || store.evidencePurgeCalls != 1 ||
		store.exportPurgeCalls != 1 || store.backupPurgeCalls != 1 {
		t.Fatalf("worker calls = %+v, worked=%v", store, worked)
	}
	if !equalStrings(evidenceObjects.deleted, []string{"expired/evidence", "evidence/orphan"}) {
		t.Fatalf("evidence deleted = %v", evidenceObjects.deleted)
	}
	if !equalStrings(exportObjects.deleted, []string{
		"expired/export", "expired/backup", "exports/orphan", "backups/orphan",
	}) {
		t.Fatalf("export deleted = %v", exportObjects.deleted)
	}
}

func TestWorkerDoesNotDeleteAnyOrphanWhenReferenceCheckFails(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	evidenceObjects := &objectStoreFake{refs: []objectstore.Ref{
		{Key: "evidence/first", LastModified: now.Add(-2 * time.Hour)},
		{Key: "evidence/second", LastModified: now.Add(-2 * time.Hour)},
	}}
	store := &workerStoreFake{evidenceCheckError: errors.New("database unavailable")}
	worker, err := NewWorker(store, evidenceObjects, &objectStoreFake{}, WorkerSettings{
		EvidencePrefix: "evidence/", ExportPrefix: "exports/", BackupPrefix: "backups/",
		OrphanGrace: time.Hour, BatchSize: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RunOnce(context.Background(), now); err == nil {
		t.Fatal("参照確認失敗を無視しました")
	}
	if len(evidenceObjects.deleted) != 1 || evidenceObjects.deleted[0] != "expired/evidence" {
		t.Fatalf("orphan候補が削除されました: %v", evidenceObjects.deleted)
	}
}

type workerStoreFake struct {
	internalCalls, evidencePurgeCalls, exportPurgeCalls, backupPurgeCalls int
	evidenceExists                                                        map[string]bool
	exportExists                                                          map[string]bool
	backupExists                                                          map[string]bool
	evidenceCheckError                                                    error
}

func (store *workerStoreFake) DeleteExpiredInternalRecords(context.Context) error {
	store.internalCalls++
	return nil
}

func (store *workerStoreFake) PurgeExpiredEvidence(
	ctx context.Context, _ int, deleteObject DeleteObjectFunc,
) (int, error) {
	store.evidencePurgeCalls++
	if store.evidencePurgeCalls > 1 {
		return 0, nil
	}
	return 1, deleteObject(ctx, "expired/evidence")
}

func (store *workerStoreFake) PurgeExpiredExports(
	ctx context.Context, _ int, deleteObject DeleteObjectFunc,
) (int, error) {
	store.exportPurgeCalls++
	if store.exportPurgeCalls > 1 {
		return 0, nil
	}
	return 1, deleteObject(ctx, "expired/export")
}

func (store *workerStoreFake) PurgeExpiredBackups(
	ctx context.Context, _ int, deleteObject DeleteObjectFunc,
) (int, error) {
	store.backupPurgeCalls++
	if store.backupPurgeCalls > 1 {
		return 0, nil
	}
	return 1, deleteObject(ctx, "expired/backup")
}

func (store *workerStoreFake) EvidenceObjectExists(_ context.Context, key string) (bool, error) {
	if store.evidenceCheckError != nil {
		return false, store.evidenceCheckError
	}
	return store.evidenceExists[key], nil
}

func (store *workerStoreFake) ExportObjectExists(_ context.Context, key string) (bool, error) {
	return store.exportExists[key], nil
}

func (store *workerStoreFake) BackupObjectExists(_ context.Context, key string) (bool, error) {
	return store.backupExists[key], nil
}

func TestWorkerRejectsOverlappingExportAndBackupPrefixes(t *testing.T) {
	t.Parallel()
	_, err := NewWorker(&workerStoreFake{}, &objectStoreFake{}, &objectStoreFake{}, WorkerSettings{
		EvidencePrefix: "evidence/", ExportPrefix: "exports/", BackupPrefix: "exports/backups/",
		OrphanGrace: time.Hour, BatchSize: 100,
	})
	if err == nil {
		t.Fatal("重複するexport/backup prefixを受理しました")
	}
}

type objectStoreFake struct {
	refs    []objectstore.Ref
	deleted []string
}

func (*objectStoreFake) Put(context.Context, string, string, []byte) error { return nil }
func (*objectStoreFake) PutReader(context.Context, string, string, io.Reader, int64) error {
	return nil
}
func (*objectStoreFake) Get(context.Context, string) (objectstore.Object, error) {
	return objectstore.Object{Body: io.NopCloser(nil)}, nil
}
func (store *objectStoreFake) Delete(_ context.Context, key string) error {
	store.deleted = append(store.deleted, key)
	return nil
}
func (store *objectStoreFake) List(_ context.Context, prefix string) ([]objectstore.Ref, error) {
	refs := make([]objectstore.Ref, 0, len(store.refs))
	for _, ref := range store.refs {
		if strings.HasPrefix(ref.Key, prefix) {
			refs = append(refs, ref)
		}
	}
	return refs, nil
}
func (*objectStoreFake) CheckReadiness(context.Context) error { return nil }
func (*objectStoreFake) Close() error                         { return nil }

func equalStrings(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range actual {
		if actual[index] != expected[index] {
			return false
		}
	}
	return true
}
