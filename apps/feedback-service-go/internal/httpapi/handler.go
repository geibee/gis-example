package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const maximumManifestBytes = 4 * 1024 * 1024

var etagPattern = regexp.MustCompile(`^(?:W/)?"v([1-9][0-9]*)"$`)

type bearerAuthenticator interface {
	Authenticate(context.Context, string, string) (auth.Principal, error)
}

type principalContextKey struct{}

// APIHandler は移行済みoperationだけを上書きし、残りはPhaseごとに明示実装する。
type APIHandler struct {
	contract.Unimplemented
	service            *usecase.Service
	sessions           *session.Service
	discussions        *discussion.Service
	evidence           *evidence.Service
	exports            *exportdomain.Service
	administration     *admin.Service
	backups            *backup.Service
	connectors         *connector.Service
	notifications      *notification.Service
	retention          *retention.Service
	adminScopeResolver adminWorkspaceScopeResolver
	scopeResolver      resourceScopeResolver
	authorizer         *auth.Authorizer
	rateLimiter        writeRateLimiter
	discussionSettings DiscussionAPISettings
	auditor            mutationAuditor
}

type mutationAuditor interface {
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type resourceScopeResolver interface {
	ResolveResourceScope(context.Context, string, string, string) (auth.ResourceScope, error)
}

type adminWorkspaceScopeResolver interface {
	ResolveAdminWorkspaceScope(context.Context, string, string, string) (auth.ResourceScope, error)
}

type writeRateLimiter interface {
	EnforceWriteRateLimit(context.Context, discussion.RateLimitInput) error
}

type DiscussionAPISettings struct {
	EvidenceMaximumBytes    int64
	PrincipalLimitPerMinute int
	TenantLimitPerMinute    int
	IPLimitPerMinute        int
}

type APIHandlerOption func(*APIHandler) error

// WithRetentionAPI は保存方針APIと成功監査の依存を追加する。
func WithRetentionAPI(service *retention.Service, auditor mutationAuditor) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || auditor == nil {
			return errors.New("retention API dependencyが未設定です")
		}
		handler.retention = service
		handler.auditor = auditor
		return nil
	}
}

// WithAdminAPI はworkspace membership管理と成功監査の依存を追加する。
func WithAdminAPI(service *admin.Service, auditor mutationAuditor) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || auditor == nil {
			return errors.New("admin API dependencyが未設定です")
		}
		handler.administration = service
		handler.auditor = auditor
		return nil
	}
}

// WithBackupAPI はbackup policy・archive管理と成功監査の依存を追加する。
func WithBackupAPI(service *backup.Service, auditor mutationAuditor) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || auditor == nil {
			return errors.New("backup API dependencyが未設定です")
		}
		handler.backups = service
		handler.auditor = auditor
		return nil
	}
}

// WithNotificationAPI は通知設定・connector・delivery管理の依存を追加する。
func WithNotificationAPI(
	notificationService *notification.Service,
	connectorService *connector.Service,
	resolver adminWorkspaceScopeResolver,
	authorizer *auth.Authorizer,
	limiter writeRateLimiter,
	auditor mutationAuditor,
) APIHandlerOption {
	return func(handler *APIHandler) error {
		if notificationService == nil || connectorService == nil || resolver == nil ||
			authorizer == nil || limiter == nil || auditor == nil {
			return errors.New("notification API dependencyが未設定です")
		}
		handler.notifications = notificationService
		handler.connectors = connectorService
		handler.adminScopeResolver = resolver
		handler.authorizer = authorizer
		handler.rateLimiter = limiter
		handler.auditor = auditor
		return nil
	}
}

// WithSessionAPI はsession operationと成功監査の依存を追加する。
func WithSessionAPI(service *session.Service, auditor mutationAuditor) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || auditor == nil {
			return errors.New("session API dependencyが未設定です")
		}
		handler.sessions = service
		handler.auditor = auditor
		return nil
	}
}

