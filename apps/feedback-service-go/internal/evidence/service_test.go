package evidence

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

const (
	tenantID    = "11111111-1111-4111-8111-111111111111"
	workspaceID = "22222222-2222-4222-8222-222222222222"
	threadID    = "33333333-3333-4333-8333-333333333333"
	userID      = "44444444-4444-4444-8444-444444444444"
)

func TestStageBuildsCompatibleKeyAndMetadata(t *testing.T) {
	t.Parallel()
	storage := &fakeStore{}
	service := newTestService(t, &fakeRepository{}, storage)
	input := validInput()
	attachment, err := service.Stage(context.Background(), auth.ResourceScope{
		TenantID: tenantID, WorkspaceID: workspaceID,
	}, threadID, input)
	if err != nil {
		t.Fatalf("Stage() error=%v", err)
	}
	wantKey := "evidence/" + tenantID + "/" + workspaceID + "/" + threadID
	if attachment.ObjectKey != wantKey || attachment.ByteSize != int64(len(input.Data)) {
		t.Fatalf("attachment=%+v", attachment)
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if storage.putKey != wantKey || storage.putContentType != "image/png" || !bytes.Equal(storage.putData, input.Data) {
		t.Fatalf("put key=%q contentType=%q data=%q", storage.putKey, storage.putContentType, storage.putData)
	}
}

func TestNewServiceRejectsUnsafeSettings(t *testing.T) {
	t.Parallel()
	tests := []Settings{
		{KeyPrefix: "../evidence/", MaximumBytes: 1024, StorageTimeout: time.Second, OrphanGrace: 5 * time.Minute, DeleteAttempts: 1},
		{KeyPrefix: "evidence", MaximumBytes: 1024, StorageTimeout: time.Second, OrphanGrace: 5 * time.Minute, DeleteAttempts: 1},
		{KeyPrefix: "evidence/", MaximumBytes: 0, StorageTimeout: time.Second, OrphanGrace: 5 * time.Minute, DeleteAttempts: 1},
		{KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: 0, OrphanGrace: 5 * time.Minute, DeleteAttempts: 1},
		{KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: time.Second, OrphanGrace: time.Minute, DeleteAttempts: 1},
	}
	for index, settings := range tests {
		if _, err := NewService(&fakeRepository{}, &fakeStore{}, &fakeAuthorizer{}, settings); err == nil {
			t.Fatalf("settings[%d]が受理されました: %+v", index, settings)
		}
	}
}

func TestStageStorageTimeoutFailsClosed(t *testing.T) {
	t.Parallel()
	storage := &fakeStore{putFn: func(ctx context.Context, _ string, _ string, _ []byte) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	repository := &fakeRepository{}
	service := newTestServiceWithSettings(t, repository, storage, Settings{
		KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: time.Millisecond,
		OrphanGrace: 5 * time.Minute, DeleteAttempts: 1,
	})
	_, err := service.Stage(context.Background(), auth.ResourceScope{TenantID: tenantID, WorkspaceID: workspaceID}, threadID, validInput())
	if !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Stage() error=%v, want ErrStorageUnavailable", err)
	}
	if repository.failureCount() != 1 {
		t.Fatalf("storage failure metric count=%d", repository.failureCount())
	}
}

func TestDiscardRetriesKnownRollback(t *testing.T) {
	t.Parallel()
	var attempts int
	storage := &fakeStore{deleteFn: func(context.Context, string) error {
		attempts++
		if attempts < 3 {
			return errors.New("temporary")
		}
		return nil
	}}
	service := newTestServiceWithSettings(t, &fakeRepository{}, storage, Settings{
		KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: time.Second,
		OrphanGrace: 5 * time.Minute, DeleteAttempts: 3,
	})
	if err := service.Discard(context.Background(), Attachment{ObjectKey: "evidence/a"}); err != nil {
		t.Fatalf("Discard() error=%v", err)
	}
	if attempts != 3 {
		t.Fatalf("delete attempts=%d, want 3", attempts)
	}
}

func TestDownloadAuthorizesAndVerifiesMetadata(t *testing.T) {
	t.Parallel()
	input := validInput()
	attachment, err := Prepare(input, 1024)
	if err != nil {
		t.Fatal(err)
	}
	attachment.ObjectKey = "evidence/object"
	repository := &fakeRepository{metadata: Metadata{ThreadID: threadID, Attachment: attachment}}
	storage := &fakeStore{getObject: objectstore.Object{
		Key: attachment.ObjectKey, ContentType: attachment.ContentType, Size: attachment.ByteSize,
		Body: io.NopCloser(bytes.NewReader(input.Data)),
	}}
	authorizer := &fakeAuthorizer{}
	var observed auth.ResourceScope
	service, err := NewService(repository, storage, authorizer, testSettings(), WithScopeObserver(func(_ context.Context, scope auth.ResourceScope) {
		observed = scope
	}))
	if err != nil {
		t.Fatal(err)
	}
	principal := auth.Principal{UserID: userID, Issuer: "https://issuer.example", Subject: "subject"}
	download, err := service.Download(context.Background(), principal, threadID, "request-id")
	if err != nil || download.ContentType != input.ContentType || !bytes.Equal(download.Data, input.Data) {
		t.Fatalf("Download()=%+v error=%v", download, err)
	}
	if !authorizer.called || authorizer.request.Required != auth.PermissionRead || !authorizer.request.HideExistence {
		t.Fatalf("authorization request=%+v", authorizer.request)
	}
	if observed.TenantID != tenantID || observed.WorkspaceID != workspaceID {
		t.Fatalf("observed scope=%+v", observed)
	}
	if got := repository.auditEvents(); len(got) != 2 || got[0] != "authorization" || got[1] != "read" {
		t.Fatalf("audit events=%v", got)
	}
}

func TestDownloadAuthorizationAuditFailureStopsBeforeMetadata(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{authorizationErr: errors.New("audit unavailable")}
	service := newTestService(t, repository, &fakeStore{})
	_, err := service.Download(context.Background(), auth.Principal{UserID: userID, Subject: "subject"}, threadID, "request")
	if err == nil {
		t.Fatal("allowed監査失敗が返されませんでした")
	}
	if repository.metadataCount() != 0 {
		t.Fatal("allowed監査失敗後にmetadataを読み取りました")
	}
}

func TestDownloadDetectsIntegrityMismatch(t *testing.T) {
	t.Parallel()
	input := validInput()
	base, err := Prepare(input, 1024)
	if err != nil {
		t.Fatal(err)
	}
	base.ObjectKey = "evidence/object"
	tests := []struct {
		name     string
		metadata Attachment
		object   objectstore.Object
	}{
		{name: "byte size", metadata: base, object: objectstore.Object{
			ContentType: base.ContentType, Size: base.ByteSize + 1, Body: io.NopCloser(bytes.NewReader(input.Data)),
		}},
		{name: "object content type", metadata: base, object: objectstore.Object{
			ContentType: "image/webp", Size: base.ByteSize, Body: io.NopCloser(bytes.NewReader(input.Data)),
		}},
		{name: "sha256", metadata: base, object: objectstore.Object{
			ContentType: base.ContentType, Size: base.ByteSize,
			Body: io.NopCloser(bytes.NewReader(append(input.Data[:len(input.Data)-1:len(input.Data)-1], 'x'))),
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &fakeRepository{metadata: Metadata{ThreadID: threadID, Attachment: test.metadata}}
			service := newTestService(t, repository, &fakeStore{getObject: test.object})
			_, err := service.Download(context.Background(), auth.Principal{
				UserID: userID, Issuer: "issuer", Subject: "subject",
			}, threadID, "request")
			if !errors.Is(err, ErrIntegrity) {
				t.Fatalf("Download() error=%v, want ErrIntegrity", err)
			}
			if repository.failureCount() != 1 {
				t.Fatalf("failure count=%d", repository.failureCount())
			}
		})
	}
}

func TestDownloadStorageTimeoutFailsClosed(t *testing.T) {
	t.Parallel()
	input := validInput()
	attachment, _ := Prepare(input, 1024)
	attachment.ObjectKey = "evidence/object"
	repository := &fakeRepository{metadata: Metadata{ThreadID: threadID, Attachment: attachment}}
	storage := &fakeStore{getFn: func(ctx context.Context, _ string) (objectstore.Object, error) {
		<-ctx.Done()
		return objectstore.Object{}, ctx.Err()
	}}
	service := newTestServiceWithSettings(t, repository, storage, Settings{
		KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: time.Millisecond,
		OrphanGrace: 5 * time.Minute, DeleteAttempts: 1,
	})
	_, err := service.Download(context.Background(), auth.Principal{UserID: userID, Subject: "subject"}, threadID, "request")
	if !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("Download() error=%v", err)
	}
}

