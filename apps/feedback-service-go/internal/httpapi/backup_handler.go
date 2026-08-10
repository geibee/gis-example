package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"strconv"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
)

const maximumBackupPolicyRequestBytes = 1024 * 1024

func (handler *APIHandler) GetFeedbackBackupPolicy(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.GetFeedbackBackupPolicyParams,
) {
	if handler.backups == nil {
		handler.Unimplemented.GetFeedbackBackupPolicy(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.backups.GetPolicy(request.Context(), principal, backup.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	})
	if err != nil {
		WriteError(writer, request, mapBackupError(err))
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.View, nil)
}

func (handler *APIHandler) PatchFeedbackBackupPolicy(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.PatchFeedbackBackupPolicyParams,
) {
	if handler.backups == nil {
		handler.Unimplemented.PatchFeedbackBackupPolicy(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.backups.PatchPolicy(
		request.Context(), principal,
		backup.WorkspaceInput{
			ApplicationKey:       string(params.ApplicationKey),
			ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
			RequestID:            RequestIDFromContext(request.Context()),
		},
		func() (backup.Policy, int, error) {
			version, parseErr := ParseRequiredETag(string(params.IfMatch))
			if parseErr != nil {
				return backup.Policy{}, 0, parseErr
			}
			body, readErr := readBoundedBody(request.Body, maximumBackupPolicyRequestBytes)
			if readErr != nil {
				return backup.Policy{}, 0, readErr
			}
			policy, decodeErr := decodeBackupPolicy(body)
			return policy, version, decodeErr
		},
	)
	if err != nil {
		WriteError(writer, request, mapBackupError(err))
		return
	}
	if err := handler.recordMutation(
		request, result.Scope, principal.Subject, "backup-policy.patch", "backup-policy", result.Scope.WorkspaceID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("ETag", formatETag(result.Version))
	respondJSONOrError(writer, request, http.StatusOK, result.View, nil)
}

func (handler *APIHandler) ListFeedbackBackups(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.ListFeedbackBackupsParams,
) {
	if handler.backups == nil {
		handler.Unimplemented.ListFeedbackBackups(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
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
	result, err := handler.backups.List(request.Context(), principal, backup.ListInput{
		WorkspaceInput: backup.WorkspaceInput{
			ApplicationKey:       string(params.ApplicationKey),
			ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
			RequestID:            RequestIDFromContext(request.Context()),
		},
		Limit: limit, Cursor: cursor,
	})
	respondJSONOrError(writer, request, http.StatusOK, result, mapBackupError(err))
}

func (handler *APIHandler) GetFeedbackBackup(
	writer http.ResponseWriter,
	request *http.Request,
	backupID contract.BackupID,
) {
	if handler.backups == nil {
		handler.Unimplemented.GetFeedbackBackup(writer, request, backupID)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.backups.Get(
		request.Context(), principal, backupID.String(), RequestIDFromContext(request.Context()),
	)
	respondJSONOrError(writer, request, http.StatusOK, result, mapBackupError(err))
}

func (handler *APIHandler) DownloadFeedbackBackup(
	writer http.ResponseWriter,
	request *http.Request,
	backupID contract.BackupID,
) {
	if handler.backups == nil {
		handler.Unimplemented.DownloadFeedbackBackup(writer, request, backupID)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	id := backupID.String()
	stored, scope, err := handler.backups.Download(
		request.Context(), principal, id, RequestIDFromContext(request.Context()),
	)
	if err != nil {
		WriteError(writer, request, mapBackupError(err))
		return
	}
	if err := handler.recordMutation(request, scope, principal.Subject, "backup.read", "backup", id); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": stored.FileName}))
	writer.Header().Set("Content-Type", stored.ContentType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(stored.Bytes)))
	writer.Header().Set("ETag", `"sha256:`+stored.SHA256+`"`)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(stored.Bytes)
}

func (handler *APIHandler) RetryFeedbackBackup(
	writer http.ResponseWriter,
	request *http.Request,
	backupID contract.BackupID,
	params contract.RetryFeedbackBackupParams,
) {
	if handler.backups == nil {
		handler.Unimplemented.RetryFeedbackBackup(writer, request, backupID, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	id := backupID.String()
	result, err := handler.backups.Retry(request.Context(), principal, backup.WorkspaceInput{
		ApplicationKey:       string(params.ApplicationKey),
		ExternalWorkspaceKey: string(params.ExternalWorkspaceKey),
		RequestID:            RequestIDFromContext(request.Context()),
	}, id)
	if err != nil {
		WriteError(writer, request, mapBackupError(err))
		return
	}
	if err := handler.recordMutation(request, result.Scope, principal.Subject, "backup.retry", "backup", id); err != nil {
		WriteError(writer, request, err)
		return
	}
	respondJSONOrError(writer, request, http.StatusOK, result.Value, nil)
}

func decodeBackupPolicy(body []byte) (backup.Policy, error) {
	object, err := decodeJSONObject(body)
	if err != nil {
		return backup.Policy{}, err
	}
	if err := rejectUnknownJSONFields(
		object, "enabled", "timezone", "fullBackupAt", "incrementalIntervalMinutes", "includeEvidence", "retentionDays",
	); err != nil {
		return backup.Policy{}, err
	}
	result := backup.DefaultPolicy()
	if raw, exists := object["enabled"]; exists {
		result.Enabled, err = decodeJSONBoolean(raw, "enabled")
	}
	if err == nil {
		if raw, exists := object["timezone"]; exists {
			result.Timezone, err = decodeJSONString(raw, "timezone")
		}
	}
	if err == nil {
		if raw, exists := object["fullBackupAt"]; exists {
			result.FullBackupAt, err = decodeJSONString(raw, "fullBackupAt")
		}
	}
	if err == nil {
		if raw, exists := object["incrementalIntervalMinutes"]; exists {
			result.IncrementalIntervalMinutes, err = decodeJSONInteger(raw, "incrementalIntervalMinutes")
		}
	}
	if err == nil {
		if raw, exists := object["includeEvidence"]; exists {
			result.IncludeEvidence, err = decodeJSONBoolean(raw, "includeEvidence")
		}
	}
	if err == nil {
		if raw, exists := object["retentionDays"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			var value int
			value, err = decodeJSONInteger(raw, "retentionDays")
			result.RetentionDays = &value
		}
	}
	if err != nil {
		return backup.Policy{}, err
	}
	return result, nil
}

func decodeJSONString(raw json.RawMessage, name string) (string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", invalid("request.invalid", "%sはnullにできません", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", invalid("request.invalid", "%sは文字列で指定してください", name)
	}
	return value, nil
}

func decodeJSONBoolean(raw json.RawMessage, name string) (bool, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, invalid("request.invalid", "%sはnullにできません", name)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, invalid("request.invalid", "%sはbooleanで指定してください", name)
	}
	return value, nil
}

func decodeJSONInteger(raw json.RawMessage, name string) (int, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, invalid("request.invalid", "%sはnullにできません", name)
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, invalid("request.invalid", "%sは整数で指定してください", name)
	}
	return value, nil
}

func mapBackupError(err error) error {
	if err == nil {
		return nil
	}
	var domainError *backup.Error
	if !errors.As(err, &domainError) {
		return mapPhase2Error(err)
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, backup.ErrInvalid):
		status = http.StatusBadRequest
	case errors.Is(err, backup.ErrStorageUnavailable), errors.Is(err, backup.ErrIntegrity):
		status = http.StatusServiceUnavailable
	}
	return NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
}