// WithDiscussionAPI はthread/message operationの依存とrate limit契約を追加する。
func WithDiscussionAPI(
	service *discussion.Service,
	resolver resourceScopeResolver,
	authorizer *auth.Authorizer,
	auditor mutationAuditor,
	settings DiscussionAPISettings,
) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || resolver == nil || authorizer == nil || auditor == nil {
			return errors.New("discussion API dependencyが未設定です")
		}
		if settings.EvidenceMaximumBytes <= 0 || settings.PrincipalLimitPerMinute <= 0 ||
			settings.TenantLimitPerMinute <= 0 || settings.IPLimitPerMinute <= 0 {
			return errors.New("discussion API settingsが不正です")
		}
		handler.discussions = service
		handler.rateLimiter = service
		handler.scopeResolver = resolver
		handler.authorizer = authorizer
		handler.auditor = auditor
		handler.discussionSettings = settings
		return nil
	}
}

// WithExportAPI は非同期exportの受付・状態・private downloadを追加する。
func WithExportAPI(service *exportdomain.Service, limiter writeRateLimiter, auditor mutationAuditor) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil || limiter == nil || auditor == nil {
			return errors.New("export API dependencyが未設定です")
		}
		handler.exports = service
		handler.rateLimiter = limiter
		handler.auditor = auditor
		return nil
	}
}

// WithEvidenceAPI はprivate evidence download operationを追加する。
func WithEvidenceAPI(service *evidence.Service) APIHandlerOption {
	return func(handler *APIHandler) error {
		if service == nil {
			return errors.New("evidence API dependencyが未設定です")
		}
		handler.evidence = service
		return nil
	}
}

func NewAPIHandler(service *usecase.Service, options ...APIHandlerOption) (*APIHandler, error) {
	if service == nil {
		return nil, errors.New("usecase serviceが未設定です")
	}
	handler := &APIHandler{service: service}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(handler); err != nil {
			return nil, err
		}
	}
	return handler, nil
}

// ValidateComplete はproduction routeがUnimplementedへ落ちる依存欠落を起動前に拒否する。
// 部分構築は機能別integration testだけで使用し、実serverは必ずこの検査を通す。
func (handler *APIHandler) ValidateComplete() error {
	if handler == nil {
		return errors.New("production API handlerが未設定です")
	}
	missing := make([]string, 0, 15)
	for name, absent := range map[string]bool{
		"core":                 handler.service == nil,
		"sessions":             handler.sessions == nil,
		"discussions":          handler.discussions == nil,
		"evidence":             handler.evidence == nil,
		"exports":              handler.exports == nil,
		"administration":       handler.administration == nil,
		"backups":              handler.backups == nil,
		"connectors":           handler.connectors == nil,
		"notifications":        handler.notifications == nil,
		"retention":            handler.retention == nil,
		"admin-scope-resolver": handler.adminScopeResolver == nil,
		"resource-resolver":    handler.scopeResolver == nil,
		"authorizer":           handler.authorizer == nil,
		"rate-limiter":         handler.rateLimiter == nil,
		"auditor":              handler.auditor == nil,
	} {
		if absent {
			missing = append(missing, name)
		}
	}
	if handler.discussionSettings.EvidenceMaximumBytes <= 0 ||
		handler.discussionSettings.PrincipalLimitPerMinute <= 0 ||
		handler.discussionSettings.TenantLimitPerMinute <= 0 ||
		handler.discussionSettings.IPLimitPerMinute <= 0 {
		missing = append(missing, "discussion-settings")
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return fmt.Errorf("production API dependencyが未設定です: %s", strings.Join(missing, ","))
	}
	return nil
}

func (handler *APIHandler) GetFeedbackCapabilities(writer http.ResponseWriter, request *http.Request) {
	result, err := handler.service.Capabilities(request.Context())
	respondJSONOrError(writer, request, http.StatusOK, result, err)
}

func (handler *APIHandler) GetFeedbackMe(writer http.ResponseWriter, request *http.Request) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.service.Me(request.Context(), principal)
	respondJSONOrError(writer, request, http.StatusOK, result, err)
}

