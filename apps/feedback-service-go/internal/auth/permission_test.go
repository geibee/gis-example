package auth

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestPermissionMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		granted []Permission
		allowed []Permission
	}{
		{name: "permissionなし", granted: nil, allowed: nil},
		{name: "read", granted: []Permission{PermissionRead}, allowed: []Permission{PermissionRead}},
		{
			name:    "comment",
			granted: []Permission{PermissionComment},
			allowed: []Permission{PermissionRead, PermissionComment},
		},
		{
			name:    "manage",
			granted: []Permission{PermissionManage},
			allowed: []Permission{PermissionRead, PermissionComment, PermissionManage},
		},
		{name: "admin", granted: []Permission{PermissionAdmin}, allowed: Permissions()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var actual []Permission
			for _, permission := range Permissions() {
				if Allows(test.granted, permission) {
					actual = append(actual, permission)
				}
			}
			if !reflect.DeepEqual(actual, test.allowed) {
				t.Fatalf("allowed=%v; want %v", actual, test.allowed)
			}
		})
	}
}

func TestTokenScopeNarrowsDatabasePermissions(t *testing.T) {
	t.Parallel()

	token := TokenScope{
		TenantKey:            "tenant-a",
		ApplicationKey:       "app-a",
		EnvironmentKey:       "prod",
		ExternalWorkspaceKey: "workspace-a",
		Permissions:          []Permission{PermissionComment},
	}
	scope := ResourceScope{
		TenantID:             "tenant-id-a",
		TenantKey:            "tenant-a",
		ApplicationID:        "app-id-a",
		EnvironmentID:        "env-id-a",
		WorkspaceID:          "workspace-id-a",
		ApplicationKey:       "app-a",
		EnvironmentKey:       "prod",
		ExternalWorkspaceKey: "workspace-a",
	}
	if !token.Matches(scope, false) {
		t.Fatal("一致するworkspace scopeが拒否されました")
	}
	if token.Matches(withWorkspace(scope, "workspace-b"), false) {
		t.Fatal("別workspace scopeが許可されました")
	}
	if token.Matches(withEnvironment(scope, "staging"), false) {
		t.Fatal("別environment scopeが許可されました")
	}
	if !token.Matches(withWorkspace(scope, "workspace-b"), true) {
		t.Fatal("application-onlyではworkspaceを比較しません")
	}
	effective := IntersectPermissions([]Permission{PermissionAdmin}, token.Permissions)
	want := []Permission{PermissionRead, PermissionComment}
	if !reflect.DeepEqual(effective, want) {
		t.Fatalf("effective=%v; want %v", effective, want)
	}
}

func TestRestrictMemberships(t *testing.T) {
	t.Parallel()

	memberships := []Membership{
		{
			ApplicationKey:       "app-a",
			ExternalWorkspaceKey: "workspace-a",
			Permissions:          []Permission{PermissionAdmin},
		},
		{
			ApplicationKey:       "app-a",
			ExternalWorkspaceKey: "workspace-b",
			Permissions:          []Permission{PermissionRead},
		},
	}
	principal := Principal{TokenScope: &TokenScope{
		ApplicationKey:       "app-a",
		ExternalWorkspaceKey: "workspace-a",
		Permissions:          []Permission{PermissionManage},
	}}
	actual := RestrictMemberships(principal, memberships)
	want := []Membership{{
		ApplicationKey:       "app-a",
		ExternalWorkspaceKey: "workspace-a",
		Permissions:          []Permission{PermissionComment, PermissionManage, PermissionRead},
	}}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("memberships=%+v; want %+v", actual, want)
	}
	if !reflect.DeepEqual(memberships[0].Permissions, []Permission{PermissionAdmin}) {
		t.Fatal("入力membershipを変更してはいけません")
	}
}

func TestParsePermissions(t *testing.T) {
	t.Parallel()

	permissions, err := ParsePermissions([]string{"feedback.manage", "feedback.read", "feedback.manage"})
	if err != nil {
		t.Fatalf("permissionを解析できませんでした: %v", err)
	}
	if !reflect.DeepEqual(permissions, []Permission{PermissionRead, PermissionManage}) {
		t.Fatalf("permissions=%v", permissions)
	}
	for _, values := range [][]string{nil, {}, {"feedback.owner"}} {
		if _, err := ParsePermissions(values); !errors.Is(err, ErrInvalidPermission) {
			t.Fatalf("values=%v error=%v", values, err)
		}
	}
}

