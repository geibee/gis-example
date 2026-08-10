package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const maximumAdminRequestBytes = 4 * 1024 * 1024

func (handler *APIHandler) ListFeedbackWorkspaceMemberships(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackWorkspaceMembershipsParams,
) {
	if handler.administration == nil {
		handler.Unimplemented.ListFeedbackWorkspaceMemberships(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	members, err := handler.administration.ListMemberships(request.Context(), principal, admin.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	})
	respondJSONOrError(writer, request, http.StatusOK, members, mapAdminError(err))
}

func (handler *APIHandler) CreateFeedbackWorkspaceMembership(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.CreateFeedbackWorkspaceMembershipParams,
) {
	if handler.administration == nil {
		handler.Unimplemented.CreateFeedbackWorkspaceMembership(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	workspace := admin.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	}
	result, err := handler.administration.CreateMembership(
		request.Context(), principal, workspace,
		func() (admin.CreateCommand, error) {
			body, readErr := readBoundedBody(request.Body, maximumAdminRequestBytes)
			if readErr != nil {
				return admin.CreateCommand{}, readErr
			}
			create, decodeErr := decodeMembershipCreate(body)
			if decodeErr != nil {
				return admin.CreateCommand{}, decodeErr
			}
			hash, hashErr := CanonicalJSONSHA256(body)
			if hashErr != nil {
				return admin.CreateCommand{}, hashErr
			}
			return admin.CreateCommand{
				Request: create, IdempotencyKey: string(params.IdempotencyKey), RequestHash: hash,
			}, nil
		},
	)
	if err != nil {
		WriteError(writer, request, mapAdminError(err))
		return
	}
	if result.After == nil {
		WriteError(writer, request, errors.New("membership create responseがありません"))
		return
	}
	if err := handler.recordAdminMutation(request, principal, "membership.create", result); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.After.Version))
	respondJSONOrError(writer, request, http.StatusCreated, result.After, nil)
}

func (handler *APIHandler) PatchFeedbackWorkspaceMembership(
	writer http.ResponseWriter,
	request *http.Request,
	userID contract.UserID,
	params contract.PatchFeedbackWorkspaceMembershipParams,
) {
	if handler.administration == nil {
		handler.Unimplemented.PatchFeedbackWorkspaceMembership(writer, request, userID, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	workspace := admin.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	}
	result, err := handler.administration.PatchMembership(
		request.Context(), principal, workspace, userID.String(),
		func() (int, admin.MembershipPatch, error) {
			version, parseErr := ParseRequiredETag(string(params.IfMatch))
			if parseErr != nil {
				return 0, admin.MembershipPatch{}, parseErr
			}
			body, readErr := readBoundedBody(request.Body, maximumAdminRequestBytes)
			if readErr != nil {
				return 0, admin.MembershipPatch{}, readErr
			}
			patch, decodeErr := decodeMembershipPatch(body)
			return version, patch, decodeErr
		},
	)
	if err != nil {
		WriteError(writer, request, mapAdminError(err))
		return
	}
	if result.After == nil {
		WriteError(writer, request, errors.New("membership patch responseがありません"))
		return
	}
	if err := handler.recordAdminMutation(request, principal, "membership.patch", result); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.After.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.After, nil)
}

func (handler *APIHandler) DeleteFeedbackWorkspaceMembership(
	writer http.ResponseWriter,
	request *http.Request,
	userID contract.UserID,
	params contract.DeleteFeedbackWorkspaceMembershipParams,
) {
	if handler.administration == nil {
		handler.Unimplemented.DeleteFeedbackWorkspaceMembership(writer, request, userID, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	workspace := admin.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	}
	result, err := handler.administration.DeleteMembership(
		request.Context(), principal, workspace, userID.String(),
		func() (int, error) { return ParseRequiredETag(string(params.IfMatch)) },
	)
	if err != nil {
		WriteError(writer, request, mapAdminError(err))
		return
	}
	if err := handler.recordAdminMutation(request, principal, "membership.delete", result); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func decodeMembershipCreate(body []byte) (admin.MembershipCreate, error) {
	var object map[string]json.RawMessage
	if err := decodeStrict(body, &object); err != nil {
		return admin.MembershipCreate{}, invalidJSON(err)
	}
	if object == nil {
		return admin.MembershipCreate{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire struct {
		Issuer      string            `json:"issuer"`
		Subject     string            `json:"subject"`
		Permissions []auth.Permission `json:"permissions"`
	}
	if err := decodeStrict(body, &wire); err != nil {
		return admin.MembershipCreate{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	return admin.MembershipCreate{
		Issuer: wire.Issuer, Subject: wire.Subject, Permissions: wire.Permissions,
	}, nil
}

func decodeMembershipPatch(body []byte) (admin.MembershipPatch, error) {
	var object map[string]json.RawMessage
	if err := decodeStrict(body, &object); err != nil {
		return admin.MembershipPatch{}, invalidJSON(err)
	}
	if object == nil {
		return admin.MembershipPatch{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	raw, exists := object["permissions"]
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return admin.MembershipPatch{}, invalid("request.invalid", "permissionsがありません")
	}
	var wire struct {
		Permissions []auth.Permission `json:"permissions"`
	}
	if err := decodeStrict(body, &wire); err != nil {
		return admin.MembershipPatch{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	return admin.MembershipPatch{Permissions: wire.Permissions}, nil
}

func (handler *APIHandler) recordAdminMutation(
	request *http.Request,
	principal auth.Principal,
	action string,
	result admin.MutationResult,
) error {
	if handler.auditor == nil {
		return errors.New("mutation auditorが未設定です")
	}
	changes, err := json.Marshal(struct {
		Before *admin.Member `json:"before"`
		After  *admin.Member `json:"after"`
	}{Before: result.Before, After: result.After})
	if err != nil {
		return fmt.Errorf("membership監査差分を生成できません: %w", err)
	}
	resourceID := ""
	if result.After != nil {
		resourceID = result.After.UserID
	} else if result.Before != nil {
		resourceID = result.Before.UserID
	}
	if err := handler.auditor.RecordAudit(request.Context(), usecase.AuditEvent{
		Scope: &result.Scope, PrincipalID: principal.Subject, Action: action,
		ResourceType: "membership", ResourceID: resourceID, Outcome: "succeeded",
		RequestID: RequestIDFromContext(request.Context()), Changes: changes,
	}); err != nil {
		return fmt.Errorf("成功監査を記録できません: %w", err)
	}
	return nil
}

func mapAdminError(err error) error {
	if err == nil {
		return nil
	}
	var domainError *admin.Error
	if !errors.As(err, &domainError) {
		return mapPhase2Error(err)
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, admin.ErrInvalidInput):
		status = http.StatusBadRequest
	case errors.Is(err, admin.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, admin.ErrConflict):
		status = http.StatusConflict
	case errors.Is(err, admin.ErrVersionMismatch):
		status = http.StatusPreconditionFailed
	}
	return NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
}