func TestSweepOrphansDefersCommitUnknownUntilGraceAndConfirmation(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	fresh := objectstore.Ref{Key: "evidence/commit-unknown", LastModified: now.Add(-4 * time.Minute)}
	referenced := objectstore.Ref{Key: "evidence/referenced", LastModified: now.Add(-10 * time.Minute)}
	orphan := objectstore.Ref{Key: "evidence/orphan", LastModified: now.Add(-10 * time.Minute)}
	storage := &fakeStore{refs: []objectstore.Ref{fresh, referenced, orphan}}
	repository := &fakeRepository{exists: map[string]bool{referenced.Key: true, orphan.Key: false}}
	service := newTestService(t, repository, storage)
	result, err := service.SweepOrphans(context.Background(), now)
	if err != nil {
		t.Fatalf("SweepOrphans() error=%v", err)
	}
	if result.Examined != 3 || result.Deleted != 1 || result.Retained != 2 {
		t.Fatalf("result=%+v", result)
	}
	if got := storage.deletedKeys(); len(got) != 1 || got[0] != orphan.Key {
		t.Fatalf("deleted=%v", got)
	}
}

func TestSweepOrphansDoesNotDeleteWhenDatabaseConfirmationFails(t *testing.T) {
	t.Parallel()
	now := time.Now()
	storage := &fakeStore{refs: []objectstore.Ref{
		{Key: "evidence/first", LastModified: now.Add(-time.Hour)},
		{Key: "evidence/second", LastModified: now.Add(-time.Hour)},
	}}
	repository := &fakeRepository{existsFn: func(_ context.Context, key string) (bool, error) {
		if key == "evidence/second" {
			return false, errors.New("database unavailable")
		}
		return false, nil
	}}
	service := newTestService(t, repository, storage)
	if _, err := service.SweepOrphans(context.Background(), now); err == nil {
		t.Fatal("DB照合失敗が返されませんでした")
	}
	if got := storage.deletedKeys(); len(got) != 0 {
		t.Fatalf("DB照合完了前に削除されました: %v", got)
	}
}

