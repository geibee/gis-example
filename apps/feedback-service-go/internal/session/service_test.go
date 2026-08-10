package session

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestListAuthorizesBeforeListFilters(t *testing.T) {
	t.Parallel()
	store := newFakeStore()
	service := newTestService(t, store, []auth.Permission{auth.PermissionRead})
	_, err := service.List(context.Background(), testPrincipal(), ListInput{
		ApplicationKey: "sample", EnvironmentKey: " test ", ExternalWorkspaceKey: " workspace ",
		Status: stringPointer("invalid"), RequestID: "request-1",
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("List() error = %v", err)
	}
	if store.workspaceArguments != [4]string{"user-id", "sample", "workspace", "test"} {
		t.Fatalf("ResolveWorkspaceScope args = %#v", store.workspaceArguments)
	}
	if len(store.audits) != 1 || store.audits[0].Outcome != "allowed" {
		t.Fatalf("audit = %+v", store.audits)
	}
	if store.listCalled {
		t.Fatal("不正statusでlist storeが呼ばれました")
	}
}

func TestListNormalizesPagination(t *testing.T) {
	t.Parallel()
	store := newFakeStore()
	store.page = Page{Items: []Session{}, TotalCount: 3}
	service := newTestService(t, store, []auth.Permission{auth.PermissionRead})
	page, err := service.List(context.Background(), testPrincipal(), ListInput{
		ApplicationKey: "sample", EnvironmentKey: "test", ExternalWorkspaceKey: "workspace",
		Cursor: stringPointer(EncodeCursor(2)), RequestID: "request-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(page, store.page) || store.listLimit != 50 || store.listOffset != 2 {
		t.Fatalf("page=%+v limit=%d offset=%d", page, store.listLimit, store.listOffset)
	}
}

func TestCreateDenialPrecedesIdempotencyValidation(t *testing.T) {
	t.Parallel()
	store := newFakeStore()
	denials := &denialRecorder{}
	service := newTestServiceWithAuditor(t, store, []auth.Permission{auth.PermissionRead}, denials)
	_, err := service.Create(context.Background(), testPrincipal(), "request-3", CreateCommand{
		Request: CreateRequest{
			ApplicationKey: "sample", EnvironmentKey: "test", ExternalWorkspaceKey: "workspace",
		},
	})
	if !errors.Is(err, auth.ErrPermissionDenied) {
		t.Fatalf("Create() error = %v", err)
	}
	if store.createCalled {
		t.Fatal("認可拒否後にcreate storeが呼ばれました")
	}
	if len(denials.events) != 1 || denials.events[0].Action != string(auth.PermissionManage) {
		t.Fatalf("denials = %+v", denials.events)
	}
}

func TestCreateReturnsScopeWithoutSuccessAudit(t *testing.T) {
	t.Parallel()
	store := newFakeStore()
	store.created = Session{ID: "550e8400-e29b-41d4-a716-446655440000", Version: 1}
	service := newTestService(t, store, []auth.Permission{auth.PermissionManage})
	result, err := service.Create(context.Background(), testPrincipal(), "request-4", CreateCommand{
		Request: CreateRequest{
			ApplicationKey: "sample", EnvironmentKey: "test", ExternalWorkspaceKey: "workspace",
		},
		IdempotencyKey: "test-idempotency-key", RequestHash: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Session.ID != store.created.ID || result.Scope.WorkspaceID != "workspace-id" {
		t.Fatalf("result = %+v", result)
	}
	if len(store.audits) != 1 || store.audits[0].Outcome != "allowed" {
		t.Fatalf("成功auditはhandler境界のためallowedだけを期待: %+v", store.audits)
	}
}

func TestGetCanonicalizesIDAndHidesPermissionDenial(t *testing.T) {
	t.Parallel()
	store := newFakeStore()
	denials := &denialRecorder{}
	service := newTestServiceWithAuditor(t, store, nil, denials)
	_, err := service.Get(
		context.Background(), testPrincipal(), "550E8400-E29B-41D4-A716-446655440000", "request-5",
	)
	var authorizationError *auth.AuthorizationError
	if !errors.As(err, &authorizationError) || !authorizationError.HideExistence {
		t.Fatalf("Get() error = %v", err)
	}
	if store.resourceID != "550e8400-e29b-41d4-a716-446655440000" || store.getCalled {
		t.Fatalf("resourceID=%q getCalled=%v", store.resourceID, store.getCalled)
	}
}

func TestPatchDecodesOnlyAfterAuthorization(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name        string
		permissions []auth.Permission
		wantPrepare bool
		wantError   bool
	}{
		{name: "allowed", permissions: []auth.Permission{auth.PermissionManage}, wantPrepare: true},
		{name: "denied", permissions: []auth.Permission{auth.PermissionRead}, wantError: true},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := newFakeStore()
			store.patched = Session{ID: "550e8400-e29b-41d4-a716-446655440000", Version: 2}
			service := newTestService(t, store, test.permissions)
			prepared := false
			result, err := service.Patch(
				context.Background(), testPrincipal(), store.patched.ID, "request-6",
				func() (Patch, error) {
					prepared = true
					return Patch{ExpectedVersion: 1, Title: stringPointer("updated")}, nil
				},
			)
			if prepared != test.wantPrepare || (err != nil) != test.wantError {
				t.Fatalf("prepared=%v result=%+v err=%v", prepared, result, err)
			}
		})
	}
}

func newTestService(t *testing.T, store *fakeStore, permissions []auth.Permission) *Service {
	t.Helper()
	return newTestServiceWithAuditor(t, store, permissions, &denialRecorder{})
}

func newTestServiceWithAuditor(
	t *testing.T,
	store *fakeStore,
	permissions []auth.Permission,
	auditor auth.DenialAuditor,
) *Service {
	t.Helper()
	authorizer, err := auth.NewAuthorizer(authorizationStore{permissions: permissions}, auditor)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testPrincipal() auth.Principal {
	return auth.Principal{UserID: "user-id", Issuer: "https://issuer.example", Subject: "subject"}
}

type fakeStore struct {
	scope              auth.ResourceScope
	workspaceArguments [4]string
	resourceKind       string
	resourceID         string
	page               Page
	created            Session
	patched            Session
	audits             []usecase.AuditEvent
	listCalled         bool
	listLimit          int
	listOffset         int
	createCalled       bool
	getCalled          bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{scope: auth.ResourceScope{
		TenantID: "tenant-id", TenantKey: "tenant", ApplicationID: "application-id", EnvironmentID: "environment-id",
		WorkspaceID: "workspace-id", ApplicationKey: "sample", EnvironmentKey: "test", ExternalWorkspaceKey: "workspace",
	}}
}

func (store *fakeStore) ResolveWorkspaceScope(
	_ context.Context, userID, applicationKey, workspaceKey, environmentKey string,
) (auth.ResourceScope, error) {
	store.workspaceArguments = [4]string{userID, applicationKey, workspaceKey, environmentKey}
	return store.scope, nil
}

func (store *fakeStore) ResolveResourceScope(
	_ context.Context, _ string, kind, resourceID string,
) (auth.ResourceScope, error) {
	store.resourceKind, store.resourceID = kind, resourceID
	return store.scope, nil
}

func (store *fakeStore) ListSessions(
	_ context.Context, _ auth.ResourceScope, _ *string, limit, offset int,
) (Page, error) {
	store.listCalled, store.listLimit, store.listOffset = true, limit, offset
	return store.page, nil
}

func (store *fakeStore) GetSession(context.Context, string) (Session, error) {
	store.getCalled = true
	return Session{}, nil
}

func (store *fakeStore) CreateSession(
	context.Context, auth.ResourceScope, auth.Principal, CreateCommand,
) (Session, error) {
	store.createCalled = true
	return store.created, nil
}

func (store *fakeStore) PatchSession(context.Context, string, Patch) (Session, error) {
	return store.patched, nil
}

func (store *fakeStore) RecordAudit(_ context.Context, event usecase.AuditEvent) error {
	store.audits = append(store.audits, event)
	return nil
}

type authorizationStore struct{ permissions []auth.Permission }

func (store authorizationStore) ApplicationPermissions(context.Context, string, string) ([]auth.Permission, error) {
	return append([]auth.Permission(nil), store.permissions...), nil
}

func (store authorizationStore) WorkspacePermissions(context.Context, string, string) ([]auth.Permission, error) {
	return append([]auth.Permission(nil), store.permissions...), nil
}

func (authorizationStore) IsIssuerAllowed(context.Context, auth.ResourceScope, string, bool) (bool, error) {
	return true, nil
}

type denialRecorder struct{ events []auth.DenialEvent }

func (recorder *denialRecorder) RecordDenial(_ context.Context, event auth.DenialEvent) error {
	recorder.events = append(recorder.events, event)
	return nil
}
