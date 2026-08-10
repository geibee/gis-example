package retention

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestPatchPolicyPreservesAuthorizationOrder(t *testing.T) {
	t.Parallel()
	store := &serviceStoreFake{}
	authorizer, err := auth.NewAuthorizer(store, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	days := 30
	result, err := service.PatchPolicy(context.Background(), auth.Principal{
		UserID: "user", Issuer: "issuer", Subject: "subject",
	}, WorkspaceInput{
		ApplicationKey: "app", ExternalWorkspaceKey: "workspace", RequestID: "request",
	}, func() (Policy, int, error) {
		store.events = append(store.events, "prepare")
		return Policy{EvidenceRetentionDays: &days, ExportRetentionDays: 14}, 1, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != 2 || result.Policy.ExportRetentionDays != 14 {
		t.Fatalf("result = %+v", result)
	}
	want := []string{"resolve", "permissions", "issuer", "allowed-audit", "prepare", "patch"}
	if !reflect.DeepEqual(store.events, want) {
		t.Fatalf("events = %v, want %v", store.events, want)
	}
}

func TestPatchPolicyRejectsInvalidValueAfterAuthorization(t *testing.T) {
	t.Parallel()
	store := &serviceStoreFake{}
	authorizer, err := auth.NewAuthorizer(store, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, authorizer)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.PatchPolicy(context.Background(), auth.Principal{
		UserID: "user", Issuer: "issuer", Subject: "subject",
	}, WorkspaceInput{ApplicationKey: "app", ExternalWorkspaceKey: "workspace"}, func() (Policy, int, error) {
		store.events = append(store.events, "prepare")
		return Policy{ExportRetentionDays: 0}, 1, nil
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("error = %v, want ErrInvalid", err)
	}
	if reflect.DeepEqual(store.events, []string{"resolve", "permissions", "issuer", "allowed-audit", "prepare", "patch"}) {
		t.Fatal("不正なpolicyがstoreへ渡されました")
	}
}

type serviceStoreFake struct{ events []string }

func (store *serviceStoreFake) ResolveRetentionWorkspaceScope(
	_ context.Context, _, applicationKey, workspaceKey string,
) (auth.ResourceScope, error) {
	store.events = append(store.events, "resolve")
	return auth.ResourceScope{
		TenantID: "tenant", ApplicationID: "application", WorkspaceID: "workspace-id",
		ApplicationKey: applicationKey, ExternalWorkspaceKey: workspaceKey,
	}, nil
}

func (store *serviceStoreFake) GetRetentionPolicy(context.Context, auth.ResourceScope) (Policy, int, error) {
	return DefaultPolicy(), 1, nil
}

func (store *serviceStoreFake) PatchRetentionPolicy(
	_ context.Context, _ auth.ResourceScope, _ int, policy Policy,
) (Policy, int, error) {
	store.events = append(store.events, "patch")
	return policy, 2, nil
}

func (store *serviceStoreFake) RecordAudit(context.Context, usecase.AuditEvent) error {
	store.events = append(store.events, "allowed-audit")
	return nil
}

func (store *serviceStoreFake) ApplicationPermissions(context.Context, string, string) ([]auth.Permission, error) {
	return nil, nil
}

func (store *serviceStoreFake) WorkspacePermissions(context.Context, string, string) ([]auth.Permission, error) {
	store.events = append(store.events, "permissions")
	return []auth.Permission{auth.PermissionManage}, nil
}

func (store *serviceStoreFake) IsIssuerAllowed(context.Context, auth.ResourceScope, string, bool) (bool, error) {
	store.events = append(store.events, "issuer")
	return true, nil
}

func (store *serviceStoreFake) RecordDenial(context.Context, auth.DenialEvent) error { return nil }
