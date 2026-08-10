package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const maximumNotificationRequestBytes = 1024 * 1024

func (handler *APIHandler) GetFeedbackNotificationSettings(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.GetFeedbackNotificationSettingsParams,
) {
	if handler.notifications == nil {
		//lint:ignore SA1019 OpenAPI互換のdeprecated routeも依存欠落時は同じfail-closed handlerへ送る。
		handler.Unimplemented.GetFeedbackNotificationSettings(writer, request, params)
		return
	}
	_, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	result, err := handler.notifications.GetSettings(request.Context(), scope)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.Settings, nil)
}

func (handler *APIHandler) PatchFeedbackNotificationSettings(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.PatchFeedbackNotificationSettingsParams,
) {
	if handler.notifications == nil {
		//lint:ignore SA1019 OpenAPI互換のdeprecated routeも依存欠落時は同じfail-closed handlerへ送る。
		handler.Unimplemented.PatchFeedbackNotificationSettings(writer, request, params)
		return
	}
	principal, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	body, err := readBoundedBody(request.Body, maximumNotificationRequestBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	settings, err := decodeNotificationSettings(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.notifications.PatchSettings(request.Context(), scope, version, settings)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.recordMutation(
		request, scope, principal.Subject, "notification-settings.patch", "notification-settings", scope.WorkspaceID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.Settings, nil)
}

func (handler *APIHandler) ListFeedbackConnectorTypes(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackConnectorTypesParams,
) {
	if handler.connectors == nil {
		handler.Unimplemented.ListFeedbackConnectorTypes(writer, request, params)
		return
	}
	_, _, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	result, err := handler.connectors.ListTypes(request.Context())
	respondJSONOrError(writer, request, http.StatusOK, result, mapNotificationAdministrationError(err))
}

func (handler *APIHandler) ListFeedbackNotificationConnectors(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackNotificationConnectorsParams,
) {
	if handler.connectors == nil {
		handler.Unimplemented.ListFeedbackNotificationConnectors(writer, request, params)
		return
	}
	_, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	result, err := handler.connectors.List(request.Context(), scope)
	respondJSONOrError(writer, request, http.StatusOK, result, mapNotificationAdministrationError(err))
}

func (handler *APIHandler) CreateFeedbackNotificationConnector(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.CreateFeedbackNotificationConnectorParams,
) {
	if handler.connectors == nil {
		handler.Unimplemented.CreateFeedbackNotificationConnector(writer, request, params)
		return
	}
	principal, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.enforceDiscussionRateLimit(request, principal, scope); err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	body, err := readBoundedBody(request.Body, maximumNotificationRequestBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := decodeNotificationConnectorCreate(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.connectors.Create(request.Context(), scope, input)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.recordMutation(
		request, scope, principal.Subject, "notification-connector.create", "notification-connector", result.ID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusCreated, result, nil)
}

func (handler *APIHandler) PatchFeedbackNotificationConnector(
	writer http.ResponseWriter,
	request *http.Request,
	connectorID contract.ConnectorID,
	params contract.PatchFeedbackNotificationConnectorParams,
) {
	if handler.connectors == nil {
		handler.Unimplemented.PatchFeedbackNotificationConnector(writer, request, connectorID, params)
		return
	}
	principal, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	body, err := readBoundedBody(request.Body, maximumNotificationRequestBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := decodeNotificationConnectorPatch(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	id := connectorID.String()
	result, err := handler.connectors.Patch(request.Context(), scope, id, version, input)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.recordMutation(
		request, scope, principal.Subject, "notification-connector.patch", "notification-connector", id,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) DeleteFeedbackNotificationConnector(
	writer http.ResponseWriter,
	request *http.Request,
	connectorID contract.ConnectorID,
	params contract.DeleteFeedbackNotificationConnectorParams,
) {
	if handler.connectors == nil {
		handler.Unimplemented.DeleteFeedbackNotificationConnector(writer, request, connectorID, params)
		return
	}
	principal, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	version, err := ParseRequiredETag(string(params.IfMatch))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	id := connectorID.String()
	if err := handler.connectors.Delete(request.Context(), scope, id, version); err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.recordMutation(
		request, scope, principal.Subject, "notification-connector.delete", "notification-connector", id,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (handler *APIHandler) ListFeedbackNotificationDeliveries(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackNotificationDeliveriesParams,
) {
	if handler.notifications == nil {
		handler.Unimplemented.ListFeedbackNotificationDeliveries(writer, request, params)
		return
	}
	_, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	var status *string
	if params.Status != nil {
		value, ok := params.Status.(string)
		if !ok {
			WriteError(writer, request, invalid("request.invalid", "statusが不正です"))
			return
		}
		status = &value
	}
	limit := 50
	if params.Limit != nil {
		limit = int(*params.Limit)
	}
	var connectorID *string
	if params.ConnectorID != nil {
		value := params.ConnectorID.String()
		connectorID = &value
	}
	result, err := handler.notifications.ListDeliveries(request.Context(), notification.ListInput{
		Scope: scope, Status: status, Limit: limit, ConnectorID: connectorID,
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapNotificationAdministrationError(err))
}

func (handler *APIHandler) RetryFeedbackNotificationDelivery(
	writer http.ResponseWriter,
	request *http.Request,
	deliveryID contract.DeliveryID,
	params contract.RetryFeedbackNotificationDeliveryParams,
) {
	if handler.notifications == nil {
		handler.Unimplemented.RetryFeedbackNotificationDelivery(writer, request, deliveryID, params)
		return
	}
	principal, scope, err := handler.authorizeAdminWorkspace(
		request, string(params.ApplicationKey), string(params.ExternalWorkspaceKey),
	)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	id := deliveryID.String()
	result, err := handler.notifications.Retry(request.Context(), scope, id)
	if err != nil {
		WriteError(writer, request, mapNotificationAdministrationError(err))
		return
	}
	if err := handler.recordMutation(
		request, scope, principal.Subject, "notification.retry", "notification-delivery", id,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) authorizeAdminWorkspace(
	request *http.Request,
	applicationKey string,
	externalWorkspaceKey string,
) (auth.Principal, auth.ResourceScope, error) {
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if handler.adminScopeResolver == nil || handler.authorizer == nil || handler.auditor == nil {
		return auth.Principal{}, auth.ResourceScope{}, errors.New("admin workspace authorization dependencyが未設定です")
	}
	if err := ValidateApplicationKey(applicationKey); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	workspaceKey, err := ValidateKey(externalWorkspaceKey, "externalWorkspaceKey", 200)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	scope, err := handler.adminScopeResolver.ResolveAdminWorkspaceScope(
		request.Context(), principal.UserID, applicationKey, workspaceKey,
	)
	if err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	WithLogFields(request.Context(), LogFields{
		Tenant: scope.TenantKey, Application: scope.ApplicationKey, Workspace: scope.ExternalWorkspaceKey,
	})
	if _, err := handler.authorizer.Authorize(request.Context(), auth.AuthorizationRequest{
		Principal: principal, Scope: scope, Required: auth.PermissionAdmin,
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, err
	}
	if err := handler.auditor.RecordAudit(request.Context(), usecase.AuditEvent{
		Scope: &scope, PrincipalID: principal.Subject, Action: string(auth.PermissionAdmin),
		ResourceType: "workspace", ResourceID: scope.WorkspaceID, Outcome: "allowed",
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return auth.Principal{}, auth.ResourceScope{}, fmt.Errorf("administration認可監査を記録できません: %w", err)
	}
	return principal, scope, nil
}

func decodeNotificationSettings(body []byte) (notification.Settings, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return notification.Settings{}, err
	}
	if err := rejectUnknownJSONFields(object, "webhookEnabled", "webhookEndpoint", "includeBody", "includeEvidence"); err != nil {
		return notification.Settings{}, err
	}
	webhookEnabled, err := requiredBoolean(object, "webhookEnabled")
	if err != nil {
		return notification.Settings{}, err
	}
	includeBody, err := optionalBoolean(object, "includeBody", false)
	if err != nil {
		return notification.Settings{}, err
	}
	includeEvidence, err := optionalBoolean(object, "includeEvidence", false)
	if err != nil {
		return notification.Settings{}, err
	}
	var endpoint *string
	if raw, exists := object["webhookEndpoint"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return notification.Settings{}, invalid("request.invalid", "webhookEndpointは文字列またはnullで指定してください")
		}
		endpoint = &value
	}
	return notification.Settings{
		WebhookEnabled: webhookEnabled, WebhookEndpoint: endpoint,
		IncludeBody: includeBody, IncludeEvidence: includeEvidence,
	}, nil
}

func decodeNotificationConnectorCreate(body []byte) (connector.CreateRequest, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return connector.CreateRequest{}, err
	}
	if err := rejectUnknownJSONFields(object, "connectorType", "name", "destinationRef", "enabled", "includeBody"); err != nil {
		return connector.CreateRequest{}, err
	}
	connectorType, err := requiredString(object, "connectorType")
	if err != nil {
		return connector.CreateRequest{}, err
	}
	name, err := requiredString(object, "name")
	if err != nil {
		return connector.CreateRequest{}, err
	}
	destinationRef, err := requiredString(object, "destinationRef")
	if err != nil {
		return connector.CreateRequest{}, err
	}
	enabled, err := optionalBoolean(object, "enabled", true)
	if err != nil {
		return connector.CreateRequest{}, err
	}
	includeBody, err := optionalBoolean(object, "includeBody", false)
	if err != nil {
		return connector.CreateRequest{}, err
	}
	return connector.CreateRequest{
		ConnectorType: connectorType, Name: name, DestinationRef: destinationRef,
		Enabled: enabled, IncludeBody: includeBody,
	}, nil
}

func decodeNotificationConnectorPatch(body []byte) (connector.PatchRequest, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return connector.PatchRequest{}, err
	}
	if err := rejectUnknownJSONFields(object, "name", "destinationRef", "enabled", "includeBody"); err != nil {
		return connector.PatchRequest{}, err
	}
	name, err := requiredString(object, "name")
	if err != nil {
		return connector.PatchRequest{}, err
	}
	destinationRef, err := requiredString(object, "destinationRef")
	if err != nil {
		return connector.PatchRequest{}, err
	}
	enabled, err := requiredBoolean(object, "enabled")
	if err != nil {
		return connector.PatchRequest{}, err
	}
	includeBody, err := optionalBoolean(object, "includeBody", false)
	if err != nil {
		return connector.PatchRequest{}, err
	}
	return connector.PatchRequest{
		Name: name, DestinationRef: destinationRef, Enabled: enabled, IncludeBody: includeBody,
	}, nil
}

func decodeJSONObject(body []byte) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := decodeStrict(body, &object); err != nil {
		return nil, invalidJSON(err)
	}
	if object == nil {
		return nil, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	return object, nil
}

func rejectUnknownJSONFields(object map[string]json.RawMessage, allowed ...string) error {
	allowlist := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allowlist[name] = struct{}{}
	}
	for name := range object {
		if _, ok := allowlist[name]; !ok {
			return invalid("request.invalid", "未知のfieldです: %s", name)
		}
	}
	return nil
}

func requiredString(object map[string]json.RawMessage, name string) (string, error) {
	raw, exists := object[name]
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", invalid("request.invalid", "%sがありません", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", invalid("request.invalid", "%sは文字列で指定してください", name)
	}
	return value, nil
}

func requiredBoolean(object map[string]json.RawMessage, name string) (bool, error) {
	raw, exists := object[name]
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, invalid("request.invalid", "%sがありません", name)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, invalid("request.invalid", "%sはbooleanで指定してください", name)
	}
	return value, nil
}

func optionalBoolean(object map[string]json.RawMessage, name string, fallback bool) (bool, error) {
	raw, exists := object[name]
	if !exists {
		return fallback, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, invalid("request.invalid", "%sはnullにできません", name)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, invalid("request.invalid", "%sはbooleanで指定してください", name)
	}
	return value, nil
}

func mapNotificationAdministrationError(err error) error {
	if err == nil {
		return nil
	}
	var notificationError *notification.Error
	if errors.As(err, &notificationError) {
		return mapAdministrativeDomainError(
			notificationError.Kind, notificationError.Code, notificationError.Detail,
		)
	}
	var connectorError *connector.Error
	if errors.As(err, &connectorError) {
		return mapAdministrativeDomainError(connectorError.Kind, connectorError.Code, connectorError.Detail)
	}
	return mapAdminError(err)
}

func mapAdministrativeDomainError(kind any, code, detail string) error {
	status := http.StatusInternalServerError
	switch fmt.Sprint(kind) {
	case "bad_request":
		status = http.StatusBadRequest
	case "not_found":
		status = http.StatusNotFound
	case "conflict":
		status = http.StatusConflict
	case "precondition_failed":
		status = http.StatusPreconditionFailed
	}
	return NewAPIError(status, "/problems/"+code, code, detail)
}