func (handler *APIHandler) GetFeedbackApplicationManifest(
	writer http.ResponseWriter,
	request *http.Request,
	applicationKey contract.ApplicationKey,
) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	key := string(applicationKey)
	if err := ValidateApplicationKey(key); err != nil {
		WriteError(writer, request, err)
		return
	}
	record, err := handler.service.GetManifest(
		request.Context(), principal, key, RequestIDFromContext(request.Context()),
	)
	if err != nil {
		WriteError(writer, request, mapServiceError(err))
		return
	}
	writeRawJSON(writer, http.StatusOK, record.Manifest)
}

func (handler *APIHandler) PutFeedbackApplicationManifest(
	writer http.ResponseWriter,
	request *http.Request,
	applicationKey contract.ApplicationKey,
	params contract.PutFeedbackApplicationManifestParams,
) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	key := string(applicationKey)
	if err := ValidateApplicationKey(key); err != nil {
		WriteError(writer, request, err)
		return
	}
	record, err := handler.service.PutManifest(
		request.Context(), principal, key, RequestIDFromContext(request.Context()),
		func() (json.RawMessage, string, *int, error) {
			body, readErr := readBoundedBody(request.Body, maximumManifestBytes)
			if readErr != nil {
				return nil, "", nil, readErr
			}
			manifest, decodeErr := DecodeManifest(body, key)
			if decodeErr != nil {
				return nil, "", nil, decodeErr
			}
			encoded, encodeErr := json.Marshal(manifest)
			if encodeErr != nil {
				return nil, "", nil, encodeErr
			}
			var expectedVersion *int
			if params.IfMatch != nil {
				parsed, parseErr := parseETag(string(*params.IfMatch))
				if parseErr != nil {
					return nil, "", nil, parseErr
				}
				expectedVersion = &parsed
			}
			return encoded, manifest.ManifestVersion, expectedVersion, nil
		},
	)
	if err != nil {
		WriteError(writer, request, mapServiceError(err))
		return
	}
	writer.Header().Set("ETag", formatETag(record.Version))
	writeRawJSON(writer, http.StatusOK, record.Manifest)
}

func (handler *APIHandler) GetFeedbackReviewContext(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.GetFeedbackReviewContextParams,
) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	applicationKey := string(params.ApplicationKey)
	if err := ValidateApplicationKey(applicationKey); err != nil {
		WriteError(writer, request, err)
		return
	}
	environmentKey, err := ValidateKey(string(params.EnvironmentKey), "environmentKey", 100)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	workspaceKey, err := ValidateKey(string(params.ExternalWorkspaceKey), "externalWorkspaceKey", 200)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	if _, err := ValidateKey(params.Release, "release", 100); err != nil {
		WriteError(writer, request, err)
		return
	}
	if params.Locale != nil {
		if _, err := ValidateKey(*params.Locale, "locale", 35); err != nil {
			WriteError(writer, request, err)
			return
		}
	}
	pageKey, err := ValidateKey(params.PageKey, "pageKey", 100)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	routeTemplate, err := ValidateKey(params.RouteTemplate, "routeTemplate", 500)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.service.ReviewContext(
		request.Context(),
		principal,
		usecase.ReviewContextInput{
			ApplicationKey: applicationKey, EnvironmentKey: environmentKey,
			ExternalWorkspaceKey: workspaceKey, PageKey: pageKey, RouteTemplate: routeTemplate,
			RequestID: RequestIDFromContext(request.Context()),
		},
		func(rawManifest json.RawMessage) error {
			manifest, decodeErr := DecodeManifest(rawManifest, applicationKey)
			if decodeErr != nil {
				return fmt.Errorf("保存済みmanifestが不正です: %v", decodeErr)
			}
			_, sanitizeErr := SanitizeLocation(
				manifest, pageKey, routeTemplate, params.PathParameters, params.QueryParameters,
			)
			return sanitizeErr
		},
	)
	respondJSONOrError(writer, request, http.StatusOK, result, mapServiceError(err))
}