func TestPurgeKeepsMetadataUntilObjectDeletionSucceeds(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{}
	storage := &fakeStore{deleteFn: func(context.Context, string) error { return errors.New("unavailable") }}
	service := newTestService(t, repository, storage)
	err := service.Purge(context.Background(), Attachment{ObjectKey: "evidence/object"})
	if !errors.Is(err, ErrStorageUnavailable) || repository.deleteMetadataCount != 0 {
		t.Fatalf("Purge() error=%v metadata deletes=%d", err, repository.deleteMetadataCount)
	}
}

func TestPurgeRecoversAfterMetadataDeletionFailure(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{deleteMetadataErr: errors.New("database unavailable")}
	storage := &fakeStore{}
	service := newTestService(t, repository, storage)
	attachment := Attachment{ObjectKey: "evidence/object"}
	if err := service.Purge(context.Background(), attachment); err == nil {
		t.Fatal("metadata削除失敗が返されませんでした")
	}
	repository.mu.Lock()
	repository.deleteMetadataErr = nil
	repository.mu.Unlock()
	if err := service.Purge(context.Background(), attachment); err != nil {
		t.Fatalf("retry Purge() error=%v", err)
	}
	if len(storage.deletedKeys()) != 2 || repository.deleteMetadataCount != 2 {
		t.Fatalf("object deletes=%v metadata deletes=%d", storage.deletedKeys(), repository.deleteMetadataCount)
	}
}

func TestDiscardFailureRecordsStorageMetric(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{}
	storage := &fakeStore{deleteFn: func(context.Context, string) error { return errors.New("unavailable") }}
	service := newTestService(t, repository, storage)
	err := service.Discard(context.Background(), Attachment{
		ObjectKey: "evidence/" + tenantID + "/" + workspaceID + "/" + threadID,
	})
	if !errors.Is(err, ErrStorageUnavailable) || repository.failureCount() != 1 {
		t.Fatalf("Discard() error=%v failure metrics=%d", err, repository.failureCount())
	}
}

func newTestService(t *testing.T, repository *fakeRepository, storage *fakeStore) *Service {
	t.Helper()
	return newTestServiceWithSettings(t, repository, storage, testSettings())
}

