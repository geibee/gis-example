package httpapi

import (
	"bytes"
	"errors"
	"net/http"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
)

const maximumRetentionPolicyRequestBytes = 1024 * 1024

func (handler *APIHandler) GetFeedbackRetentionPolicy(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.GetFeedbackRetentionPolicyParams,
) {
	if handler.retention == nil {
		handler.Unimplemented.GetFeedbackRetentionPolicy(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.retention.GetPolicy(request.Context(), principal, retention.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapRetentionError(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.Policy, nil)
}

func (handler *APIHandler) PatchFeedbackRetentionPolicy(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.PatchFeedbackRetentionPolicyParams,
) {
	if handler.retention == nil {
		handler.Unimplemented.PatchFeedbackRetentionPolicy(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.retention.PatchPolicy(
		request.Context(), principal,
		retention.WorkspaceInput{
			ApplicationKey:       string(params.ApplicationKey),
			ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
			RequestID:            RequestIDFromContext(request.Context()),
		},
		func() (retention.Policy, int, error) {
			version, parseErr := ParseRequiredETag(string(params.IfMatch))
			if parseErr != nil {
				return retention.Policy{}, 0, parseErr
			}
			body, readErr := readBoundedBody(request.Body, maximumRetentionPolicyRequestBytes)
			if readErr != nil {
				return retention.Policy{}, 0, readErr
			}
			policy, decodeErr := decodeRetentionPolicy(body)
			return policy, version, decodeErr
		},
	)
	if err != nil {
		WriteError(writer, request, mapRetentionError(err))
		return
	}
	if err := handler.recordMutation(
		request, result.Scope, principal.Subject,
		"retention.patch", "retention-policy", result.Scope.WorkspaceID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.Policy, nil)
}

func decodeRetentionPolicy(body []byte) (retention.Policy, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return retention.Policy{}, err
	}
	if err := rejectUnknownJSONFields(object, "evidenceRetentionDays", "exportRetentionDays"); err != nil {
		return retention.Policy{}, err
	}
	evidenceRaw, exists := object["evidenceRetentionDays"]
	if !exists {
		return retention.Policy{}, invalid("request.invalid", "evidenceRetentionDaysがありません")
	}
	policy := retention.DefaultPolicy()
	if !bytes.Equal(bytes.TrimSpace(evidenceRaw), []byte("null")) {
		value, decodeErr := decodeJSONInteger(evidenceRaw, "evidenceRetentionDays")
		if decodeErr != nil {
			return retention.Policy{}, decodeErr
		}
		policy.EvidenceRetentionDays = &value
	}
	if exportRaw, exists := object["exportRetentionDays"]; exists {
		policy.ExportRetentionDays, err = decodeJSONInteger(exportRaw, "exportRetentionDays")
		if err != nil {
			return retention.Policy{}, err
		}
	}
	return policy, nil
}

func mapRetentionError(err error) error {
	if err == nil {
		return nil
	}
	var domainError *retention.Error
	if !errors.As(err, &domainError) {
		return mapPhase2Error(err)
	}
	status := http.StatusInternalServerError
	if errors.Is(err, retention.ErrInvalid) {
		status = http.StatusBadRequest
	}
	return NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
}
