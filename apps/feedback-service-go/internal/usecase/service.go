// Package usecase はHTTPやPostgreSQLの詳細から独立したapplication logicを提供する。
package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

var (
	ErrNotFound            = errors.New("resourceが見つかりません")
	ErrConflict            = errors.New("resourceが競合しています")
	ErrVersionMismatch     = errors.New("resource versionが一致しません")
	ErrDatabaseUnavailable = errors.New("databaseを利用できません")
)

// DomainError はHTTPへ安定したcode/detailを渡す業務errorである。
type DomainError struct {
	Kind   error
	Code   string
	Detail string
}

func (err *DomainError) Error() string { return err.Detail }
func (err *DomainError) Unwrap() error { return err.Kind }

type Membership struct {
	ApplicationKey       string            `json:"applicationKey"`
	ExternalWorkspaceKey string            `json:"externalWorkspaceKey"`
	Permissions          []auth.Permission `json:"permissions"`
}

type Participant struct {
	PrincipalID     string  `json:"principalId"`
	DisplayName     *string `json:"displayName"`
	ParticipantName *string `json:"participantName"`
}

type Me struct {
	Participant Participant  `json:"participant"`
	Memberships []Membership `json:"memberships"`
}

type Capabilities struct {
	APIVersion             string                     `json:"apiVersion"`
	APIMajorVersion        int                        `json:"apiMajorVersion"`
	ManifestSchemaVersions []string                   `json:"manifestSchemaVersions"`
	TargetSchemaVersions   []string                   `json:"targetSchemaVersions"`
	Evidence               CapabilitiesEvidencePolicy `json:"evidence"`
	Features               []string                   `json:"features"`
}

type CapabilitiesEvidencePolicy struct {
	MaxBytes             int64    `json:"maxBytes"`
	MaxCountPerWorkspace int      `json:"maxCountPerWorkspace"`
	AcceptedContentTypes []string `json:"acceptedContentTypes"`
}

type ManifestRecord struct {
	Manifest json.RawMessage
	Version  int
}

type ManifestPut struct {
	Scope           auth.ResourceScope
	Principal       auth.Principal
	Manifest        json.RawMessage
	ManifestVersion string
	ExpectedVersion *int
}

type AuditEvent struct {
	Scope        *auth.ResourceScope
	PrincipalID  string
	Action       string
	ResourceType string
	ResourceID   string
	Outcome      string
	RequestID    string
	Changes      json.RawMessage
}

type ReviewContextInput struct {
	ApplicationKey       string
	EnvironmentKey       string
	ExternalWorkspaceKey string
	PageKey              string
	RouteTemplate        string
	RequestID            string
}

type ReviewContext struct {
	Session           *Session          `json:"session"`
	Scope             string            `json:"scope"`
	Posting           string            `json:"posting"`
	Permissions       []auth.Permission `json:"permissions"`
	ParticipantPolicy ParticipantPolicy `json:"participantPolicy"`
	EvidencePolicy    EvidencePolicy    `json:"evidencePolicy"`
}

type ParticipantPolicy struct {
	Mode string `json:"mode"`
}

type EvidencePolicy struct {
	Enabled              bool     `json:"enabled"`
	MaxBytes             int64    `json:"maxBytes"`
	AcceptedContentTypes []string `json:"acceptedContentTypes"`
}

type Session struct {
	ID                   string               `json:"id"`
	ApplicationKey       string               `json:"applicationKey"`
	EnvironmentKey       string               `json:"environmentKey"`
	ExternalWorkspaceKey string               `json:"externalWorkspaceKey"`
	ManifestVersion      string               `json:"manifestVersion"`
	Title                string               `json:"title"`
	Description          *string              `json:"description"`
	Status               string               `json:"status"`
	OutOfScopePosting    string               `json:"outOfScopePosting"`
	StartAt              *string              `json:"startAt"`
	EndAt                *string              `json:"endAt"`
	Scopes               []SessionScope       `json:"scopes"`
	Perspectives         []SessionPerspective `json:"perspectives"`
	CreatedAt            string               `json:"createdAt"`
	UpdatedAt            string               `json:"updatedAt"`
	Version              int                  `json:"version"`
}

type SessionScope struct {
	PageKey       string  `json:"pageKey"`
	RouteTemplate *string `json:"routeTemplate"`
	Reviewable    bool    `json:"reviewable"`
}

