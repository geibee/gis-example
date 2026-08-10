package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

func TestCapabilitiesMatchesFrozenValuesAndFailsClosed(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	service := newTestService(t, store)
	value, err := service.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantFeatures := []string{
		"application-manifest", "idempotency", "etag", "message-history", "private-evidence",
		"rate-limit", "notification-outbox", "automatic-backup", "notification-connectors",
	}
	if value.APIVersion != "1.0" || value.APIMajorVersion != 1 ||
		value.Evidence.MaxBytes != 1024 || value.Evidence.MaxCountPerWorkspace != 20 ||
		!reflect.DeepEqual(value.Features, wantFeatures) {
		t.Fatalf("capabilities = %+v", value)
	}
	store.pingErr = errors.New("database down")
	if _, err := service.Capabilities(context.Background()); !errors.Is(err, ErrDatabaseUnavailable) {
		t.Fatalf("Capabilities() error = %v", err)
	}
}

func TestMeRestrictsExchangeMemberships(t *testing.T) {
	t.Parallel()
	store := &fakeStore{memberships: []auth.Membership{
		{ApplicationKey: "app", ExternalWorkspaceKey: "workspace", Permissions: []auth.Permission{auth.PermissionAdmin}},
		{ApplicationKey: "other", ExternalWorkspaceKey: "workspace", Permissions: []auth.Permission{auth.PermissionAdmin}},
	}}
	service := newTestService(t, store)
	principal := auth.Principal{
		UserID: "user-id", Subject: "subject",
		TokenScope: &auth.TokenScope{
			ApplicationKey: "app", ExternalWorkspaceKey: "workspace",
			Permissions: []auth.Permission{auth.PermissionComment},
		},
	}
	value, err := service.Me(context.Background(), principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(value.Memberships) != 1 || !reflect.DeepEqual(
		value.Memberships[0].Permissions,
		[]auth.Permission{auth.PermissionComment, auth.PermissionRead},
	) {
		t.Fatalf("memberships = %+v", value.Memberships)
	}
}

func TestPutManifestDoesNotDecodeBeforeAuthorization(t *testing.T) {
	t.Parallel()
	store := &fakeStore{
		scope: auth.ResourceScope{
			TenantID: "tenant-id", TenantKey: "tenant", ApplicationID: "application-id", ApplicationKey: "app",
		},
		applicationPermissions: []auth.Permission{auth.PermissionRead},
		issuerAllowed:          true,
	}
	service := newTestService(t, store)
	prepared := false
	_, err := service.PutManifest(
		context.Background(),
		auth.Principal{UserID: "user-id", Subject: "subject", Issuer: "https://issuer.example"},
		"app",
		"request-id",
		func() (json.RawMessage, string, *int, error) {
			prepared = true
			return json.RawMessage(`{}`), "v1", nil, nil
		},
	)
	var authorizationError *auth.AuthorizationError
	if !errors.As(err, &authorizationError) || !authorizationError.HideExistence {
		t.Fatalf("PutManifest() error = %v", err)
	}
	if prepared {
		t.Fatal("認可拒否前にmanifest bodyをdecodeしました")
	}
	if len(store.denials) != 1 || store.denials[0].RequestID != "request-id" {
		t.Fatalf("denials = %+v", store.denials)
	}
}

func TestPutManifestRecordsAllowedThenSucceeded(t *testing.T) {
	t.Parallel()
	store := &fakeStore{
		scope: auth.ResourceScope{
			TenantID: "tenant-id", TenantKey: "tenant", ApplicationID: "application-id", ApplicationKey: "app",
		},
		applicationPermissions: []auth.Permission{auth.PermissionAdmin},
		issuerAllowed:          true,
		putRecord:              ManifestRecord{Manifest: json.RawMessage(`{"schemaVersion":"1"}`), Version: 2},
	}
	service := newTestService(t, store)
	version := 1
	record, err := service.PutManifest(
		context.Background(),
		auth.Principal{UserID: "user-id", Subject: "subject", Issuer: "https://issuer.example"},
		"app",
		"request-id",
		func() (json.RawMessage, string, *int, error) {
			return json.RawMessage(`{"schemaVersion":"1"}`), "v2", &version, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if record.Version != 2 || store.put.ManifestVersion != "v2" || store.put.ExpectedVersion == nil || *store.put.ExpectedVersion != 1 {
		t.Fatalf("record=%+v put=%+v", record, store.put)
	}
	if len(store.audits) != 2 || store.audits[0].Outcome != "allowed" || store.audits[1].Outcome != "succeeded" {
		t.Fatalf("audits = %+v", store.audits)
	}
}

func newTestService(t *testing.T, store *fakeStore) *Service {
	t.Helper()
	authorizer, err := auth.NewAuthorizer(store, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, authorizer, 1024, 20)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type fakeStore struct {
	pingErr                error
	memberships            []auth.Membership
	scope                  auth.ResourceScope
	resolveErr             error
	applicationPermissions []auth.Permission
	workspacePermissions   []auth.Permission
	issuerAllowed          bool
	denials                []auth.DenialEvent
	audits                 []AuditEvent
	put                    ManifestPut
	putRecord              ManifestRecord
}

func (store *fakeStore) Ping(context.Context) error { return store.pingErr }

func (store *fakeStore) ListMemberships(context.Context, string) ([]auth.Membership, error) {
	return store.memberships, nil
}

func (store *fakeStore) ResolveApplicationScope(context.Context, string, string) (auth.ResourceScope, error) {
	return store.scope, store.resolveErr
}

func (store *fakeStore) ResolveWorkspaceScope(context.Context, string, string, string, string) (auth.ResourceScope, error) {
	return store.scope, store.resolveErr
}

func (store *fakeStore) GetManifest(context.Context, string) (ManifestRecord, error) {
	return ManifestRecord{Manifest: json.RawMessage(`{"schemaVersion":"1"}`), Version: 1}, nil
}

func (store *fakeStore) PutManifest(_ context.Context, input ManifestPut) (ManifestRecord, error) {
	store.put = input
	return store.putRecord, nil
}

func (store *fakeStore) ReviewContext(
	context.Context,
	auth.ResourceScope,
	string,
	string,
	[]auth.Permission,
	int64,
) (ReviewContext, error) {
	return ReviewContext{}, nil
}

func (store *fakeStore) RecordAudit(_ context.Context, event AuditEvent) error {
	store.audits = append(store.audits, event)
	return nil
}

func (store *fakeStore) ApplicationPermissions(context.Context, string, string) ([]auth.Permission, error) {
	return store.applicationPermissions, nil
}

func (store *fakeStore) WorkspacePermissions(context.Context, string, string) ([]auth.Permission, error) {
	return store.workspacePermissions, nil
}

func (store *fakeStore) IsIssuerAllowed(context.Context, auth.ResourceScope, string, bool) (bool, error) {
	return store.issuerAllowed, nil
}

func (store *fakeStore) RecordDenial(_ context.Context, event auth.DenialEvent) error {
	store.denials = append(store.denials, event)
	return nil
}