func newTestServiceWithSettings(t *testing.T, repository *fakeRepository, storage *fakeStore, settings Settings) *Service {
	t.Helper()
	service, err := NewService(repository, storage, &fakeAuthorizer{}, settings)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testSettings() Settings {
	return Settings{
		KeyPrefix: "evidence/", MaximumBytes: 1024, StorageTimeout: time.Second,
		OrphanGrace: 5 * time.Minute, DeleteAttempts: 1,
	}
}

type fakeAuthorizer struct {
	called  bool
	request auth.AuthorizationRequest
	err     error
}

func (value *fakeAuthorizer) Authorize(_ context.Context, request auth.AuthorizationRequest) (auth.AuthorizedContext, error) {
	value.called = true
	value.request = request
	return auth.AuthorizedContext{Principal: request.Principal, Scope: request.Scope}, value.err
}

type fakeRepository struct {
	mu                  sync.Mutex
	metadata            Metadata
	exists              map[string]bool
	existsFn            func(context.Context, string) (bool, error)
	resolveErr          error
	metadataErr         error
	auditErr            error
	authorizationErr    error
	deleteMetadataErr   error
	audits              []string
	metadataReads       int
	storageFailures     int
	deleteMetadataCount int
}

func (value *fakeRepository) ResolveEvidenceScope(context.Context, string, string) (auth.ResourceScope, error) {
	return auth.ResourceScope{TenantID: tenantID, WorkspaceID: workspaceID}, value.resolveErr
}

func (value *fakeRepository) GetEvidenceMetadata(context.Context, string) (Metadata, error) {
	value.mu.Lock()
	value.metadataReads++
	authorized := len(value.audits) > 0 && value.audits[len(value.audits)-1] == "authorization"
	value.mu.Unlock()
	if !authorized {
		return Metadata{}, errors.New("metadata取得前にallowed監査がありません")
	}
	return value.metadata, value.metadataErr
}

func (value *fakeRepository) EvidenceObjectExists(ctx context.Context, key string) (bool, error) {
	if value.existsFn != nil {
		return value.existsFn(ctx, key)
	}
	return value.exists[key], nil
}

func (value *fakeRepository) DeleteEvidenceMetadata(context.Context, string) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.deleteMetadataCount++
	return value.deleteMetadataErr
}

func (value *fakeRepository) RecordEvidenceRead(context.Context, auth.ResourceScope, auth.Principal, string, string) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.audits = append(value.audits, "read")
	return value.auditErr
}

func (value *fakeRepository) RecordEvidenceAuthorization(context.Context, auth.ResourceScope, auth.Principal, string) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.audits = append(value.audits, "authorization")
	return value.authorizationErr
}

func (value *fakeRepository) RecordEvidenceStorageFailure(context.Context, string) error {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.storageFailures++
	return nil
}

func (value *fakeRepository) failureCount() int {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.storageFailures
}

func (value *fakeRepository) auditEvents() []string {
	value.mu.Lock()
	defer value.mu.Unlock()
	return append([]string(nil), value.audits...)
}

func (value *fakeRepository) metadataCount() int {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.metadataReads
}

type fakeStore struct {
	mu             sync.Mutex
	putFn          func(context.Context, string, string, []byte) error
	getFn          func(context.Context, string) (objectstore.Object, error)
	deleteFn       func(context.Context, string) error
	listFn         func(context.Context, string) ([]objectstore.Ref, error)
	getObject      objectstore.Object
	refs           []objectstore.Ref
	putKey         string
	putContentType string
	putData        []byte
	deleted        []string
}

func (value *fakeStore) Put(ctx context.Context, key string, contentType string, data []byte) error {
	if value.putFn != nil {
		return value.putFn(ctx, key, contentType, data)
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	value.putKey, value.putContentType = key, contentType
	value.putData = append([]byte(nil), data...)
	return nil
}

func (value *fakeStore) PutReader(
	ctx context.Context, key string, contentType string, reader io.Reader, size int64,
) error {
	data, err := io.ReadAll(io.LimitReader(reader, size+1))
	if err != nil || int64(len(data)) != size {
		return errors.Join(err, io.ErrUnexpectedEOF)
	}
	return value.Put(ctx, key, contentType, data)
}

func (value *fakeStore) Get(ctx context.Context, key string) (objectstore.Object, error) {
	if value.getFn != nil {
		return value.getFn(ctx, key)
	}
	return value.getObject, nil
}

func (value *fakeStore) Delete(ctx context.Context, key string) error {
	if value.deleteFn != nil {
		if err := value.deleteFn(ctx, key); err != nil {
			return err
		}
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	value.deleted = append(value.deleted, key)
	return nil
}

func (value *fakeStore) List(ctx context.Context, prefix string) ([]objectstore.Ref, error) {
	if value.listFn != nil {
		return value.listFn(ctx, prefix)
	}
	return append([]objectstore.Ref(nil), value.refs...), nil
}

func (value *fakeStore) CheckReadiness(context.Context) error { return nil }
func (value *fakeStore) Close() error                         { return nil }

func (value *fakeStore) deletedKeys() []string {
	value.mu.Lock()
	defer value.mu.Unlock()
	return append([]string(nil), value.deleted...)
}