func TestAuthorizeBoundaries(t *testing.T) {
	t.Parallel()

	baseScope := ResourceScope{
		TenantKey:            "tenant-a",
		ApplicationID:        "application-id",
		ApplicationKey:       "app-a",
		EnvironmentID:        "environment-id",
		EnvironmentKey:       "prod",
		WorkspaceID:          "workspace-id",
		ExternalWorkspaceKey: "workspace-a",
	}
	tests := []struct {
		name            string
		store           authorizationStoreStub
		principal       Principal
		required        Permission
		applicationOnly bool
		hideExistence   bool
		wantAllowed     bool
		wantAudit       bool
	}{
		{
			name:        "DB adminはmanageを許可",
			store:       authorizationStoreStub{permissions: []Permission{PermissionAdmin}, issuerAllowed: true},
			principal:   Principal{UserID: "user-id", Issuer: "https://issuer.example", Subject: "subject"},
			required:    PermissionManage,
			wantAllowed: true,
		},
		{
			name:      "DB permission不足",
			store:     authorizationStoreStub{permissions: []Permission{PermissionRead}, issuerAllowed: true},
			principal: Principal{UserID: "user-id", Issuer: "https://issuer.example", Subject: "subject"},
			required:  PermissionComment,
			wantAudit: true,
		},
		{
			name:      "issuer拒否",
			store:     authorizationStoreStub{permissions: []Permission{PermissionAdmin}, issuerAllowed: false},
			principal: Principal{UserID: "user-id", Issuer: "https://other.example", Subject: "subject"},
			required:  PermissionRead,
			wantAudit: true,
		},
		{
			name:  "exchange permissionで縮小",
			store: authorizationStoreStub{permissions: []Permission{PermissionAdmin}, issuerAllowed: true},
			principal: Principal{
				UserID:  "user-id",
				Issuer:  "https://issuer.example",
				Subject: "subject",
				TokenScope: &TokenScope{
					TenantKey:            "tenant-a",
					ApplicationKey:       "app-a",
					EnvironmentKey:       "prod",
					ExternalWorkspaceKey: "workspace-a",
					Permissions:          []Permission{PermissionComment},
				},
			},
			required:  PermissionManage,
			wantAudit: true,
		},
		{
			name:  "exchange workspace不一致",
			store: authorizationStoreStub{permissions: []Permission{PermissionAdmin}, issuerAllowed: true},
			principal: Principal{
				UserID:  "user-id",
				Issuer:  "https://issuer.example",
				Subject: "subject",
				TokenScope: &TokenScope{
					TenantKey:            "tenant-a",
					ApplicationKey:       "app-a",
					EnvironmentKey:       "prod",
					ExternalWorkspaceKey: "workspace-b",
					Permissions:          []Permission{PermissionAdmin},
				},
			},
			required:      PermissionRead,
			hideExistence: true,
			wantAudit:     true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			auditor := &denialAuditorStub{}
			authorizer, err := NewAuthorizer(&test.store, auditor)
			if err != nil {
				t.Fatalf("authorizerを作成できませんでした: %v", err)
			}
			result, err := authorizer.Authorize(context.Background(), AuthorizationRequest{
				Principal:       test.principal,
				Scope:           baseScope,
				Required:        test.required,
				ApplicationOnly: test.applicationOnly,
				HideExistence:   test.hideExistence,
				RequestID:       "request-id",
			})
			if test.wantAllowed {
				if err != nil {
					t.Fatalf("認可されませんでした: %v", err)
				}
				if !Allows(result.Permissions, test.required) {
					t.Fatalf("effective permission=%v", result.Permissions)
				}
			} else {
				if !errors.Is(err, ErrPermissionDenied) {
					t.Fatalf("error=%v", err)
				}
				var authorizationError *AuthorizationError
				if !errors.As(err, &authorizationError) || authorizationError.HideExistence != test.hideExistence {
					t.Fatalf("hide existenceが不一致です: %v", err)
				}
			}
			if (len(auditor.events) > 0) != test.wantAudit {
				t.Fatalf("audit events=%+v", auditor.events)
			}
		})
	}
}

func TestAuthorizeFailsClosedWhenDenialAuditFails(t *testing.T) {
	t.Parallel()

	store := &authorizationStoreStub{permissions: nil, issuerAllowed: true}
	auditor := &denialAuditorStub{err: errors.New("database unavailable")}
	authorizer, err := NewAuthorizer(store, auditor)
	if err != nil {
		t.Fatalf("authorizerを作成できませんでした: %v", err)
	}
	_, err = authorizer.Authorize(context.Background(), AuthorizationRequest{
		Principal: Principal{UserID: "user-id", Subject: "subject"},
		Scope: ResourceScope{
			ApplicationID: "app-id",
			WorkspaceID:   "workspace-id",
		},
		Required:  PermissionRead,
		RequestID: "request-id",
	})
	if !errors.Is(err, ErrAuditUnavailable) {
		t.Fatalf("error=%v", err)
	}
}

type authorizationStoreStub struct {
	permissions   []Permission
	issuerAllowed bool
	err           error
}

func (store *authorizationStoreStub) ApplicationPermissions(context.Context, string, string) ([]Permission, error) {
	return store.permissions, store.err
}

func (store *authorizationStoreStub) WorkspacePermissions(context.Context, string, string) ([]Permission, error) {
	return store.permissions, store.err
}

func (store *authorizationStoreStub) IsIssuerAllowed(context.Context, ResourceScope, string, bool) (bool, error) {
	return store.issuerAllowed, store.err
}

type denialAuditorStub struct {
	events []DenialEvent
	err    error
}

func (auditor *denialAuditorStub) RecordDenial(_ context.Context, event DenialEvent) error {
	auditor.events = append(auditor.events, event)
	return auditor.err
}

func withWorkspace(scope ResourceScope, workspace string) ResourceScope {
	scope.ExternalWorkspaceKey = workspace
	return scope
}

func withEnvironment(scope ResourceScope, environment string) ResourceScope {
	scope.EnvironmentKey = environment
	return scope
}
