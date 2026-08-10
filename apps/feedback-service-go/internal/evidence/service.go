package evidence

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type Service struct {
	repository   Repository
	store        objectstore.Store
	authorizer   Authorizer
	settings     Settings
	observeScope func(context.Context, auth.ResourceScope)
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func NewService(
	repository Repository,
	store objectstore.Store,
	authorizer Authorizer,
	settings Settings,
	options ...Option,
) (*Service, error) {
	if repository == nil || store == nil || authorizer == nil {
		return nil, errors.New("evidence dependencyが未設定です")
	}
	if settings.MaximumBytes <= 0 || settings.StorageTimeout <= 0 ||
		settings.OrphanGrace < 5*time.Minute || settings.DeleteAttempts < 1 || settings.DeleteAttempts > 10 {
		return nil, errors.New("evidence settingsが不正です")
	}
	if !strings.HasSuffix(settings.KeyPrefix, "/") || objectstore.ValidatePrefix(settings.KeyPrefix) != nil {
		return nil, errors.New("evidence key prefixが不正です")
	}
	service := &Service{
		repository: repository, store: store, authorizer: authorizer, settings: settings,
		observeScope: func(context.Context, auth.ResourceScope) {},
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	if service.observeScope == nil {
		return nil, errors.New("evidence scope observerが不正です")
	}
	return service, nil
}

// Stage はDB transaction開始前にだけ呼び出す。storage I/OとDB I/Oを混在させない。
func (service *Service) Stage(
	ctx context.Context,
	scope auth.ResourceScope,
	threadID string,
	input Input,
) (Attachment, error) {
	if !validUUID(scope.TenantID) || !validUUID(scope.WorkspaceID) || !validUUID(threadID) {
		return Attachment{}, invalid("evidence object scopeが不正です")
	}
	attachment, err := Prepare(input, service.settings.MaximumBytes)
	if err != nil {
		return Attachment{}, err
	}
	attachment.ObjectKey = service.settings.KeyPrefix + scope.TenantID + "/" + scope.WorkspaceID + "/" + threadID
	if err := objectstore.ValidateKey(attachment.ObjectKey); err != nil {
		return Attachment{}, invalid("evidence object keyが不正です")
	}
	storageCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
	err = service.store.Put(storageCtx, attachment.ObjectKey, attachment.ContentType, input.Data)
	cancel()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Attachment{}, ctxErr
		}
		service.recordStorageFailure(ctx, scope.TenantID)
		return Attachment{}, storageError("evidence storage へ保存できません", err)
	}
	return attachment, nil
}

// Discard はtransactionのrollback/未開始が確定したobjectだけを削除する。
// commit結果不明のobjectは呼出側がDiscardせず、SweepOrphansへ委ねる。
func (service *Service) Discard(ctx context.Context, attachment Attachment) error {
	if err := objectstore.ValidateKey(attachment.ObjectKey); err != nil {
		return invalid("evidence object keyが不正です")
	}
	if err := service.deleteObject(ctx, attachment.ObjectKey); err != nil {
		if tenantID, ok := service.tenantIDFromKey(attachment.ObjectKey); ok {
			service.recordStorageFailure(ctx, tenantID)
		}
		return storageError("evidence storageから削除できません", err)
	}
	return nil
}

// Download はprivate resource scopeを先に解決・認可し、DB metadataとobject実体を照合する。
func (service *Service) Download(
	ctx context.Context,
	principal auth.Principal,
	threadID string,
	requestID string,
) (Download, error) {
	if !validUUID(threadID) || !validUUID(principal.UserID) {
		return Download{}, invalid("threadIdまたはprincipalが不正です")
	}
	scope, err := service.repository.ResolveEvidenceScope(ctx, principal.UserID, threadID)
	if err != nil {
		return Download{}, err
	}
	service.observeScope(ctx, scope)
	if _, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: auth.PermissionRead,
		HideExistence: true, RequestID: requestID,
	}); err != nil {
		return Download{}, err
	}
	if err := service.repository.RecordEvidenceAuthorization(ctx, scope, principal, requestID); err != nil {
		return Download{}, fmt.Errorf("evidence認可監査を記録できません: %w", err)
	}
	metadata, err := service.repository.GetEvidenceMetadata(ctx, threadID)
	if err != nil {
		return Download{}, err
	}
	if metadata.ThreadID != threadID || !validAttachment(metadata.Attachment, service.settings.MaximumBytes) {
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, malformedIntegrity()
	}

	storageCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
	object, err := service.store.Get(storageCtx, metadata.ObjectKey)
	if err != nil {
		cancel()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Download{}, ctxErr
		}
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, storageError("evidence storage を読み取れません", err)
	}
	if object.Body == nil {
		cancel()
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, malformedIntegrity()
	}
	if (object.Size >= 0 && object.Size != metadata.ByteSize) ||
		(object.ContentType != "" && object.ContentType != metadata.ContentType) {
		_ = object.Body.Close()
		cancel()
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, malformedIntegrity()
	}
	data, readErr := io.ReadAll(io.LimitReader(object.Body, metadata.ByteSize+1))
	closeErr := object.Body.Close()
	cancel()
	if readErr != nil || closeErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Download{}, ctxErr
		}
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, storageError("evidence storage を読み取れません", errors.Join(readErr, closeErr))
	}
	hash := sha256Bytes(data)
	if int64(len(data)) != metadata.ByteSize || hex.EncodeToString(hash[:]) != metadata.SHA256 ||
		!matchesContentType(metadata.ContentType, data) {
		service.recordStorageFailure(ctx, scope.TenantID)
		return Download{}, malformedIntegrity()
	}
	if err := service.repository.RecordEvidenceRead(ctx, scope, principal, threadID, requestID); err != nil {
		return Download{}, fmt.Errorf("evidence read監査を記録できません: %w", err)
	}
	return Download{ContentType: metadata.ContentType, Data: data}, nil
}