type SessionPerspective struct {
	Code     string  `json:"code"`
	Label    string  `json:"label"`
	Status   string  `json:"status"`
	Guidance *string `json:"guidance"`
}

// Store はPhase 1 endpointが必要とする最小永続化portである。
type Store interface {
	Ping(context.Context) error
	ListMemberships(context.Context, string) ([]auth.Membership, error)
	ResolveApplicationScope(context.Context, string, string) (auth.ResourceScope, error)
	ResolveWorkspaceScope(context.Context, string, string, string, string) (auth.ResourceScope, error)
	GetManifest(context.Context, string) (ManifestRecord, error)
	PutManifest(context.Context, ManifestPut) (ManifestRecord, error)
	ReviewContext(context.Context, auth.ResourceScope, string, string, []auth.Permission, int64) (ReviewContext, error)
	RecordAudit(context.Context, AuditEvent) error
}

type Service struct {
	store                     Store
	authorizer                *auth.Authorizer
	evidenceMaxBytes          int64
	evidenceMaxCountWorkspace int
	observeScope              func(context.Context, auth.ResourceScope)
}

type Option func(*Service)

func WithScopeObserver(observer func(context.Context, auth.ResourceScope)) Option {
	return func(service *Service) { service.observeScope = observer }
}

func NewService(
	store Store,
	authorizer *auth.Authorizer,
	evidenceMaxBytes int64,
	evidenceMaxCountWorkspace int,
	options ...Option,
) (*Service, error) {
	if store == nil || authorizer == nil {
		return nil, errors.New("usecase dependencyが未設定です")
	}
	if evidenceMaxBytes <= 0 || evidenceMaxCountWorkspace <= 0 {
		return nil, errors.New("evidence上限は正数で指定してください")
	}
	service := &Service{
		store: store, authorizer: authorizer,
		evidenceMaxBytes: evidenceMaxBytes, evidenceMaxCountWorkspace: evidenceMaxCountWorkspace,
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

func (service *Service) Capabilities(ctx context.Context) (Capabilities, error) {
	if err := service.store.Ping(ctx); err != nil {
		return Capabilities{}, &DomainError{Kind: ErrDatabaseUnavailable, Code: "database.unavailable", Detail: "databaseを利用できません"}
	}
	return Capabilities{
		APIVersion: "1.0", APIMajorVersion: 1,
		ManifestSchemaVersions: []string{"1"}, TargetSchemaVersions: []string{"1"},
		Evidence: CapabilitiesEvidencePolicy{
			MaxBytes: service.evidenceMaxBytes, MaxCountPerWorkspace: service.evidenceMaxCountWorkspace,
			AcceptedContentTypes: []string{"image/png", "image/webp"},
		},
		Features: []string{
			"application-manifest", "idempotency", "etag", "message-history", "private-evidence",
			"rate-limit", "notification-outbox", "automatic-backup", "notification-connectors",
		},
	}, nil
}

func (service *Service) Me(ctx context.Context, principal auth.Principal) (Me, error) {
	memberships, err := service.store.ListMemberships(ctx, principal.UserID)
	if err != nil {
		return Me{}, fmt.Errorf("membershipを取得できません: %w", err)
	}
	restricted := auth.RestrictMemberships(principal, memberships)
	result := make([]Membership, 0, len(restricted))
	for _, membership := range restricted {
		result = append(result, Membership{
			ApplicationKey: membership.ApplicationKey, ExternalWorkspaceKey: membership.ExternalWorkspaceKey,
			Permissions: slices.Clone(membership.Permissions),
		})
	}
	return Me{
		Participant: Participant{PrincipalID: principal.Subject, DisplayName: principal.DisplayName},
		Memberships: result,
	}, nil
}

func (service *Service) GetManifest(
	ctx context.Context,
	principal auth.Principal,
	applicationKey string,
	requestID string,
) (ManifestRecord, error) {
	scope, authorized, err := service.authorizeApplication(ctx, principal, applicationKey, auth.PermissionRead, true, requestID)
	if err != nil {
		return ManifestRecord{}, err
	}
	if err := service.recordAllowed(ctx, authorized, auth.PermissionRead, true, requestID); err != nil {
		return ManifestRecord{}, err
	}
	return service.store.GetManifest(ctx, scope.ApplicationID)
}

func (service *Service) PutManifest(
	ctx context.Context,
	principal auth.Principal,
	applicationKey string,
	requestID string,
	prepare func() (json.RawMessage, string, *int, error),
) (ManifestRecord, error) {
	scope, authorized, err := service.authorizeApplication(ctx, principal, applicationKey, auth.PermissionAdmin, true, requestID)
	if err != nil {
		return ManifestRecord{}, err
	}
	if err := service.recordAllowed(ctx, authorized, auth.PermissionAdmin, true, requestID); err != nil {
		return ManifestRecord{}, err
	}
	if prepare == nil {
		return ManifestRecord{}, errors.New("manifest decoderが未設定です")
	}
	manifest, manifestVersion, expectedVersion, err := prepare()
	if err != nil {
		return ManifestRecord{}, err
	}
	record, err := service.store.PutManifest(ctx, ManifestPut{
		Scope: scope, Principal: principal, Manifest: manifest, ManifestVersion: manifestVersion,
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		return ManifestRecord{}, err
	}
	if err := service.store.RecordAudit(ctx, AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: "manifest.put", ResourceType: "application-manifest",
		ResourceID: applicationKey, Outcome: "succeeded", RequestID: requestID,
	}); err != nil {
		return ManifestRecord{}, fmt.Errorf("manifest成功監査を記録できません: %w", err)
	}
	return record, nil
}

// ReviewContext は認可後にmanifest検証callbackを実行し、現在のレビュー文脈を返す。
func (service *Service) ReviewContext(
	ctx context.Context,
	principal auth.Principal,
	input ReviewContextInput,
	validateLocation func(json.RawMessage) error,
) (ReviewContext, error) {
	scope, err := service.store.ResolveWorkspaceScope(
		ctx, principal.UserID, input.ApplicationKey, input.ExternalWorkspaceKey, input.EnvironmentKey,
	)
	if err != nil {
		return ReviewContext{}, err
	}
	service.notifyScope(ctx, scope)
	authorized, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: auth.PermissionRead, RequestID: input.RequestID,
	})
	if err != nil {
		return ReviewContext{}, err
	}
	if err := service.recordAllowed(ctx, authorized, auth.PermissionRead, false, input.RequestID); err != nil {
		return ReviewContext{}, err
	}
	manifest, err := service.store.GetManifest(ctx, scope.ApplicationID)
	if err != nil {
		return ReviewContext{}, err
	}
	if validateLocation == nil {
		return ReviewContext{}, errors.New("location validatorが未設定です")
	}
	if err := validateLocation(manifest.Manifest); err != nil {
		return ReviewContext{}, err
	}
	permissions := slices.Clone(authorized.Permissions)
	slices.Sort(permissions)
	return service.store.ReviewContext(
		ctx, scope, input.PageKey, input.RouteTemplate, permissions, service.evidenceMaxBytes,
	)
}

