package notification

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

type Service struct {
	store          AdminStore
	cipher         *cryptoutil.Cipher
	allowLocalHTTP bool
}

func NewService(store AdminStore, cipher *cryptoutil.Cipher, allowLocalHTTP bool) (*Service, error) {
	if store == nil || cipher == nil {
		return nil, errors.New("notification service依存が未設定です")
	}
	return &Service{store: store, cipher: cipher, allowLocalHTTP: allowLocalHTTP}, nil
}

func (s *Service) GetSettings(ctx context.Context, scope auth.ResourceScope) (SettingsView, error) {
	stored, err := s.store.GetNotificationSettings(ctx, scope)
	if err != nil {
		return SettingsView{}, err
	}
	return s.decodeSettings(stored)
}

func (s *Service) PatchSettings(
	ctx context.Context,
	scope auth.ResourceScope,
	expectedVersion int,
	settings Settings,
) (SettingsView, error) {
	if expectedVersion < 1 {
		return SettingsView{}, domainError(ErrorBadRequest, "request.invalid", "versionが不正です")
	}
	if err := validateSettings(settings, s.allowLocalHTTP); err != nil {
		return SettingsView{}, err
	}
	var ciphertext, nonce []byte
	if settings.WebhookEndpoint != nil {
		encrypted, err := s.cipher.EncryptString(*settings.WebhookEndpoint)
		if err != nil {
			return SettingsView{}, err
		}
		ciphertext, nonce = encrypted.Ciphertext, encrypted.Nonce
	}
	stored, err := s.store.PatchNotificationSettings(ctx, scope, expectedVersion, SettingsUpdate{
		WebhookEnabled: settings.WebhookEnabled, EndpointCiphertext: ciphertext, EndpointNonce: nonce,
		IncludeBody: settings.IncludeBody, IncludeEvidence: settings.IncludeEvidence,
	})
	if err != nil {
		return SettingsView{}, err
	}
	return s.decodeSettings(stored)
}

func (s *Service) ListDeliveries(ctx context.Context, input ListInput) ([]Delivery, error) {
	if input.Limit < 1 || input.Limit > 200 {
		return nil, domainError(ErrorBadRequest, "request.invalid", "limitは1..200です")
	}
	if input.Status != nil {
		if _, ok := map[string]struct{}{"pending": {}, "processing": {}, "delivered": {}, "failed": {}}[*input.Status]; !ok {
			return nil, domainError(ErrorBadRequest, "request.invalid", "notification statusが不正です")
		}
	}
	if input.ConnectorID != nil {
		if _, err := uuid.Parse(*input.ConnectorID); err != nil {
			return nil, domainError(ErrorBadRequest, "request.invalid", "connectorIdが不正です")
		}
	}
	return s.store.ListNotificationDeliveries(ctx, input)
}

func (s *Service) Retry(ctx context.Context, scope auth.ResourceScope, id string) (Delivery, error) {
	if _, err := uuid.Parse(id); err != nil {
		return Delivery{}, domainError(ErrorBadRequest, "request.invalid", "delivery IDが不正です")
	}
	return s.store.RetryNotificationDelivery(ctx, scope, id)
}

func (s *Service) decodeSettings(stored StoredSettings) (SettingsView, error) {
	settings := Settings{
		WebhookEnabled: stored.WebhookEnabled, IncludeBody: stored.IncludeBody,
		IncludeEvidence: stored.IncludeEvidence,
	}
	if len(stored.EndpointCiphertext) != 0 {
		endpoint, err := s.cipher.DecryptString(stored.EndpointCiphertext, stored.EndpointNonce)
		if err != nil {
			return SettingsView{}, err
		}
		settings.WebhookEndpoint = &endpoint
	}
	return SettingsView{Settings: settings, Version: stored.Version}, nil
}

func validateSettings(settings Settings, allowLocalHTTP bool) error {
	if settings.WebhookEnabled && settings.WebhookEndpoint == nil {
		return domainError(ErrorBadRequest, "request.invalid", "webhookEnabled=trueではendpointが必要です")
	}
	if settings.WebhookEndpoint == nil {
		return nil
	}
	endpoint, err := url.Parse(*settings.WebhookEndpoint)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" ||
		(endpoint.Scheme != "https" && !(allowLocalHTTP && endpoint.Scheme == "http")) || strings.TrimSpace(*settings.WebhookEndpoint) == "" {
		return domainError(ErrorBadRequest, "request.invalid", "webhookEndpointはuserinfo/fragmentを含まないhttps URLで指定してください")
	}
	return nil
}
