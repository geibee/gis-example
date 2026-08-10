package legacymigration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

const legacyRunID = "c6bd0379-59dc-483e-8a6a-a9113b9b36f1"

func TestApplyPreservesObjectsWhenCommitResultIsUnknown(t *testing.T) {
	t.Parallel()
	database := &legacyStoreFake{applyErr: ErrCommitUnknown}
	objects := &legacyObjectStoreFake{}
	service := newLegacyServiceForTest(t, database, objects)

	_, err := service.Apply(context.Background(), validLegacySnapshot(), legacyRunID)
	if !errors.Is(err, ErrCommitUnknown) {
		t.Fatalf("Apply() error = %v, want ErrCommitUnknown", err)
	}
	if objects.putCalls != 1 || objects.deleteCalls != 0 {
		t.Fatalf("put=%d delete=%d", objects.putCalls, objects.deleteCalls)
	}
	if database.lastPlan.Report.RunID != legacyRunID || len(database.lastPlan.Evidence) != 1 {
		t.Fatalf("plan = %#v", database.lastPlan)
	}
}

func TestApplyCleansObjectsAfterKnownDatabaseFailure(t *testing.T) {
	t.Parallel()
	database := &legacyStoreFake{applyErr: errors.New("callback failed")}
	objects := &legacyObjectStoreFake{}
	service := newLegacyServiceForTest(t, database, objects)

	if _, err := service.Apply(context.Background(), validLegacySnapshot(), legacyRunID); err == nil {
		t.Fatal("Apply() succeeded")
	}
	if objects.putCalls != 1 || objects.deleteCalls != 1 {
		t.Fatalf("put=%d delete=%d", objects.putCalls, objects.deleteCalls)
	}
}

func TestApplyReplaysAppliedRunWithoutStorageWrite(t *testing.T) {
	t.Parallel()
	snapshot := validLegacySnapshot()
	checksum, err := SnapshotChecksum(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	database := &legacyStoreFake{
		found: true, run: Run{ID: legacyRunID, SourceChecksum: checksum, Status: "applied"},
	}
	objects := &legacyObjectStoreFake{objects: map[string][]byte{
		"evidence/migration/" + legacyRunID + "/" + snapshot.Evidence[0].ID: legacyPNGBytes(),
	}}
	service := newLegacyServiceForTest(t, database, objects)
	report, err := service.Apply(context.Background(), snapshot, legacyRunID)
	if err != nil || len(report.Differences) != 0 {
		t.Fatalf("report=%#v error=%v", report, err)
	}
	if objects.putCalls != 0 || database.applyCalls != 0 || database.reconcileCalls != 1 {
		t.Fatalf("put=%d apply=%d reconcile=%d", objects.putCalls, database.applyCalls, database.reconcileCalls)
	}
}

func TestApplyAdoptsMatchingObjectFromInterruptedPut(t *testing.T) {
	t.Parallel()
	snapshot := validLegacySnapshot()
	key := "evidence/migration/" + legacyRunID + "/" + snapshot.Evidence[0].ID
	database := &legacyStoreFake{}
	objects := &legacyObjectStoreFake{objects: map[string][]byte{key: legacyPNGBytes()}}
	service := newLegacyServiceForTest(t, database, objects)
	if _, err := service.Apply(context.Background(), snapshot, legacyRunID); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if objects.putCalls != 0 || database.applyCalls != 1 {
		t.Fatalf("put=%d apply=%d", objects.putCalls, database.applyCalls)
	}
}

func TestRollbackRetriesObjectDeleteAndCanResumeRolledBackRun(t *testing.T) {
	t.Parallel()
	snapshot := validLegacySnapshot()
	checksum, _ := SnapshotChecksum(snapshot)
	key := "evidence/migration/" + legacyRunID + "/" + snapshot.Evidence[0].ID
	database := &legacyStoreFake{
		found: true, run: Run{ID: legacyRunID, SourceChecksum: checksum, Status: "applied"},
		rollback: RollbackResult{ObjectKeys: []string{key}},
	}
	objects := &legacyObjectStoreFake{objects: map[string][]byte{key: legacyPNGBytes()}, deleteFailures: 1}
	service := newLegacyServiceForTest(t, database, objects)
	if _, err := service.Rollback(context.Background(), snapshot, legacyRunID); err != nil {
		t.Fatalf("Rollback() error = %v", err)
	}
	if objects.deleteCalls != 2 {
		t.Fatalf("delete calls = %d, want 2", objects.deleteCalls)
	}
	if database.reconcileCalls != 1 || database.rollbackCalls != 1 {
		t.Fatalf("reconcile=%d rollback=%d", database.reconcileCalls, database.rollbackCalls)
	}
}

func TestRollbackFailsClosedOnDrift(t *testing.T) {
	t.Parallel()
	snapshot := validLegacySnapshot()
	checksum, _ := SnapshotChecksum(snapshot)
	database := &legacyStoreFake{
		found: true, run: Run{ID: legacyRunID, SourceChecksum: checksum, Status: "applied"},
		differences: []string{"thread drift"},
	}
	objects := &legacyObjectStoreFake{objects: map[string][]byte{
		"evidence/migration/" + legacyRunID + "/" + snapshot.Evidence[0].ID: legacyPNGBytes(),
	}}
	service := newLegacyServiceForTest(t, database, objects)
	_, err := service.Rollback(context.Background(), snapshot, legacyRunID)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("Rollback() error = %v", err)
	}
	if database.rollbackCalls != 0 || objects.deleteCalls != 0 {
		t.Fatalf("rollback=%d delete=%d", database.rollbackCalls, objects.deleteCalls)
	}
}

