package retention

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

var applicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

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
		return nil, errors.New("retention dependencyが未設定です")
	}
	service := &Service{store: store, authorizer: authorizer}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

func (service *Service) GetPolicy(
	ctx context.Context, principal auth.Principal, input WorkspaceInput,
) (PolicyResult, error) {
	scope, err := service.resolveAndAuthorize(ctx, principal, input)
	if err != nil {
		return PolicyResult{}, err
	}
	policy, version, err := service.store.GetRetentionPolicy(ctx, scope)
	return PolicyResult{Policy: policy, Version: version, Scope: scope}, err
}

func (service *Service) PatchPolicy(
	ctx context.Context,
	principal auth.Principal,
	input WorkspaceInput,
	prepare func() (Policy, int, error),
) (PolicyResult, error) {
	scope, err := service.resolveAndAuthorize(ctx, principal, input)
	if err != nil {
		return PolicyResult{}, err
	}
	if prepare == nil {
		return PolicyResult{}, errors.New("retention policy decoderが未設定です")
	}
	policy, expectedVersion, err := prepare()
	if err != nil {
		return PolicyResult{}, err
	}
	if err := ValidatePolicy(policy); err != nil {
		return PolicyResult{}, err
	}
	policy, version, err := service.store.PatchRetentionPolicy(ctx, scope, expectedVersion, policy)
	return PolicyResult{Policy: policy, Version: version, Scope: scope}, err
}

func ValidatePolicy(policy Policy) error {
	if policy.EvidenceRetentionDays != nil &&
		(*policy.EvidenceRetentionDays < 1 || *policy.EvidenceRetentionDays > 3650) {
		return invalid("evidenceRetentionDays が範囲外です")
	}
	if policy.ExportRetentionDays < 1 || policy.ExportRetentionDays > 365 {
		return invalid("exportRetentionDays が範囲外です")
	}
	return nil
}

func (service *Service) resolveAndAuthorize(
	ctx context.Context, principal auth.Principal, input WorkspaceInput,
) (auth.ResourceScope, error) {
	if !applicationKeyPattern.MatchString(input.ApplicationKey) {
		return auth.ResourceScope{}, invalid("applicationKey が不正です")
	}
	workspace := strings.TrimSpace(input.ExternalWorkspaceKey)
	if workspace == "" || len(utf16.Encode([]rune(workspace))) > 200 {
		return auth.ResourceScope{}, invalid("workspace scope が不正です")
	}
	scope, err := service.store.ResolveRetentionWorkspaceScope(
		ctx, principal.UserID, input.ApplicationKey, workspace,
	)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	if service.observeScope != nil {
		service.observeScope(ctx, scope)
	}
	if _, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: auth.PermissionManage,
		RequestID: input.RequestID,
	}); err != nil {
		return auth.ResourceScope{}, err
	}
	if err := service.store.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(auth.PermissionManage),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID,
		Outcome: "allowed", RequestID: input.RequestID,
	}); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("retention認可監査を記録できません: %w", err)
	}
	return scope, nil
}

func invalid(detail string) error {
	return &Error{Kind: ErrInvalid, Code: "request.invalid", Detail: detail}
}