// Purge はobjectを先に削除し、その後にDB metadataを削除する。
// DB失敗時はmetadataだけが残るため、同じ処理の再実行で回復できる。
func (service *Service) Purge(ctx context.Context, attachment Attachment) error {
	if err := service.Discard(ctx, attachment); err != nil {
		return err
	}
	if err := service.repository.DeleteEvidenceMetadata(ctx, attachment.ObjectKey); err != nil {
		return fmt.Errorf("evidence metadataを削除できません: %w", err)
	}
	return nil
}

// SweepOrphans はgrace経過後にDB参照が存在しないことを全件確認してから削除する。
// commit結果不明のobjectを即時削除しないための回復境界でもある。
func (service *Service) SweepOrphans(ctx context.Context, now time.Time) (SweepResult, error) {
	storageCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
	refs, err := service.store.List(storageCtx, service.settings.KeyPrefix)
	cancel()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return SweepResult{}, ctxErr
		}
		return SweepResult{}, storageError("evidence storageを一覧できません", err)
	}
	result := SweepResult{Examined: len(refs)}
	cutoff := now.Add(-service.settings.OrphanGrace)
	candidates := make([]string, 0, len(refs))
	for _, ref := range refs {
		if objectstore.ValidateKey(ref.Key) != nil || ref.LastModified.IsZero() {
			return result, malformedIntegrity()
		}
		if !ref.LastModified.Before(cutoff) {
			result.Retained++
			continue
		}
		exists, err := service.repository.EvidenceObjectExists(ctx, ref.Key)
		if err != nil {
			// DB状態を全候補で確認できなければ、このrunでは1件も削除しない。
			return result, fmt.Errorf("orphan候補をDBと照合できません: %w", err)
		}
		if exists {
			result.Retained++
			continue
		}
		candidates = append(candidates, ref.Key)
	}
	var deleteErrors []error
	for _, key := range candidates {
		if err := service.deleteObject(ctx, key); err != nil {
			result.Retained++
			deleteErrors = append(deleteErrors, fmt.Errorf("%s: %w", key, err))
			continue
		}
		result.Deleted++
	}
	if len(deleteErrors) != 0 {
		return result, storageError("orphan evidenceを削除できません", errors.Join(deleteErrors...))
	}
	return result, nil
}

func (service *Service) deleteObject(ctx context.Context, key string) error {
	var failures []error
	for range service.settings.DeleteAttempts {
		storageCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
		err := service.store.Delete(storageCtx, key)
		cancel()
		if err == nil {
			return nil
		}
		failures = append(failures, err)
		if ctx.Err() != nil {
			break
		}
	}
	return errors.Join(failures...)
}

func (service *Service) recordStorageFailure(ctx context.Context, tenantID string) {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.settings.StorageTimeout)
	defer cancel()
	_ = service.repository.RecordEvidenceStorageFailure(recordCtx, tenantID)
}

func (service *Service) tenantIDFromKey(key string) (string, bool) {
	if !strings.HasPrefix(key, service.settings.KeyPrefix) {
		return "", false
	}
	relative := strings.TrimPrefix(key, service.settings.KeyPrefix)
	tenantID, _, found := strings.Cut(relative, "/")
	return tenantID, found && validUUID(tenantID)
}

func validAttachment(attachment Attachment, maximumBytes int64) bool {
	return attachment.ByteSize <= maximumBytes && ValidateAttachment(attachment) == nil
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}

func storageError(detail string, cause error) error {
	kind := ErrStorageUnavailable
	if cause != nil {
		kind = errors.Join(ErrStorageUnavailable, cause)
	}
	return domainError(kind, "evidence.storage_unavailable", detail)
}

var _ Stager = (*Service)(nil)