// AuthenticationMiddleware はcapabilitiesと運用route以外でBearer JWTを必須にする。
func AuthenticationMiddleware(authenticator bearerAuthenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if authenticationExempt(request) {
				next.ServeHTTP(writer, request)
				return
			}
			if authenticator == nil {
				WriteError(writer, request, NewAPIError(
					http.StatusInternalServerError, "/problems/internal-error", "internal.error", "",
				))
				return
			}
			rawToken := bearerToken(request.Header.Values("Authorization"))
			principal, err := authenticator.Authenticate(
				request.Context(), rawToken, RequestIDFromContext(request.Context()),
			)
			if err != nil {
				if errors.Is(err, auth.ErrAuditUnavailable) {
					WriteError(writer, request, err)
					return
				}
				authenticationError := NewAPIError(
					http.StatusUnauthorized, "/problems/authentication-required", "auth.required", "",
				)
				authenticationError.Problem.Title = "認証が必要です"
				WriteError(writer, request, authenticationError)
				return
			}
			ctx := context.WithValue(request.Context(), principalContextKey{}, principal)
			next.ServeHTTP(writer, request.WithContext(ctx))
		})
	}
}

func PrincipalFromContext(ctx context.Context) (auth.Principal, error) {
	principal, ok := ctx.Value(principalContextKey{}).(auth.Principal)
	if !ok || principal.UserID == "" {
		err := NewAPIError(http.StatusUnauthorized, "/problems/authentication-required", "auth.required", "認証が必要です")
		err.Problem.Title = "認証が必要です"
		return auth.Principal{}, err
	}
	return principal, nil
}

func authenticationExempt(request *http.Request) bool {
	if request.Method == http.MethodOptions || request.URL.Path == "/feedback/v1/capabilities" {
		return true
	}
	return strings.HasPrefix(request.URL.Path, "/health/") || request.URL.Path == "/metrics"
}

func bearerToken(headers []string) string {
	if len(headers) != 1 {
		return ""
	}
	parts := strings.Fields(headers[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func mapServiceError(err error) error {
	if err == nil {
		return nil
	}
	var authorizationError *auth.AuthorizationError
	if errors.As(err, &authorizationError) {
		if authorizationError.HideExistence {
			return NewAPIError(http.StatusNotFound, "/problems/resource.not_found", "resource.not_found", "リソースが見つかりません")
		}
		return NewAPIError(http.StatusForbidden, "/problems/permission.denied", "permission.denied", "必要なfeedback permissionがありません")
	}
	var domainError *usecase.DomainError
	if errors.As(err, &domainError) {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(domainError, usecase.ErrNotFound):
			status = http.StatusNotFound
		case errors.Is(domainError, usecase.ErrConflict):
			status = http.StatusConflict
		case errors.Is(domainError, usecase.ErrVersionMismatch):
			status = http.StatusPreconditionFailed
		case errors.Is(domainError, usecase.ErrDatabaseUnavailable):
			status = http.StatusServiceUnavailable
		}
		return NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
	}
	return err
}

func parseETag(value string) (int, error) {
	match := etagPattern.FindStringSubmatch(value)
	if match == nil {
		return 0, invalid("etag.invalid", "If-Matchは応答されたETagをそのまま指定してください")
	}
	version, err := strconv.Atoi(match[1])
	if err != nil {
		return 0, invalid("etag.invalid", "If-Matchは応答されたETagをそのまま指定してください")
	}
	return version, nil
}

func formatETag(version int) string { return fmt.Sprintf(`"v%d"`, version) }

func readBoundedBody(body io.ReadCloser, maximum int64) ([]byte, error) {
	if body == nil {
		return nil, invalid("request.invalid_json", "request bodyがありません")
	}
	defer body.Close()
	value, err := io.ReadAll(io.LimitReader(body, maximum+1))
	if err != nil {
		return nil, invalid("request.invalid_json", "request bodyを読み取れません")
	}
	if int64(len(value)) > maximum {
		return nil, NewAPIError(http.StatusRequestEntityTooLarge, "/problems/request-too-large", "request.too_large", "request bodyが大きすぎます")
	}
	return value, nil
}

func respondJSONOrError(writer http.ResponseWriter, request *http.Request, status int, value any, err error) {
	if err != nil {
		WriteError(writer, request, mapServiceError(err))
		return
	}
	body, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		WriteError(writer, request, marshalErr)
		return
	}
	writeRawJSON(writer, status, body)
}

func writeRawJSON(writer http.ResponseWriter, status int, body []byte) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}
