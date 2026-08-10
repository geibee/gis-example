package admin

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func TestPatchMembershipDefersIfMatchAndBodyUntilAuthorization(t *testing.T) {
	t.Parallel()
	events := &eventLog{}
	store := &adminStoreFake{events: events, mutation: StoreMutation{
		Before: &Member{UserID: "76f50f83-85af-4639-bdda-bbbad32f6f56", Version: 2},
		After:  Member{UserID: "76f50f83-85af-4639-bdda-bbbad32f6f56", Version: 3},
	}}
	service, err := NewService(store, authorizerFake{events: events}, WithScopeObserver(func(context.Context, auth.ResourceScope) {
		events.add("observe")
	}))
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.PatchMembership(context.Background(), principalForAdminTest(), workspaceForAdminTest(),
		"76f50f83-85af-4639-bdda-bbbad32f6f56", func() (int, MembershipPatch, error) {
			events.add("prepare")
			return 2, MembershipPatch{Permissions: []auth.Permission{auth.PermissionRead}}, nil
		})
	if err != nil {
		t.Fatalf("PatchMembership() error = %v", err)
	}
	if result.Before == nil || result.After == nil || result.Before.Version != 2 || result.After.Version != 3 {
		t.Fatalf("mutation result = %#v", result)
	}
	want := []string{"resolve", "observe", "authorize", "audit", "prepare", "patch"}
	if got := events.values(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
}

func TestPatchMembershipDoesNotDecodeForDeniedScope(t *testing.T) {
	t.Parallel()
	events := &eventLog{}
	store := &adminStoreFake{events: events}
	service, err := NewService(store, authorizerFake{events: events, err: auth.ErrPermissionDenied})
	if err != nil {
		t.Fatal(err)
	}
	prepared := false
	_, err = service.PatchMembership(context.Background(), principalForAdminTest(), workspaceForAdminTest(),
		"76f50f83-85af-4639-bdda-bbbad32f6f56", func() (int, MembershipPatch, error) {
			prepared = true
			return 0, MembershipPatch{}, nil
		})
	if !errors.Is(err, auth.ErrPermissionDenied) {
		t.Fatalf("error = %v", err)
	}
	if prepared {
		t.Fatal("認可前にIf-Match/bodyを解析しました")
	}
	if got := events.values(); !reflect.DeepEqual(got, []string{"resolve", "authorize"}) {
		t.Fatalf("events = %#v", got)
	}
}

func TestDeleteMembershipDefersIfMatchUntilAllowedAudit(t *testing.T) {
	t.Parallel()
	events := &eventLog{}
	store := &adminStoreFake{events: events, deleted: Member{UserID: "76f50f83-85af-4639-bdda-bbbad32f6f56", Version: 4}}
	service, _ := NewService(store, authorizerFake{events: events})
	result, err := service.DeleteMembership(context.Background(), principalForAdminTest(), workspaceForAdminTest(),
		"76f50f83-85af-4639-bdda-bbbad32f6f56", func() (int, error) {
			events.add("prepare-version")
			return 4, nil
		})
	if err != nil || result.Before == nil || result.After != nil {
		t.Fatalf("result=%#v error=%v", result, err)
	}
	want := []string{"resolve", "authorize", "audit", "prepare-version", "delete"}
	if got := events.values(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
}

func TestMembershipValidationRejectsNegativeInputs(t *testing.T) {
	t.Parallel()
	tests := map[string]func() error{
		"empty permissions": func() error { _, err := validatePatch(MembershipPatch{}); return err },
		"duplicate permissions": func() error {
			_, err := validatePatch(MembershipPatch{Permissions: []auth.Permission{auth.PermissionRead, auth.PermissionRead}})
			return err
		},
		"unknown permission": func() error {
			_, err := validatePatch(MembershipPatch{Permissions: []auth.Permission{"feedback.root"}})
			return err
		},
		"invalid UUID":      func() error { _, err := validateUUID("../member", "userId"); return err },
		"invalid version":   func() error { return validateExpectedVersion(0) },
		"short idempotency": func() error { return validateIdempotency("short", string(make([]byte, 64))) },
		"invalid workspace": func() error {
			_, err := validateWorkspace(WorkspaceInput{ApplicationKey: "UPPER", ExternalWorkspaceKey: "workspace"})
			return err
		},
	}
	for name, run := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := run(); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestMemberJSONKeepsNullableFields(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(Member{Permissions: []auth.Permission{auth.PermissionRead}, Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"email", "displayName"} {
		fieldValue, exists := value[field]
		if !exists || fieldValue != nil {
			t.Fatalf("%s = %#v, exists=%t", field, fieldValue, exists)
		}
	}
}

type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (log *eventLog) add(value string) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.events = append(log.events, value)
}

func (log *eventLog) values() []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return append([]string(nil), log.events...)
}

type adminStoreFake struct {
	events   *eventLog
	mutation StoreMutation
	deleted  Member
}

func (store *adminStoreFake) ResolveAdminWorkspaceScope(context.Context, string, string, string) (auth.ResourceScope, error) {
	store.events.add("resolve")
	return adminTestScope(), nil
}

func (store *adminStoreFake) ListWorkspaceMembers(context.Context, auth.ResourceScope) ([]Member, error) {
	store.events.add("list")
	return []Member{}, nil
}

func (store *adminStoreFake) CreateWorkspaceMember(context.Context, auth.ResourceScope, auth.Principal, CreateCommand) (StoreMutation, error) {
	store.events.add("create")
	return store.mutation, nil
}

func (store *adminStoreFake) PatchWorkspaceMember(context.Context, auth.ResourceScope, string, int, MembershipPatch) (StoreMutation, error) {
	store.events.add("patch")
	return store.mutation, nil
}

func (store *adminStoreFake) DeleteWorkspaceMember(context.Context, auth.ResourceScope, string, int) (Member, error) {
	store.events.add("delete")
	return store.deleted, nil
}

func (store *adminStoreFake) RecordAudit(context.Context, usecase.AuditEvent) error {
	store.events.add("audit")
	return nil
}

type authorizerFake struct {
	events *eventLog
	err    error
}

func (authorizer authorizerFake) Authorize(context.Context, auth.AuthorizationRequest) (auth.AuthorizedContext, error) {
	authorizer.events.add("authorize")
	return auth.AuthorizedContext{}, authorizer.err
}

func principalForAdminTest() auth.Principal {
	return auth.Principal{UserID: "a15624c1-8622-4c88-a837-af5b0fccf5bb", Subject: "owner"}
}

func workspaceForAdminTest() WorkspaceInput {
	return WorkspaceInput{ApplicationKey: "web-gis", ExternalWorkspaceKey: "workspace", RequestID: "request-id"}
}

func adminTestScope() auth.ResourceScope {
	return auth.ResourceScope{
		TenantID: "tenant", ApplicationID: "application", WorkspaceID: "workspace",
		ApplicationKey: "web-gis", ExternalWorkspaceKey: "workspace",
	}
}