func TestValidateSnapshotRejectsRelationsHistoryAndEvidence(t *testing.T) {
	t.Parallel()
	tests := map[string]func(*Snapshot){
		"unsupported schema":    func(value *Snapshot) { value.SchemaVersion = "2" },
		"duplicate resource ID": func(value *Snapshot) { value.Threads[0].ID = value.Sessions[0].ID },
		"unknown session":       func(value *Snapshot) { value.Threads[0].ReviewSessionID = "7cbcc65f-6001-47d7-9b32-8f8342291803" },
		"history gap":           func(value *Snapshot) { value.MessageVersions[0].Version = 2 },
		"evidence SHA":          func(value *Snapshot) { value.Evidence[0].SHA256 = strings.Repeat("0", 64) },
		"evidence duplicate reference": func(value *Snapshot) {
			copy := value.Threads[0]
			copy.ID = "8ab3f849-3ff8-47d4-af23-e67228e3fc63"
			copy.DisplayNumber = 2
			value.Threads = append(value.Threads, copy)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			value := validLegacySnapshot()
			mutate(&value)
			if _, err := validateSnapshot(value, defaultMaximumEvidenceBytes); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestDecodeSnapshotIsStrictAndNormalizesCollections(t *testing.T) {
	t.Parallel()
	_, err := DecodeSnapshot(strings.NewReader(`{"sourceSystem":"legacy","unknown":true}`))
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown field error = %v", err)
	}
	value, err := DecodeSnapshot(strings.NewReader(`{
        "sourceSystem":"legacy","applicationKey":"app","environmentKey":"prod",
        "externalWorkspaceKey":"ws","manifestVersion":"1",
        "sessions":[],"threads":[],"messages":[],"messageVersions":[]
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if value.SchemaVersion != "1" || value.Sessions == nil || value.Evidence == nil {
		t.Fatalf("normalized snapshot = %#v", value)
	}
}

func TestMappingPreservesRouteAndSanitizesAudit(t *testing.T) {
	t.Parallel()
	snapshot := validLegacySnapshot()
	manifest := json.RawMessage(`{"routes":[{"pageKey":"item","template":"/items/{id}","parameters":{"id":{"persistence":"hash"}},"queryParameters":{"tab":{"persistence":"store"}}}]}`)
	mapped, err := mapThreads(snapshot, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(mapped) != 1 || !bytes.Contains(mapped[0].Location, []byte(`"tab":"details"`)) ||
		!bytes.Contains(mapped[0].Location, []byte(`"id":"sha256:`)) {
		t.Fatalf("location = %s", mapped[0].Location)
	}
	sanitized, err := SanitizeAuditChanges(json.RawMessage(`{"token":"secret","safe":"value"}`))
	if err != nil || !bytes.Contains(sanitized, []byte(`"token":"***"`)) {
		t.Fatalf("sanitized=%s error=%v", sanitized, err)
	}
}

func TestSnapshotChecksumMatchesKotlinDoubleEncoding(t *testing.T) {
	t.Parallel()
	snapshot := Snapshot{
		SourceSystem: "legacy", ApplicationKey: "app", EnvironmentKey: "prod",
		ExternalWorkspaceKey: "ws", ManifestVersion: "v1",
		Evidence: []EvidenceSnapshot{{
			ID: "id", DataBase64: "data", ContentType: "image/png", SHA256: "sha",
			ViewportWidth: 1, ViewportHeight: 1, PixelRatio: 2,
			CapturedAt: "captured", CreatedAt: "created", LegacyObjectReference: "legacy",
		}},
	}
	raw := `{"schemaVersion":"1","sourceSystem":"legacy","applicationKey":"app","environmentKey":"prod","externalWorkspaceKey":"ws","manifestVersion":"v1","projectEvidenceRetentionDays":null,"sessions":[],"threads":[],"messages":[],"messageVersions":[],"evidence":[{"id":"id","dataBase64":"data","contentType":"image/png","sha256":"sha","viewportWidth":1,"viewportHeight":1,"pixelRatio":2.0,"capturedAt":"captured","createdAt":"created","expiresAt":null,"legacyObjectReference":"legacy"}],"audits":[],"outbox":[]}`
	hash := sha256.Sum256([]byte(raw))
	want := hex.EncodeToString(hash[:])
	got, err := SnapshotChecksum(snapshot)
	if err != nil || got != want {
		t.Fatalf("SnapshotChecksum()=%s error=%v, want %s", got, err, want)
	}
}

func newLegacyServiceForTest(t *testing.T, store Store, objects objectstore.Store) *Service {
	t.Helper()
	service, err := NewService(store, objects, Settings{
		EvidencePrefix: "evidence/migration/", MaximumEvidenceBytes: 1024,
		StorageTimeout: time.Second, DeleteAttempts: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func validLegacySnapshot() Snapshot {
	png := legacyPNGBytes()
	hash := sha256.Sum256(png)
	evidenceID := "d2f5f515-c5b1-4d06-b4a8-b9ac24158975"
	return Snapshot{
		SchemaVersion: "1", SourceSystem: "legacy-v4", ApplicationKey: "web-gis",
		EnvironmentKey: "production", ExternalWorkspaceKey: "workspace", ManifestVersion: "1",
		Sessions: []SessionSnapshot{{
			ID: "2d3553d9-a307-4774-90bc-49886f742497", Title: "Review", Status: "open",
			CreatedAt: "2026-01-02T03:04:05Z", UpdatedAt: "2026-01-02T03:04:05Z",
			Scopes:       []ScopeSnapshot{{ID: "b9668e92-ff06-458f-bfd6-248384fa172a", PageID: "item", Route: stringPointer("/items/{id}"), Reviewable: true}},
			Perspectives: []PerspectiveSnapshot{{Code: "ux", Label: "UX", Status: "active"}},
		}},
		Threads: []ThreadSnapshot{{
			ID: "16e6732a-2f7b-4289-861f-9ccac630be6f", ReviewSessionID: "2d3553d9-a307-4774-90bc-49886f742497",
			DisplayNumber: 1, PageID: "item", PageRoute: stringPointer("https://app.example.test/items/42?tab=details"),
			PerspectiveCode: "ux", TargetType: "UI_ELEMENT",
			TargetMetadata: json.RawMessage(`{"feedbackTargetId":"save","relativeX":0.25,"relativeY":0.5}`),
			EvidenceID:     &evidenceID, Status: "open", ReporterPrincipalID: "legacy:user",
			CreatedAt: "2026-01-02T03:04:05Z", UpdatedAt: "2026-01-02T03:04:05Z",
		}},
		Messages: []MessageSnapshot{{
			ID: "47216e72-8c62-44fc-8614-f76405a2ffea", ThreadID: "16e6732a-2f7b-4289-861f-9ccac630be6f",
			AuthorPrincipalID: "legacy:user", Body: "message", CreatedAt: "2026-01-02T03:04:05Z",
		}},
		MessageVersions: []MessageVersionSnapshot{{
			MessageID: "47216e72-8c62-44fc-8614-f76405a2ffea", Version: 1, Body: "message",
			EditorPrincipalID: "legacy:user", CreatedAt: "2026-01-02T03:04:05Z",
		}},
		Evidence: []EvidenceSnapshot{{
			ID: evidenceID, DataBase64: base64.StdEncoding.EncodeToString(png), ContentType: "image/png",
			SHA256: hex.EncodeToString(hash[:]), ViewportWidth: 800, ViewportHeight: 600, PixelRatio: 2,
			CapturedAt: "2026-01-02T03:04:05Z", CreatedAt: "2026-01-02T03:04:05Z",
			LegacyObjectReference: "legacy/screenshots/example.png",
		}},
		Audits: []AuditSnapshot{{
			ID: "c88c45f3-2058-4af6-afc4-455645634263", Action: "feedback.read", Outcome: "SUCCESS",
			RequestID: "legacy-request", Changes: json.RawMessage(`{"body":"sensitive"}`), OccurredAt: "2026-01-02T03:04:05Z",
		}},
		Outbox: []OutboxSnapshot{{
			ID: "503fc5db-e67b-4482-bb01-9b897845282e", ReviewSessionID: "2d3553d9-a307-4774-90bc-49886f742497",
			ThreadID: "16e6732a-2f7b-4289-861f-9ccac630be6f", EventType: "THREAD_CREATED", CreatedAt: "2026-01-02T03:04:05Z",
		}},
	}
}

func legacyPNGBytes() []byte             { return []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'} }
func stringPointer(value string) *string { return &value }

type legacyStoreFake struct {
	mu             sync.Mutex
	found          bool
	run            Run
	applyErr       error
	differences    []string
	rollback       RollbackResult
	lastPlan       ApplyPlan
	applyCalls     int
	reconcileCalls int
	rollbackCalls  int
}

func (store *legacyStoreFake) ValidateLegacyMigrationSchema(context.Context) error { return nil }
func (store *legacyStoreFake) ResolveLegacyMigrationScope(context.Context, Snapshot) (Scope, error) {
	return Scope{
		TenantID: "tenant", ApplicationID: "application", EnvironmentID: "environment", WorkspaceID: "workspace",
		Manifest: json.RawMessage(`{"routes":[{"pageKey":"item","template":"/items/{id}","parameters":{"id":{"persistence":"hash"}},"queryParameters":{"tab":{"persistence":"store"}}}]}`),
	}, nil
}
func (store *legacyStoreFake) FindLegacyMigrationRun(context.Context, string) (Run, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.run, store.found, nil
}
func (store *legacyStoreFake) CheckLegacyMigrationCollisions(context.Context, CollisionInput) error {
	return nil
}
func (store *legacyStoreFake) ApplyLegacyMigration(_ context.Context, plan ApplyPlan) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.applyCalls++
	store.lastPlan = plan
	return store.applyErr
}
func (store *legacyStoreFake) ReconcileLegacyMigration(context.Context, ApplyPlan) ([]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.reconcileCalls++
	return append([]string(nil), store.differences...), nil
}
func (store *legacyStoreFake) RollbackLegacyMigration(context.Context, string, string) (RollbackResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.rollbackCalls++
	return store.rollback, nil
}

type legacyObjectStoreFake struct {
	mu             sync.Mutex
	objects        map[string][]byte
	putCalls       int
	deleteCalls    int
	deleteFailures int
}

func (store *legacyObjectStoreFake) Put(_ context.Context, key, _ string, data []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.putCalls++
	if store.objects == nil {
		store.objects = make(map[string][]byte)
	}
	store.objects[key] = append([]byte(nil), data...)
	return nil
}
func (store *legacyObjectStoreFake) PutReader(
	ctx context.Context, key, contentType string, reader io.Reader, size int64,
) error {
	data, err := io.ReadAll(io.LimitReader(reader, size+1))
	if err != nil || int64(len(data)) != size {
		return errors.Join(err, io.ErrUnexpectedEOF)
	}
	return store.Put(ctx, key, contentType, data)
}
func (store *legacyObjectStoreFake) Get(_ context.Context, key string) (objectstore.Object, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	data, ok := store.objects[key]
	if !ok {
		return objectstore.Object{}, objectstore.ErrNotFound
	}
	return objectstore.Object{Key: key, Size: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data))}, nil
}
func (store *legacyObjectStoreFake) Delete(_ context.Context, key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deleteCalls++
	if store.deleteFailures > 0 {
		store.deleteFailures--
		return errors.New("delete unavailable")
	}
	delete(store.objects, key)
	return nil
}
func (store *legacyObjectStoreFake) List(_ context.Context, prefix string) ([]objectstore.Ref, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	result := make([]objectstore.Ref, 0)
	for key := range store.objects {
		if strings.HasPrefix(key, prefix) {
			result = append(result, objectstore.Ref{Key: key})
		}
	}
	return result, nil
}
func (store *legacyObjectStoreFake) CheckReadiness(context.Context) error { return nil }
func (store *legacyObjectStoreFake) Close() error                         { return nil }