func (service *Service) authorizeApplication(
	ctx context.Context,
	principal auth.Principal,
	applicationKey string,
	required auth.Permission,
	hideExistence bool,
	requestID string,
) (auth.ResourceScope, auth.AuthorizedContext, error) {
	scope, err := service.store.ResolveApplicationScope(ctx, principal.UserID, applicationKey)
	if err != nil {
		return auth.ResourceScope{}, auth.AuthorizedContext{}, err
	}
	service.notifyScope(ctx, scope)
	authorized, err := service.authorizer.Authorize(ctx, auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: required, ApplicationOnly: true,
		HideExistence: hideExistence, RequestID: requestID,
	})
	return scope, authorized, err
}

func (service *Service) notifyScope(ctx context.Context, scope auth.ResourceScope) {
	if service.observeScope != nil {
		service.observeScope(ctx, scope)
	}
}

func (service *Service) recordAllowed(
	ctx context.Context,
	authorized auth.AuthorizedContext,
	permission auth.Permission,
	applicationOnly bool,
	requestID string,
) error {
	resourceType := "workspace"
	resourceID := authorized.Scope.WorkspaceID
	if applicationOnly {
		resourceType = "application"
		resourceID = authorized.Scope.ApplicationID
	}
	scope := authorized.Scope
	if err := service.store.RecordAudit(ctx, AuditEvent{
		Scope: &scope, PrincipalID: authorized.Principal.Subject, Action: string(permission),
		ResourceType: resourceType, ResourceID: resourceID, Outcome: "allowed", RequestID: requestID,
	}); err != nil {
		return fmt.Errorf("認可監査を記録できません: %w", err)
	}
	return nil
}
