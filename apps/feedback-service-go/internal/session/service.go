package session

import (
	"context"
	"errors"
	"fmt"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type ListInput struct {
	ApplicationKey       string
	EnvironmentKey       string
	ExternalWorkspaceKey string
	Status               *string
	Limit                *int
	Cursor               *string
	RequestID            string
}

type MutationResult struct {
	Session Session
	Scope   auth.ResourceScope
}

// Store はsession use caseが必要とする永続化portである。
type Store interface {
	ResolveWorkspaceScope(context.Context, string, string, string, string) (auth.ResourceScope, error)
	ResolveResourceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	ListSessions(context.Context, auth.ResourceScope, *string, int, int) (Page, error)
	GetSession(context.Context, string) (Session, error)
	CreateSession(context.Context, auth.ResourceScope, auth.Principal, CreateCommand) (Session, error)
	PatchSession(context.Context, string, Patch) (Session, error)
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type Service struct {
	store        Store
	authorizer   *auth.Authorizer
	observeScope func(context.Context, auth.ResourceScope)
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func NewService(store Store, authorizer *auth.Authorizer, options ...Option) (*Service, error) {
	if store == nil || authorizer == nil {
		return nil, errors.New("session dependencyが未設定です")
	}
	service := &Service{store: store, authorizer: authorizer}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

func (service *Service) List(ctx context.Context, principal auth.Principal, input ListInput) (Page, error) {
	scope, err := service.resolveWorkspace(ctx, principal, input)
	if err != nil {
		return Page{}, err
	}
	if _, err := service.authorize(ctx, principal, scope, auth.PermissionRead, false, input.RequestID); err != nil {
		return Page{}, err
	}
	if input.Status != nil && !ValidStatus(*input.Status) {
		return Page{}, invalid("request.invalid", "status が不正です")
	}
	limit, err := NormalizeLimit(input.Limit)
	if err != nil {
		return Page{}, err
	}
	offset, err := DecodeCursor(input.Cursor)
	if err != nil {
		return Page{}, err
	}
	return service.store.ListSessions(ctx, scope, input.Status, limit, offset)
}

func (service *Service) Create(
	ctx context.Context,
	principal auth.Principal,
	requestID string,
	command CreateCommand,
) (MutationResult, error) {
	input := ListInput{
		ApplicationKey: command.Request.ApplicationKey, EnvironmentKey: command.Request.EnvironmentKey,
		ExternalWorkspaceKey: command.Request.ExternalWorkspaceKey, RequestID: requestID,
	}
	scope, err := service.resolveWorkspace(ctx, principal, input)
	if err != nil {
		return MutationResult{}, err
	}
	if _, err := service.authorize(ctx, principal, scope, auth.PermissionManage, false, requestID); err != nil {
		return MutationResult{}, err
	}
	if err := ValidateIdempotencyKey(command.IdempotencyKey); err != nil {
		return MutationResult{}, err
	}
	if err := ValidateRequestHash(command.RequestHash); err != nil {
		return MutationResult{}, err
	}
	saved, err := service.store.CreateSession(ctx, scope, principal, command)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Session: saved, Scope: scope}, nil
}

func (service *Service) Get(
	ctx context.Context,
	principal auth.Principal,
	sessionID string,
	requestID string,
) (Session, error) {
	canonicalID, err := ValidateUUID(sessionID, "sessionId")
	if err != nil {
		return Session{}, err
	}
	scope, err := service.store.ResolveResourceScope(ctx, principal.UserID, ResourceKindSession, canonicalID)
	if err != nil {
		return Session{}, err
	}
	service.notifyScope(ctx, scope)
	if _, err := service.authorize(ctx, principal, scope, auth.PermissionRead, true, requestID); err != nil {
		return Session{}, err
	}
	return service.store.GetSession(ctx, canonicalID)
}

// Patchはbody decodeを認可後まで遅延し、存在とpermissionの情報を入力errorより先に隠す。
func (service *Service) Patch(
	ctx context.Context,
	principal auth.Principal,
	sessionID string,
	requestID string,
	prepare func() (Patch, error),
) (MutationResult, error) {
	canonicalID, err := ValidateUUID(sessionID, "sessionId")
	if err != nil {
		return MutationResult{}, err
	}
	scope, err := service.store.ResolveResourceScope(ctx, principal.UserID, ResourceKindSession, canonicalID)
	if err != nil {
		return MutationResult{}, err
	}
	service.notifyScope(ctx, scope)
	if _, err := service.authorize(ctx, principal, scope, auth.PermissionManage, true, requestID); err != nil {
		return MutationResult{}, err
	}
	if prepare == nil {
		return MutationResult{}, errors.New("session patch decoderが未設定です")
	}
	patch, err := prepare()
	if err != nil {
		return MutationResult{}, err
	}
	saved, err := service.store.PatchSession(ctx, canonicalID, patch)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Session: saved, Scope: scope}, nil
}

func (service *Service) resolveWorkspace(
	ctx context.Context,
	principal auth.Principal,
	input ListInput,
) (auth.ResourceScope, error) {
	if err := ValidateApplicationKey(input.ApplicationKey); err != nil {
		return auth.ResourceScope{}, err
	}
	environmentKey, err := ValidateKey(input.EnvironmentKey, "environmentKey", 100)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	workspaceKey, err := ValidateKey(input.ExternalWorkspaceKey, "externalWorkspaceKey", 200)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	scope, err := service.store.ResolveWorkspaceScope(
		ctx, principal.UserID, input.ApplicationKey, workspaceKey, environmentKey,
	)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	service.notifyScope(ctx, scope)
	return scope, nil
}

func (service *Service) authorize(
	ctx context.Context,
	principal auth.Principal,
	scope auth.ResourceScope,
	permission auth.Permission,
	hideExistence bool,
	requestID string,
) (auth.AuthorizedContext, error) {
	authorized, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: permission,
		HideExistence: hideExistence, RequestID: requestID,
	})
	if err != nil {
		return auth.AuthorizedContext{}, err
	}
	if err := service.store.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(permission),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed", RequestID: requestID,
	}); err != nil {
		return auth.AuthorizedContext{}, fmt.Errorf("session認可監査を記録できません: %w", err)
	}
	return authorized, nil
}

func (service *Service) notifyScope(ctx context.Context, scope auth.ResourceScope) {
	if service.observeScope != nil {
		service.observeScope(ctx, scope)
	}
}
