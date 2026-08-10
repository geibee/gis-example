package discussion

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
)

const (
	testSessionID = "11111111-1111-4111-8111-111111111111"
	testThreadID  = "22222222-2222-4222-8222-222222222222"
)

type recordingDiscussionStore struct {
	createThreadInput  CreateThreadInput
	createThreadResult Mutation[Thread]
	createThreadErr    error
	rateExceeded       []string
}

func (store *recordingDiscussionStore) ListThreads(context.Context, ListThreadsInput) (ThreadPage, error) {
	return ThreadPage{}, nil
}
func (store *recordingDiscussionStore) GetThread(context.Context, string) (Thread, error) {
	return Thread{}, nil
}
func (store *recordingDiscussionStore) CreateThread(_ context.Context, input CreateThreadInput) (Mutation[Thread], error) {
	store.createThreadInput = input
	return store.createThreadResult, store.createThreadErr
}
func (store *recordingDiscussionStore) GetThreadDeepLink(context.Context, string) (string, error) {
	return "", nil
}
func (store *recordingDiscussionStore) CreateMessage(context.Context, CreateMessageInput) (Mutation[Message], error) {
	return Mutation[Message]{}, nil
}
func (store *recordingDiscussionStore) PatchMessage(context.Context, PatchMessageInput) (Message, error) {
	return Message{}, nil
}
func (store *recordingDiscussionStore) ListMessageVersions(context.Context, string) ([]MessageVersion, error) {
	return nil, nil
}
func (store *recordingDiscussionStore) PatchThreadStatus(context.Context, PatchThreadStatusInput) (Thread, error) {
	return Thread{}, nil
}
func (store *recordingDiscussionStore) EnforceWriteRateLimit(context.Context, RateLimitInput) ([]string, error) {
	return append([]string(nil), store.rateExceeded...), nil
}

type recordingStager struct {
	stageInput evidence.Input
	threadID   string
	attachment evidence.Attachment
	stageErr   error
	discarded  []evidence.Attachment
	discardErr error
}

func (stager *recordingStager) Stage(
	_ context.Context,
	_ auth.ResourceScope,
	threadID string,
	input evidence.Input,
) (evidence.Attachment, error) {
	stager.threadID = threadID
	stager.stageInput = input
	return stager.attachment, stager.stageErr
}

func (stager *recordingStager) Discard(_ context.Context, attachment evidence.Attachment) error {
	stager.discarded = append(stager.discarded, attachment)
	return stager.discardErr
}

