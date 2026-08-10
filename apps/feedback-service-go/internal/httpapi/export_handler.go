package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
)

const maximumExportRequestBytes int64 = 1024 * 1024

func (handler *APIHandler) CreateFeedbackExport(
	writer http.ResponseWriter,
	request *http.Request,
	params contract.CreateFeedbackExportParams,
) {
	if handler.exports == nil {
		handler.Unimplemented.CreateFeedbackExport(writer, request, params)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	body, err := readBoundedBody(request.Body, maximumExportRequestBytes)
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	command, err := decodeExportCreate(body, string(params.IdempotencyKey))
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	result, err := handler.exports.Create(
		request.Context(), principal, RequestIDFromContext(request.Context()), command,
		func(scope auth.ResourceScope) error {
			return handler.enforceDiscussionRateLimit(request, principal, scope)
		},
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	if err := handler.recordMutation(
		request, result.Scope, principal.Subject, "export.create", "export", result.Job.ID,
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	respondJSONOrError(writer, request, http.StatusAccepted, result.Job, nil)
}

func (handler *APIHandler) GetFeedbackExport(
	writer http.ResponseWriter,
	request *http.Request,
	exportID contract.ExportID,
) {
	if handler.exports == nil {
		handler.Unimplemented.GetFeedbackExport(writer, request, exportID)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	job, err := handler.exports.Get(
		request.Context(), principal, exportID.String(), RequestIDFromContext(request.Context()),
	)
	respondJSONOrError(writer, request, http.StatusOK, job, mapPhase2Error(err))
}

func (handler *APIHandler) DownloadFeedbackExport(
	writer http.ResponseWriter,
	request *http.Request,
	exportID contract.ExportID,
) {
	if handler.exports == nil {
		handler.Unimplemented.DownloadFeedbackExport(writer, request, exportID)
		return
	}
	principal, err := PrincipalFromContext(request.Context())
	if err != nil {
		WriteError(writer, request, err)
		return
	}
	stored, scope, err := handler.exports.Download(
		request.Context(), principal, exportID.String(), RequestIDFromContext(request.Context()),
	)
	if err != nil {
		WriteError(writer, request, mapPhase2Error(err))
		return
	}
	defer stored.Body.Close()
	if err := handler.recordMutation(
		request, scope, principal.Subject, "export.read", "export", exportID.String(),
	); err != nil {
		WriteError(writer, request, err)
		return
	}
	writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": stored.FileName}))
	writer.Header().Set("Content-Type", stored.ContentType)
	writer.Header().Set("Content-Length", strconv.FormatInt(stored.Size, 10))
	writer.WriteHeader(http.StatusOK)
	_ = streamStoredExport(writer, stored)
}

func streamStoredExport(writer io.Writer, stored exportdomain.Stored) error {
	if writer == nil || stored.Body == nil || stored.Size < 0 {
		return errors.New("export download streamが不正です")
	}
	written, err := io.Copy(writer, io.LimitReader(stored.Body, stored.Size))
	if err != nil {
		return err
	}
	if written != stored.Size {
		return errors.New("export download streamがmetadataより短いです")
	}
	var extra [1]byte
	count, err := io.ReadFull(stored.Body, extra[:])
	if count != 0 {
		return errors.New("export download streamがmetadataより長いです")
	}
	if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

type exportCreateWire struct {
	ApplicationKey       *string `json:"applicationKey"`
	EnvironmentKey       *string `json:"environmentKey"`
	ExternalWorkspaceKey *string `json:"externalWorkspaceKey"`
	SessionID            *string `json:"sessionId"`
	Format               *string `json:"format"`
	Locale               *string `json:"locale"`
	Timezone             *string `json:"timezone"`
}

func decodeExportCreate(body []byte, idempotencyKey string) (exportdomain.CreateCommand, error) {
	var raw map[string]json.RawMessage
	if err := decodeStrict(body, &raw); err != nil {
		return exportdomain.CreateCommand{}, invalidJSON(err)
	}
	if raw == nil {
		return exportdomain.CreateCommand{}, invalidJSON(errors.New("JSON objectを指定してください"))
	}
	var wire exportCreateWire
	if err := decodeStrict(body, &wire); err != nil {
		return exportdomain.CreateCommand{}, invalid("request.invalid", "request bodyが不正です: %v", err)
	}
	for _, name := range []string{"applicationKey", "environmentKey", "externalWorkspaceKey", "format"} {
		value, exists := raw[name]
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return exportdomain.CreateCommand{}, invalid("request.invalid", "%sがありません", name)
		}
	}
	if wire.ApplicationKey == nil || wire.EnvironmentKey == nil || wire.ExternalWorkspaceKey == nil || wire.Format == nil {
		return exportdomain.CreateCommand{}, invalid("request.invalid", "request bodyの必須fieldが不正です")
	}
	for _, name := range []string{"locale", "timezone"} {
		if value, exists := raw[name]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return exportdomain.CreateCommand{}, invalid("request.invalid", "%sが不正です", name)
		}
	}
	locale := "ja-JP"
	if wire.Locale != nil {
		locale = *wire.Locale
	}
	timezone := "Asia/Tokyo"
	if wire.Timezone != nil {
		timezone = *wire.Timezone
	}
	hash, err := CanonicalJSONSHA256(body)
	if err != nil {
		return exportdomain.CreateCommand{}, err
	}
	return exportdomain.CreateCommand{
		Request: exportdomain.Request{
			ApplicationKey: *wire.ApplicationKey, EnvironmentKey: *wire.EnvironmentKey,
			ExternalWorkspaceKey: *wire.ExternalWorkspaceKey, SessionID: wire.SessionID,
			Format: *wire.Format, Locale: locale, Timezone: timezone,
		},
		IdempotencyKey: idempotencyKey, RequestHash: hash,
	}, nil
}

func mapExportError(err error) error {
	var domainError *exportdomain.Error
	if !errors.As(err, &domainError) {
		return nil
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, exportdomain.ErrInvalid):
		status = http.StatusBadRequest
	case errors.Is(err, exportdomain.ErrStorageUnavailable):
		status = http.StatusServiceUnavailable
	}
	return NewAPIError(status, "/problems/"+domainError.Code, domainError.Code, domainError.Detail)
}
