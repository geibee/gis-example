package backup

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type WorkspaceInput struct {
	ApplicationKey       string
	ExternalWorkspaceKey string
	RequestID            string
}

type ListInput struct {
	WorkspaceInput
	Limit  *int
	Cursor *string
}

type PolicyResult struct {
	View    PolicyView
	Version int
	Scope   auth.ResourceScope
}

type Store interface {
	ResolveBackupWorkspaceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	ResolveResourceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	GetBackupPolicyView(context.Context, auth.ResourceScope, time.Time) (PolicyView, int, error)
	PatchBackupPolicy(context.Context, auth.ResourceScope, int, Policy) (Policy, int, error)
	ListBackups(context.Context, auth.ResourceScope, int, int) (Page, error)
	GetBackup(context.Context, string) (Run, error)
	GetStoredBackup(context.Context, string) (StoredMetadata, error)
	RetryBackup(context.Context, auth.ResourceScope, string) (Run, error)
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type Service struct {
	store        Store
	objects      objectstore.Store
	authorizer   *auth.Authorizer
	observeScope func(context.Context, auth.ResourceScope)
	now          func() time.Time
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func WithClock(now func() time.Time) Option { return func(service *Service) { service.now = now } }

func NewService(store Store, objects objectstore.Store, authorizer *auth.Authorizer, options ...Option) (*Service, error) {
	if store == nil || objects == nil || authorizer == nil {
		return nil, errors.New("backup dependencyが未設定です")
	}
	service := &Service{store: store, objects: objects, authorizer: authorizer, now: time.Now}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	if service.now == nil {
		return nil, errors.New("backup clockが未設定です")
	}
	return service, nil
}

func (service *Service) GetPolicy(ctx context.Context, principal auth.Principal, input WorkspaceInput) (PolicyResult, error) {
	scope, err := service.resolveWorkspace(ctx, principal, input)
	if err != nil {
		return PolicyResult{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionAdmin, false, input.RequestID); err != nil {
		return PolicyResult{}, err
	}
	view, version, err := service.store.GetBackupPolicyView(ctx, scope, service.now())
	return PolicyResult{View: view, Version: version, Scope: scope}, err
}

func (service *Service) PatchPolicy(
	ctx context.Context,
	principal auth.Principal,
	input WorkspaceInput,
	prepare func() (Policy, int, error),
) (PolicyResult, error) {
	scope, err := service.resolveWorkspace(ctx, principal, input)
	if err != nil {
		return PolicyResult{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionAdmin, false, input.RequestID); err != nil {
		return PolicyResult{}, err
	}
	if prepare == nil {
		return PolicyResult{}, errors.New("backup policy decoderが未設定です")
	}
	policy, expectedVersion, err := prepare()
	if err != nil {
		return PolicyResult{}, err
	}
	if err := ValidatePolicy(policy); err != nil {
		return PolicyResult{}, err
	}
	if _, _, err := service.store.PatchBackupPolicy(ctx, scope, expectedVersion, policy); err != nil {
		return PolicyResult{}, err
	}
	view, version, err := service.store.GetBackupPolicyView(ctx, scope, service.now())
	return PolicyResult{View: view, Version: version, Scope: scope}, err
}

func (service *Service) List(ctx context.Context, principal auth.Principal, input ListInput) (Page, error) {
	scope, err := service.resolveWorkspace(ctx, principal, input.WorkspaceInput)
	if err != nil {
		return Page{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, false, input.RequestID); err != nil {
		return Page{}, err
	}
	limit, err := normalizeLimit(input.Limit)
	if err != nil {
		return Page{}, err
	}
	offset, err := decodeCursor(input.Cursor)
	if err != nil {
		return Page{}, err
	}
	return service.store.ListBackups(ctx, scope, limit, offset)
}

func (service *Service) Get(ctx context.Context, principal auth.Principal, backupID, requestID string) (Run, error) {
	scope, id, err := service.resolveResource(ctx, principal, backupID)
	if err != nil {
		return Run{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, true, requestID); err != nil {
		return Run{}, err
	}
	return service.store.GetBackup(ctx, id)
}

func (service *Service) Download(
	ctx context.Context, principal auth.Principal, backupID, requestID string,
) (Stored, auth.ResourceScope, error) {
	scope, id, err := service.resolveResource(ctx, principal, backupID)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionManage, true, requestID); err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	metadata, err := service.store.GetStoredBackup(ctx, id)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	object, err := service.objects.Get(ctx, metadata.ObjectKey)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, &Error{
			Kind: ErrStorageUnavailable, Code: "backup.storage_unavailable", Detail: "backup storage を読み取れません",
		}
	}
	if object.Body == nil {
		return Stored{}, auth.ResourceScope{}, &Error{
			Kind: ErrIntegrity, Code: "backup.integrity_error", Detail: "backup の整合性を確認できません",
		}
	}
	defer object.Body.Close()
	data, err := readStoredBackup(object, metadata)
	if err != nil {
		return Stored{}, auth.ResourceScope{}, err
	}
	return Stored{
		FileName: "feedback-backup-" + id + ".zip", ContentType: "application/zip",
		Bytes: data, SHA256: metadata.ArchiveSHA256,
	}, scope, nil
}

func readStoredBackup(object objectstore.Object, metadata StoredMetadata) ([]byte, error) {
	if object.Body == nil || metadata.ArchiveBytes <= 0 || metadata.ArchiveBytes == math.MaxInt64 ||
		(object.Size >= 0 && object.Size != metadata.ArchiveBytes) {
		return nil, &Error{
			Kind: ErrIntegrity, Code: "backup.integrity_error", Detail: "backup の整合性を確認できません",
		}
	}
	data, err := io.ReadAll(io.LimitReader(object.Body, metadata.ArchiveBytes+1))
	if err != nil {
		return nil, &Error{
			Kind: ErrStorageUnavailable, Code: "backup.storage_unavailable", Detail: "backup storage を読み取れません",
		}
	}
	if int64(len(data)) != metadata.ArchiveBytes || SHA256Bytes(data) != metadata.ArchiveSHA256 {
		return nil, &Error{
			Kind: ErrIntegrity, Code: "backup.integrity_error", Detail: "backup の整合性を確認できません",
		}
	}
	return data, nil
}

func (service *Service) Retry(
	ctx context.Context, principal auth.Principal, input WorkspaceInput, backupID string,
) (MutationResult[Run], error) {
	scope, err := service.resolveWorkspace(ctx, principal, input)
	if err != nil {
		return MutationResult[Run]{}, err
	}
	if err := service.authorize(ctx, principal, scope, auth.PermissionAdmin, false, input.RequestID); err != nil {
		return MutationResult[Run]{}, err
	}
	id, err := canonicalUUID(backupID, "backupId")
	if err != nil {
		return MutationResult[Run]{}, err
	}
	value, err := service.store.RetryBackup(ctx, scope, id)
	if err != nil {
		return MutationResult[Run]{}, err
	}
	return MutationResult[Run]{Value: value, Scope: scope}, nil
}

func (service *Service) resolveWorkspace(
	ctx context.Context, principal auth.Principal, input WorkspaceInput,
) (auth.ResourceScope, error) {
	if !backupApplicationKeyPattern.MatchString(input.ApplicationKey) {
		return auth.ResourceScope{}, invalid("request.invalid", "applicationKey が不正です")
	}
	workspace := strings.TrimSpace(input.ExternalWorkspaceKey)
	if workspace == "" || len(utf16.Encode([]rune(workspace))) > 200 {
		return auth.ResourceScope{}, invalid("request.invalid", "workspace scope が不正です")
	}
	scope, err := service.store.ResolveBackupWorkspaceScope(ctx, principal.UserID, input.ApplicationKey, workspace)
	if err != nil {
		return auth.ResourceScope{}, err
	}
	service.notifyScope(ctx, scope)
	return scope, nil
}

var backupApplicationKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

func (service *Service) resolveResource(
	ctx context.Context, principal auth.Principal, rawID string,
) (auth.ResourceScope, string, error) {
	id, err := canonicalUUID(rawID, "backupId")
	if err != nil {
		return auth.ResourceScope{}, "", err
	}
	scope, err := service.store.ResolveResourceScope(ctx, principal.UserID, "backup", id)
	if err != nil {
		return auth.ResourceScope{}, "", err
	}
	service.notifyScope(ctx, scope)
	return scope, id, nil
}

func (service *Service) authorize(
	ctx context.Context, principal auth.Principal, scope auth.ResourceScope,
	permission auth.Permission, hide bool, requestID string,
) error {
	_, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: permission, HideExistence: hide, RequestID: requestID,
	})
	if err != nil {
		return err
	}
	if err := service.store.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(permission),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed", RequestID: requestID,
	}); err != nil {
		return fmt.Errorf("backup認可監査を記録できません: %w", err)
	}
	return nil
}

func (service *Service) notifyScope(ctx context.Context, scope auth.ResourceScope) {
	if service.observeScope != nil {
		service.observeScope(ctx, scope)
	}
}

func canonicalUUID(value, name string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", invalid("request.invalid", fmt.Sprintf("%s は UUID で指定してください", name))
	}
	return parsed.String(), nil
}

func normalizeLimit(value *int) (int, error) {
	if value == nil {
		return 50, nil
	}
	if *value < 1 || *value > 200 {
		return 0, invalid("request.invalid", "limit は 1 以上 200 以下で指定してください")
	}
	return *value, nil
}

func decodeCursor(value *string) (int, error) {
	if value == nil {
		return 0, nil
	}
	if len(*value) > 2000 {
		return 0, invalid("request.invalid", "cursor が長すぎます")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*value)
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(*value)
	}
	text := string(decoded)
	if err != nil || !strings.HasPrefix(text, "offset:") {
		return 0, invalid("request.invalid", "cursor が不正です")
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(text, "offset:"))
	if err != nil || offset < 0 {
		return 0, invalid("request.invalid", "cursor が不正です")
	}
	return offset, nil
}