func validCreateThreadInput() CreateThreadInput {
	return CreateThreadInput{
		Scope: auth.ResourceScope{
			TenantID: "tenant", ApplicationID: "application", EnvironmentID: "environment", WorkspaceID: "workspace",
		},
		SessionID: testSessionID,
		Principal: auth.Principal{Subject: "subject"},
		Request: ThreadCreateRequest{
			Location:        []byte(`{"schemaVersion":"1","pageKey":"home","routeTemplate":"/","pathParameters":{}}`),
			Target:          []byte(`{"schemaVersion":"1","kind":"screen-position","relativeX":0.5,"relativeY":0.5}`),
			PerspectiveCode: "ux",
			Body:            "message",
		},
		IdempotencyKey: "test-idempotency-key",
		RequestHash:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
}

func TestCreateThreadStagesOutsideStoreAndDiscardsKnownRollback(t *testing.T) {
	t.Parallel()
	want := errors.New("transaction rollback")
	store := &recordingDiscussionStore{
		createThreadResult: Mutation[Thread]{EvidenceCleanup: CleanupDiscardNow},
		createThreadErr:    want,
	}
	attachment := evidence.Attachment{ObjectKey: "evidence/key", ContentType: "image/png", ByteSize: 8}
	stager := &recordingStager{attachment: attachment}
	service, err := NewService(store, stager, 123, WithIDGenerator(func() string { return testThreadID }))
	if err != nil {
		t.Fatal(err)
	}
	input := validCreateThreadInput()
	input.Request.Evidence = &evidence.Input{ContentType: "image/png", Data: []byte("bytes"), CapturedAt: time.Now()}

	_, err = service.CreateThread(context.Background(), input)
	if !errors.Is(err, want) {
		t.Fatalf("store errorが置き換わりました: %v", err)
	}
	if stager.threadID != testThreadID || store.createThreadInput.ThreadID != testThreadID {
		t.Fatalf("preallocated thread IDが共有されていません: stage=%q store=%q", stager.threadID, store.createThreadInput.ThreadID)
	}
	if store.createThreadInput.Evidence == nil || store.createThreadInput.Evidence.ObjectKey != attachment.ObjectKey {
		t.Fatal("staged attachmentがtransaction inputへ渡されていません")
	}
	if store.createThreadInput.EvidenceMaximum != 123 {
		t.Fatalf("quota=%d", store.createThreadInput.EvidenceMaximum)
	}
	if len(stager.discarded) != 1 || stager.discarded[0].ObjectKey != attachment.ObjectKey {
		t.Fatalf("既知rollbackでdiscardされませんでした: %#v", stager.discarded)
	}
}

func TestCreateThreadDoesNotDiscardCommitUnknown(t *testing.T) {
	t.Parallel()
	store := &recordingDiscussionStore{
		createThreadResult: Mutation[Thread]{EvidenceCleanup: CleanupDeferToOrphanSweep},
		createThreadErr:    &Error{Kind: ErrCommitUnknown, Code: "database.commit_unknown", Detail: "unknown"},
	}
	attachment := evidence.Attachment{ObjectKey: "evidence/key"}
	stager := &recordingStager{attachment: attachment}
	observed := make(chan error, 1)
	service, err := NewService(
		store, stager, 123,
		WithIDGenerator(func() string { return testThreadID }),
		WithEvidenceCleanupObserver(func(_ context.Context, got evidence.Attachment, err error) {
			if got.ObjectKey != attachment.ObjectKey {
				t.Errorf("observer attachment=%#v", got)
			}
			observed <- err
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	input := validCreateThreadInput()
	input.Request.Evidence = &evidence.Input{ContentType: "image/png", Data: []byte("bytes"), CapturedAt: time.Now()}

	result, err := service.CreateThread(context.Background(), input)
	if !errors.Is(err, ErrCommitUnknown) || result.EvidenceCleanup != CleanupDeferToOrphanSweep {
		t.Fatalf("commit unknown境界が失われました: result=%#v err=%v", result, err)
	}
	if len(stager.discarded) != 0 {
		t.Fatal("commit結果不明でobjectを即時削除しました")
	}
	select {
	case got := <-observed:
		if !errors.Is(got, ErrCommitUnknown) {
			t.Fatalf("observer error=%v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("orphan observerが呼ばれませんでした")
	}
}

func TestCreateThreadReplayDiscardsNewStage(t *testing.T) {
	t.Parallel()
	store := &recordingDiscussionStore{
		createThreadResult: Mutation[Thread]{
			Value: Thread{ID: "existing"}, Replay: true, EvidenceCleanup: CleanupDiscardNow,
		},
	}
	stager := &recordingStager{attachment: evidence.Attachment{ObjectKey: "new-stage"}}
	service, err := NewService(store, stager, 10, WithIDGenerator(func() string { return testThreadID }))
	if err != nil {
		t.Fatal(err)
	}
	input := validCreateThreadInput()
	input.Request.Evidence = &evidence.Input{ContentType: "image/png", Data: []byte("bytes"), CapturedAt: time.Now()}
	result, err := service.CreateThread(context.Background(), input)
	if err != nil || !result.Replay || len(stager.discarded) != 1 {
		t.Fatalf("replay cleanup mismatch: result=%#v discarded=%#v err=%v", result, stager.discarded, err)
	}
}

func TestCreateThreadMapsEvidenceQuotaWithRetryAfter(t *testing.T) {
	t.Parallel()
	store := &recordingDiscussionStore{
		createThreadResult: Mutation[Thread]{EvidenceCleanup: CleanupDiscardNow},
		createThreadErr: &evidence.Error{
			Kind: evidence.ErrQuotaExceeded, Code: "evidence.quota_exceeded", Detail: "quota",
		},
	}
	stager := &recordingStager{attachment: evidence.Attachment{ObjectKey: "new-stage"}}
	service, err := NewService(store, stager, 10, WithIDGenerator(func() string { return testThreadID }))
	if err != nil {
		t.Fatal(err)
	}
	input := validCreateThreadInput()
	input.Request.Evidence = &evidence.Input{ContentType: "image/png", Data: []byte("bytes"), CapturedAt: time.Now()}
	_, err = service.CreateThread(context.Background(), input)
	var domainError *Error
	if !errors.Is(err, ErrRateLimited) || !errors.As(err, &domainError) ||
		domainError.Code != "evidence.quota_exceeded" || domainError.RetryAfterSeconds != 60 {
		t.Fatalf("quota mapping=%v domain=%+v", err, domainError)
	}
	if len(stager.discarded) != 1 {
		t.Fatalf("quota rollbackでstageが残りました: %#v", stager.discarded)
	}
}

func TestListThreadsAcceptsLimit200(t *testing.T) {
	t.Parallel()
	service, err := NewService(&recordingDiscussionStore{}, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListThreads(context.Background(), ListThreadsInput{SessionID: testSessionID, Limit: 200}); err != nil {
		t.Fatalf("limit=200が拒否されました: %v", err)
	}
	if _, err := service.ListThreads(context.Background(), ListThreadsInput{SessionID: testSessionID, Limit: 201}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("limit=201が拒否されませんでした: %v", err)
	}
}

func TestWriteRateLimitCarriesRetryAfter(t *testing.T) {
	t.Parallel()
	store := &recordingDiscussionStore{rateExceeded: []string{"tenant", "ip"}}
	service, err := NewService(store, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	err = service.EnforceWriteRateLimit(context.Background(), RateLimitInput{
		Scope: auth.ResourceScope{
			TenantID: "tenant", ApplicationID: "application", EnvironmentID: "environment", WorkspaceID: "workspace",
		}, Principal: auth.Principal{Subject: "subject"},
		RemoteAddress: "192.0.2.1", PrincipalLimitPerMinute: 1, TenantLimitPerMinute: 1, IPLimitPerMinute: 1,
	})
	var domainError *Error
	if !errors.Is(err, ErrRateLimited) || !errors.As(err, &domainError) || domainError.RetryAfterSeconds != 60 {
		t.Fatalf("429 contract mismatch: %v %#v", err, domainError)
	}
}

func TestWriteRateLimitAcceptsWorkspaceScopeWithoutEnvironment(t *testing.T) {
	t.Parallel()
	store := &recordingDiscussionStore{}
	service, err := NewService(store, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	err = service.EnforceWriteRateLimit(context.Background(), RateLimitInput{
		Scope: auth.ResourceScope{
			TenantID: "tenant", ApplicationID: "application", WorkspaceID: "workspace",
		},
		Principal: auth.Principal{Subject: "subject"}, RemoteAddress: "192.0.2.1",
		PrincipalLimitPerMinute: 1, TenantLimitPerMinute: 1, IPLimitPerMinute: 1,
	})
	if err != nil {
		t.Fatalf("environmentなしworkspace scopeを拒否しました: %v", err)
	}
}
