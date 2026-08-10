package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const maximumSessionRequestBytes = 4 * 1024 * 1024

func (handler *APIHandler) ListFeedbackSessions(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackSessionsParams,
) {
	if handler.sessions == nil {
		handler.Unimplemented.ListFeedbackSessions(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	status := optionalEnum(params.Status)
	var limit *int
	if params.Limit != nil {
		value := int(*params.Limit)
		limit = &value
	}
	var cursor *string
	if params.Cursor != nil {
		value := string(*params.Cursor)
		cursor = &value
	}
	result, err := handler.sessions.List(request.Context(), principal, session.ListInput{
		ApplicationKey: string(params.ApplicationKey), EnvironmentKey: string(params.EnvironmentKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey), Status: status,
		Limit: limit, Cursor: cursor, RequestID: RequestIDFromContext(request.Context()),
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapPhase2Error(err))
}

func (handler *APIHandler) CreateFeedbackSession(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.CreateFeedbackSessionParams,
) {
	if handler.sessions == nil {
		handler.Unimplemented.CreateFeedbackSession(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	body, err := readBoundedBody(request.Body, maximumSessionRequestBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	input, err := decodeSessionCreate(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	requestHash, err := CanonicalJSONSHA256(body)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	requestID := RequestIDFromContext(request.Context())
	result, err := handler.sessions.Create(request.Context(), principal, requestID, session.CreateCommand{
		Request: input, IdempotencyKey: string(params.IdempotencyKey), RequestHash: requestHash,
	})
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	if err := handler.recordMutation(
		request, result.Scope, principal.Subject, "session.create", "session", result.Session.ID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Session.Version))
	respondJSONOrError(writer, request, http.StatusCreated, result.Session, nil)
}

func (handler *APIHandler) GetFeedbackSession(
	writer http.ResponseWriter,
	request *http.Request,
	sessionID contract.SessionID,
) {
	if handler.sessions == nil {
		handler.Unimplemented.GetFeedbackSession(writer, request, sessionID)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.sessions.Get(
		request.Context(), principal, sessionID.String(), RequestIDFromContext(request.Context()),
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result, nil)
}

func (handler *APIHandler) PatchFeedbackSession(
	writer http.ResponseWriter,
	request *http.Request,
	sessionID contract.SessionID,
	params contract.PatchFeedbackSessionParams,
) {
	if handler.sessions == nil {
		handler.Unimplemented.PatchFeedbackSession(writer, request, sessionID, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	requestID := RequestIDFromContext(request.Context())
	result, err := handler.sessions.Patch(
		request.Context(), principal, sessionID.String(), requestID,
		func() (session.Patch, error) {
			body, readErr := readBoundedBody(request.Body, maximumSessionRequestBytes)
			if readErr != nil {
				return session.Patch{}, readErr
			}
			version, parseErr := ParseRequiredETag(string(params.IfMatch))
			if parseErr != nil {
				return session.Patch{}, parseErr
			}
			return decodeSessionPatch(body, version)
		},
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	if err := handler.recordMutation(
		request, result.Scope, principal.Subject, "session.patch", "session", result.Session.ID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Session.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.Session, nil)
}

func (handler *APIHandler) recordMutation(
	request *http.Request,
	scope auth.ResourceScope,
	principalID string,
	action string,
	resourceType string,
	resourceID string,
) error {
	if handler.auditor == nil {
		return errors.New("mutation auditorが未設定です")
	}
	if err := handler.auditor.RecordAudit(request.Context(), usecase.AuditEvent{
		Scope: &scope, PrincipalID: principalID, Action: action,
		ResourceType: resourceType, ResourceID: resourceID, Outcome: "succeeded",
		RequestID: RequestIDFromContext(request.Context()),
	}); err != nil {
		return fmt.Errorf("成功監査を記録できません: %w", err)
	}
	return nil
}

type sessionCreateWire struct {
	ApplicationKey       string                    `json:"applicationKey"`
	EnvironmentKey       string                    `json:"environmentKey"`
	ExternalWorkspaceKey string                    `json:"externalWorkspaceKey"`
	ManifestVersion      string                    `json:"manifestVersion"`
	Title                string                    `json:"title"`
	Description          *string                   `json:"description"`
	Status               *string                   `json:"status"`
	OutOfScopePosting    *string                   `json:"outOfScopePosting"`
	StartAt              *string                   `json:"startAt"`
	EndAt                *string                   `json:"endAt"`
	Scopes               *[]sessionScopeWire       `json:"scopes"`
	Perspectives         *[]sessionPerspectiveWire `json:"perspectives"`
}

type sessionScopeWire struct {
	PageKey          *string   `json:"pageKey"`
	RouteTemplate    *string   `json:"routeTemplate"`
	Reviewable       *bool     `json:"reviewable"`
	PerspectiveCodes *[]string `json:"perspectiveCodes"`
}

type sessionPerspectiveWire struct {
	Code     *string `json:"code"`
	Label    *string `json:"label"`
	Status   *string `json:"status"`
	Guidance *string `json:"guidance"`
}

func decodeSessionCreate(body []byte) (session.CreateRequest, error) {
	var raw map[string]json.RawMessage
	if err := decodeStrict(body, &raw); err != nil {
		return session.CreateRequest{}, invalidJSON(err)
	}
	if raw == nil {
		return session.CreateRequest{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire sessionCreateWire
	if err := decodeStrict(body, &wire); err != nil {
		return session.CreateRequest{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	for _, key := range []string{"applicationKey", "environmentKey", "externalWorkspaceKey", "manifestVersion", "title"} {
		if value, exists := raw[key]; !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return session.CreateRequest{}, invalid("request.invalid", "%sがありません", key)
		}
	}
	posting := session.OutOfScopeWarn
	if value, exists := raw["outOfScopePosting"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.OutOfScopePosting == nil {
			return session.CreateRequest{}, invalid("request.invalid", "outOfScopePostingが不正です")
		}
		posting = *wire.OutOfScopePosting
	}
	status := session.StatusDraft
	if value, exists := raw["status"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.Status == nil {
			return session.CreateRequest{}, invalid("request.invalid", "statusが不正です")
		}
		status = *wire.Status
	}
	scopes := []session.Scope{}
	if value, exists := raw["scopes"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.Scopes == nil {
			return session.CreateRequest{}, invalid("request.invalid", "scopesは配列で指定してください")
		}
		for _, item := range *wire.Scopes {
			if item.PageKey == nil || item.Reviewable == nil {
				return session.CreateRequest{}, invalid("request.invalid", "scopeの必須fieldがありません")
			}
			scopes = append(scopes, session.Scope{
				PageKey: *item.PageKey, RouteTemplate: item.RouteTemplate, Reviewable: *item.Reviewable,
				PerspectiveCodes: optionalStringSlice(item.PerspectiveCodes),
			})
		}
	}
	perspectives := []session.Perspective{}
	if value, exists := raw["perspectives"]; exists {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || wire.Perspectives == nil {
			return session.CreateRequest{}, invalid("request.invalid", "perspectivesは配列で指定してください")
		}
		for _, item := range *wire.Perspectives {
			if item.Code == nil || item.Label == nil || item.Status == nil {
				return session.CreateRequest{}, invalid("request.invalid", "perspectiveの必須fieldがありません")
			}
			perspectives = append(perspectives, session.Perspective{
				Code: *item.Code, Label: *item.Label, Status: *item.Status, Guidance: item.Guidance,
			})
		}
	}
	return session.CreateRequest{
		ApplicationKey: wire.ApplicationKey, EnvironmentKey: wire.EnvironmentKey,
		ExternalWorkspaceKey: wire.ExternalWorkspaceKey, ManifestVersion: wire.ManifestVersion,
		Title: wire.Title, Description: wire.Description, Status: status, OutOfScopePosting: posting,
		StartAt: wire.StartAt, EndAt: wire.EndAt, Scopes: scopes, Perspectives: perspectives,
	}, nil
}

func decodeSessionPatch(body []byte, expectedVersion int) (session.Patch, error) {
	var object map[string]json.RawMessage
	if err := decodeStrict(body, &object); err != nil {
		return session.Patch{}, invalidJSON(err)
	}
	if object == nil {
		return session.Patch{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	allowed := map[string]struct{}{
		"title": {}, "description": {}, "status": {}, "outOfScopePosting": {}, "startAt": {}, "endAt": {},
		"scopes": {}, "perspectives": {},
	}
	for key := range object {
		if _, ok := allowed[key]; !ok {
			return session.Patch{}, invalid("request.invalid", "PATCH bodyに未知fieldがあります")
		}
	}
	if len(object) == 0 {
		return session.Patch{}, invalid("request.invalid", "PATCH bodyが空です")
	}
	patch := session.Patch{ExpectedVersion: expectedVersion}
	var err error
	if value, ok := object["title"]; ok {
		patch.Title, err = decodeRequiredPatchString(value, "title")
	}
	if err == nil {
		if value, ok := object["description"]; ok {
			patch.Description = session.OptionalString{Present: true}
			patch.Description.Value, err = decodeNullablePatchString(value, "description")
		}
	}
	if err == nil {
		if value, ok := object["status"]; ok {
			patch.Status, err = decodeRequiredPatchString(value, "status")
		}
	}
	if err == nil {
		if value, ok := object["outOfScopePosting"]; ok {
			patch.OutOfScopePosting, err = decodeRequiredPatchString(value, "outOfScopePosting")
		}
	}
	if err == nil {
		if value, ok := object["startAt"]; ok {
			patch.StartAt = session.OptionalString{Present: true}
			patch.StartAt.Value, err = decodeNullablePatchString(value, "startAt")
		}
	}
	if err == nil {
		if value, ok := object["endAt"]; ok {
			patch.EndAt = session.OptionalString{Present: true}
			patch.EndAt.Value, err = decodeNullablePatchString(value, "endAt")
		}
	}
	if err == nil {
		if value, ok := object["scopes"]; ok {
			var wire []sessionScopeWire
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || decodeStrict(value, &wire) != nil {
				err = invalid("request.invalid", "scopesは配列で指定してください")
			} else {
				scopes := make([]session.Scope, 0, len(wire))
				for _, item := range wire {
					if item.PageKey == nil || item.Reviewable == nil {
						err = invalid("request.invalid", "scopeの必須fieldがありません")
						break
					}
					scopes = append(scopes, session.Scope{
						PageKey: *item.PageKey, RouteTemplate: item.RouteTemplate, Reviewable: *item.Reviewable,
						PerspectiveCodes: optionalStringSlice(item.PerspectiveCodes),
					})
				}
				patch.Scopes = &scopes
			}
		}
	}
	if err == nil {
		if value, ok := object["perspectives"]; ok {
			var wire []sessionPerspectiveWire
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || decodeStrict(value, &wire) != nil {
				err = invalid("request.invalid", "perspectivesは配列で指定してください")
			} else {
				perspectives := make([]session.Perspective, 0, len(wire))
				for _, item := range wire {
					if item.Code == nil || item.Label == nil || item.Status == nil {
						err = invalid("request.invalid", "perspectiveの必須fieldがありません")
						break
					}
					perspectives = append(perspectives, session.Perspective{Code: *item.Code, Label: *item.Label, Status: *item.Status, Guidance: item.Guidance})
				}
				patch.Perspectives = &perspectives
			}
		}
	}
	if err != nil {
		return session.Patch{}, err
	}
	return patch, nil
}

func optionalStringSlice(value *[]string) []string {
	if value == nil {
		return []string{}
	}
	return *value
}

func decodeRequiredPatchString(raw json.RawMessage, name string) (*string, error) {
	value, err := decodeNullablePatchString(raw, name)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, invalid("request.invalid", "%sはnullにできません", name)
	}
	return value, nil
}

func decodeNullablePatchString(raw json.RawMessage, name string) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, invalid("request.invalid", "%sは文字列で指定してください", name)
	}
	return &value, nil
}

func optionalEnum[T ~string](value *T) *string {
	if value == nil {
		return nil
	}
	text := string(*value)
	return &text
}

func mapPhase2Error(err error) error {
	if err == nil {
		return nil
	}
	if mapped := mapDiscussionError(err); mapped != nil {
		return mapped
	}
	if mapped := mapEvidenceError(err); mapped != nil {
		return mapped
	}
	if mapped := mapExportError(err); mapped != nil {
		return mapped
	}
	var validationError *session.ValidationError
	if errors.As(err, &validationError) {
		return NewAPIError(
			http.StatusBadRequest, "/problems/"+validationError.Code,
			validationError.Code, validationError.Detail,
		)
	}
	return mapServiceError(err)
}
