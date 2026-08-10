package export

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type Store interface {
	ResolveWorkspaceScope(context.Context, string, string, string, string) (auth.ResourceScope, error)
	ResolveResourceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	CreateExport(context.Context, auth.ResourceScope, auth.Principal, CreateCommand) (Job, error)
	GetExport(context.Context, string) (Job, error)
	GetStoredExport(context.Context, string) (StoredMetadata, error)
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type Service struct {
	store        Store
	objects      objectstore.Store
	authorizer   *auth.Authorizer
	observeScope func(context.Context, auth.ResourceScope)
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func NewService(store Store, objects objectstore.Store, authorizer *auth.Authorizer, options ...Option) (*Service, error) {
	if store == nil || objects == nil || authorizer == nil {
		return nil, errors.New("export dependencyが未設定です")
	}
	service := &Service{store: store, objects: objects, authorizer: authorizer}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

func (service *Service) Create(
	ctx context.Context,
	principal auth.Principal,
	requestID string,
	command CreateCommand,
	beforeCreate func(auth.ResourceScope) error,
) (MutationResult, error) {
	request := command.Request
	environmentKey, workspaceKey, err := ValidateScopeKeys(
		request.ApplicationKey, request.EnvironmentKey, request.ExternalWorkspaceKey,
	)
	if err != nil {
		return MutationResult{}, err
	}
	scope, err := service.store.ResolveWorkspaceScope(
		ctx, principal.UserID, request.ApplicationKey, workspaceKey, environmentKey,
	)
	if err != nil {
		return MutationResult{}, err
	}
	service.notifyScope(ctx, scope)
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, false, requestID); err != nil {
		return MutationResult{}, err
	}
	if beforeCreate != nil {
		if err := beforeCreate(scope); err != nil {
			return MutationResult{}, err
		}
	}
	if err := ValidateIdempotencyKey(command.IdempotencyKey); err != nil {
		return MutationResult{}, err
	}
	if err := ValidateRequestHash(command.RequestHash); err != nil {
		return MutationResult{}, err
	}
	command.Request = request
	job, err := service.store.CreateExport(ctx, scope, principal, command)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Job: job, Scope: scope}, nil
}

func (service *Service) Get(
	ctx context.Context, principal auth.Principal, exportID, requestID string,
) (Job, error) {
	scope, canonicalID, err := service.resolve(ctx, principal, exportID)
	if err != nil {
		return Job{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, true, requestID); err != nil {
		return Job{}, err
	}
	return service.store.GetExport(ctx, canonicalID)
}

func (service *Service) Download(
	ctx context.Context, principal auth.Principal, exportID, requestID string,
) (Stored, auth.ResourceScope, error) {
	scope, canonicalID, err := service.resolve(ctx, principal, exportID)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, true, requestID); err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	metadata, err := service.store.GetStoredExport(ctx, canonicalID)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	object, err := service.objects.Get(ctx, metadata.ObjectKey)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, &Error{
			Kind: ErrStorageUnavailable, Code: "export.storage_unavailable", Detail: "export storage を読み取れません",
		}
	}
	if object.Body == nil || object.Size < 0 || object.Size == math.MaxInt64 {
		if object.Body != nil {
			_ = object.Body.Close()
		}
		return Stored{}, auth.ResourceScope{}, &Error{
			Kind: ErrStorageUnavailable, Code: "export.storage_unavailable", Detail: "export storage を読み取れません",
		}
	}
	contentType := "text/csv; charset=utf-8"
	if metadata.Format == FormatXLSX {
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	return Stored{
		FileName:    "feedback-" + canonicalID + "." + metadata.Format,
		ContentType: contentType, Size: object.Size, Body: object.Body,
	}, scope, nil
}

func (service *Service) resolve(
	ctx context.Context, principal auth.Principal, rawID string,
) (auth.ResourceScope, string, error) {
	canonicalID, err := canonicalUUID(rawID, "exportId")
	if err != nil {
		return auth.ResourceScope{}, "", err
	}
	scope, err := service.store.ResolveResourceScope(ctx, principal.UserID, "export", canonicalID)
	if err != nil {
		return auth.ResourceScope{}, "", err
	}
	service.notifyScope(ctx, scope)
	return scope, canonicalID, nil
}

func (service *Service) authorize(
	ctx context.Context,
	principal auth.Principal,
	scope auth.ResourceScope,
	permission auth.Permission,
	hideExistence bool,
	requestID string,
) error {
	_, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: permission,
		HideExistence: hideExistence, RequestID: requestID,
	})
	if err != nil {
		return err
	}
	if err := service.store.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(permission),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed", RequestID: requestID,
	}); err != nil {
		return fmt.Errorf("export認可監査を記録できません: %w", err)
	}
	return nil
}

func (service *Service) notifyScope(ctx context.Context, scope auth.ResourceScope) {
	if service.observeScope != nil {
		service.observeScope(ctx, scope)
	}
}
