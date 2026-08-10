package admin

import (
	"context"
	"errors"
	"fmt"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type Service struct {
	store        Store
	authorizer   Authorizer
	observeScope func(context.Context, auth.ResourceScope)
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func NewService(store Store, authorizer Authorizer, options ...Option) (*Service, error) {
	if store == nil || authorizer == nil {
		return nil, errors.New("admin dependencyが未設定です")
	}
	service := &Service{store: store, authorizer: authorizer, observeScope: func(context.Context, auth.ResourceScope) {}}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	if service.observeScope == nil {
		return nil, errors.New("admin scope observerが不正です")
	}
	return service, nil
}

func (service *Service) ListMemberships(
	ctx context.Context,
	principal auth.Principal,
	input WorkspaceInput,
) ([]Member, error) {
	scope, err := service.resolveAndAuthorize(ctx, principal, input)
	if err != nil {
		return nil, err
	}
	return service.store.ListWorkspaceMembers(ctx, scope)
}

// CreateMembershipはbody decodeを認可後に行えるようprepare closureを受け取る。
func (service *Service) CreateMembership(
	ctx context.Context,
	principal auth.Principal,
	workspace WorkspaceInput,
	prepare func() (CreateCommand, error),
) (MutationResult, error) {
	scope, err := service.resolveAndAuthorize(ctx, principal, workspace)
	if err != nil {
		return MutationResult{}, err
	}
	if prepare == nil {
		return MutationResult{}, errors.New("membership create decoderが未設定です")
	}
	command, err := prepare()
	if err != nil {
		return MutationResult{}, err
	}
	command.Workspace = workspace
	command.Request, err = validateCreate(command.Request)
	if err != nil {
		return MutationResult{}, err
	}
	if err := validateIdempotency(command.IdempotencyKey, command.RequestHash); err != nil {
		return MutationResult{}, err
	}
	mutation, err := service.store.CreateWorkspaceMember(ctx, scope, principal, command)
	if err != nil {
		return MutationResult{}, err
	}
	after := mutation.After
	return MutationResult{Before: mutation.Before, After: &after, Scope: scope, Replayed: mutation.Replayed}, nil
}

func (service *Service) PatchMembership(
	ctx context.Context,
	principal auth.Principal,
	workspace WorkspaceInput,
	userID string,
	prepare func() (int, MembershipPatch, error),
) (MutationResult, error) {
	canonicalID, err := validateUUID(userID, "userId")
	if err != nil {
		return MutationResult{}, err
	}
	scope, err := service.resolveAndAuthorize(ctx, principal, workspace)
	if err != nil {
		return MutationResult{}, err
	}
	if prepare == nil {
		return MutationResult{}, errors.New("membership patch decoderが未設定です")
	}
	expectedVersion, patch, err := prepare()
	if err != nil {
		return MutationResult{}, err
	}
	if err := validateExpectedVersion(expectedVersion); err != nil {
		return MutationResult{}, err
	}
	patch, err = validatePatch(patch)
	if err != nil {
		return MutationResult{}, err
	}
	mutation, err := service.store.PatchWorkspaceMember(ctx, scope, canonicalID, expectedVersion, patch)
	if err != nil {
		return MutationResult{}, err
	}
	after := mutation.After
	return MutationResult{Before: mutation.Before, After: &after, Scope: scope}, nil
}

func (service *Service) DeleteMembership(
	ctx context.Context,
	principal auth.Principal,
	workspace WorkspaceInput,
	userID string,
	prepareVersion func() (int, error),
) (MutationResult, error) {
	canonicalID, err := validateUUID(userID, "userId")
	if err != nil {
		return MutationResult{}, err
	}
	scope, err := service.resolveAndAuthorize(ctx, principal, workspace)
	if err != nil {
		return MutationResult{}, err
	}
	if prepareVersion == nil {
		return MutationResult{}, errors.New("membership delete If-Match parserが未設定です")
	}
	expectedVersion, err := prepareVersion()
	if err != nil {
		return MutationResult{}, err
	}
	if err := validateExpectedVersion(expectedVersion); err != nil {
		return MutationResult{}, err
	}
	before, err := service.store.DeleteWorkspaceMember(ctx, scope, canonicalID, expectedVersion)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Before: &before, Scope: scope}, nil
}

func (service *Service) resolveAndAuthorize(
	ctx context.Context,
	principal auth.Principal,
	input WorkspaceInput,
) (auth.ResourceScope, error) {
	validated, err := validateWorkspace(input)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	scope, err := service.store.ResolveAdminWorkspaceScope(
		ctx, principal.UserID, validated.ApplicationKey, validated.ExternalWorkspaceKey,
	)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	service.observeScope(ctx, scope)
	if _, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: auth.PermissionAdmin, RequestID: input.RequestID,
	}); err != nil {
		return auth.ResourceScope{}, err
	}
	if err := service.store.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(auth.PermissionAdmin),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed", RequestID: input.RequestID,
	}); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("membership認可監査を記録できません: %w", err)
	}
	return scope, nil
}
