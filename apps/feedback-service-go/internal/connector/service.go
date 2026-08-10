package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

var hostPattern = regexp.MustCompile(`^[a-z0-9.-]{1,253}$`)

type Service struct {
	store          Store
	cipher         *cryptoutil.Cipher
	allowLocalHTTP bool
}

func NewService(store Store, cipher *cryptoutil.Cipher, allowLocalHTTP bool) (*Service, error) {
	if store == nil || cipher == nil {
		return nil, errors.New("connector service依存が未設定です")
	}
	return &Service{store: store, cipher: cipher, allowLocalHTTP: allowLocalHTTP}, nil
}

func (s *Service) ListTypes(ctx context.Context) ([]ConnectorType, error) {
	return s.store.ListConnectorTypes(ctx)
}

func (s *Service) List(ctx context.Context, scope auth.ResourceScope) ([]NotificationConnector, error) {
	return s.store.ListNotificationConnectors(ctx, scope)
}

func (s *Service) Create(ctx context.Context, scope auth.ResourceScope, request CreateRequest) (NotificationConnector, error) {
	if err := validateCreate(request); err != nil {
		return NotificationConnector{}, err
	}
	return s.store.CreateNotificationConnector(ctx, scope, request)
}

func (s *Service) Patch(ctx context.Context, scope auth.ResourceScope, id string, expectedVersion int, request PatchRequest) (NotificationConnector, error) {
	if _, err := uuid.Parse(id); err != nil || expectedVersion < 1 {
		return NotificationConnector{}, domainError(ErrorBadRequest, "request.invalid", "connector IDまたはversionが不正です")
	}
	if err := validateNameRef(request.Name, request.DestinationRef); err != nil {
		return NotificationConnector{}, err
	}
	return s.store.PatchNotificationConnector(ctx, scope, id, expectedVersion, request)
}

func (s *Service) Delete(ctx context.Context, scope auth.ResourceScope, id string, expectedVersion int) error {
	if _, err := uuid.Parse(id); err != nil || expectedVersion < 1 {
		return domainError(ErrorBadRequest, "request.invalid", "connector IDまたはversionが不正です")
	}
	return s.store.DeleteNotificationConnector(ctx, scope, id, expectedVersion)
}

func (s *Service) Register(ctx context.Context, input InstallationInput) error {
	validated, err := s.validateInstallation(input)
	if err != nil {
		return err
	}
	return s.store.RegisterConnectorInstallation(ctx, validated, s.cipher)
}

func (s *Service) validateInstallation(input InstallationInput) (ValidatedInstallation, error) {
	if !validKey(input.ConnectorKey, 100) || !validKey(input.DisplayName, 200) {
		return ValidatedInstallation{}, errors.New("connector key/displayNameが不正です")
	}
	urls := []string{input.ManifestURL, input.DeliveryURL, input.HealthURL}
	hosts := append([]string(nil), input.AllowedHosts...)
	for _, raw := range urls {
		if err := ValidateInternalURL(raw, s.allowLocalHTTP); err != nil {
			return ValidatedInstallation{}, err
		}
		host, _ := URLHost(raw)
		hosts = append(hosts, host)
	}
	if javaStringLength(input.SigningSecret) < 32 {
		return ValidatedInstallation{}, errors.New("connector signing secretは32文字以上必要です")
	}
	events, err := validateEvents(input.SupportedEvents)
	if err != nil {
		return ValidatedInstallation{}, err
	}
	uniqueHosts := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if !hostPattern.MatchString(host) {
			return ValidatedInstallation{}, errors.New("allowedHostsが不正です")
		}
		uniqueHosts[host] = struct{}{}
	}
	hosts = hosts[:0]
	for host := range uniqueHosts {
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	for _, destinationRef := range input.LegacyDestinationRefs {
		if !validKey(destinationRef, 200) {
			return ValidatedInstallation{}, errors.New("legacyDestinationRefが不正です")
		}
	}
	encrypted, err := s.cipher.EncryptString(input.SigningSecret)
	if err != nil {
		return ValidatedInstallation{}, err
	}
	return ValidatedInstallation{
		ID: uuid.NewString(), ConnectorKey: input.ConnectorKey, DisplayName: input.DisplayName,
		ManifestURL: input.ManifestURL, DeliveryURL: input.DeliveryURL, HealthURL: input.HealthURL,
		AllowedHosts: hosts, EncryptedSecret: encrypted, SupportedEvents: events,
		Enabled: input.Enabled, LegacyDestinationRefs: cloneMap(input.LegacyDestinationRefs),
	}, nil
}

func validateCreate(request CreateRequest) error {
	if !validKey(request.ConnectorType, 100) {
		return domainError(ErrorBadRequest, "request.invalid", "connectorTypeが不正です")
	}
	return validateNameRef(request.Name, request.DestinationRef)
}

func validateNameRef(name, destinationRef string) error {
	if !validKey(strings.TrimSpace(name), 200) || !validKey(strings.TrimSpace(destinationRef), 200) {
		return domainError(ErrorBadRequest, "request.invalid", "nameまたはdestinationRefが不正です")
	}
	return nil
}

func validKey(value string, maximum int) bool {
	return strings.TrimSpace(value) != "" && javaStringLength(strings.TrimSpace(value)) <= maximum
}

func validateEvents(events []string) ([]string, error) {
	if len(events) == 0 {
		return nil, errors.New("supportedEventsは1件以上必要です")
	}
	set := make(map[string]struct{}, len(events))
	for _, event := range events {
		if _, ok := supportedEventSet[event]; !ok {
			return nil, errors.New("supportedEventsに未対応のeventがあります")
		}
		set[event] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for event := range set {
		result = append(result, event)
	}
	sort.Strings(result)
	return result, nil
}

func cloneMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func FetchManifest(ctx context.Context, descriptorURL string, client *http.Client, allowLocalHTTP bool) (ManifestV1, error) {
	if err := ValidateInternalURL(descriptorURL, allowLocalHTTP); err != nil {
		return ManifestV1{}, err
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, descriptorURL, nil)
	if err != nil {
		return ManifestV1{}, err
	}
	response, err := secureNoRedirectClient(client, EndpointPolicy{
		AllowLocalHTTP: allowLocalHTTP, AllowPrivateNetwork: true,
	}).Do(request)
	if err != nil {
		return ManifestV1{}, fmt.Errorf("connector descriptor transport error (%T)", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ManifestV1{}, fmt.Errorf("connector descriptorの取得に失敗しました: HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(raw) > 256*1024 {
		return ManifestV1{}, errors.New("connector descriptorが不正です")
	}
	manifest := ManifestV1{
		Kind: "manifest", ProtocolVersion: ProtocolVersion,
		CompatibleProtocolVersions: []string{ProtocolVersion}, HealthPath: "/health/ready",
	}
	if err := decodeStrict(raw, &manifest); err != nil {
		return ManifestV1{}, fmt.Errorf("connector descriptorが不正です: %w", err)
	}
	for _, field := range []string{"connectorKey", "displayName", "supportedEvents"} {
		if !jsonNonNullFieldPresent(raw, field) {
			return ManifestV1{}, fmt.Errorf("connector descriptorに%sがありません", field)
		}
	}
	for _, field := range []string{"kind", "protocolVersion", "compatibleProtocolVersions", "healthPath"} {
		if jsonFieldPresent(raw, field) && !jsonNonNullFieldPresent(raw, field) {
			return ManifestV1{}, fmt.Errorf("connector descriptorの%sがnullです", field)
		}
	}
	return manifest, nil
}

func ValidateManifest(connectorKey string, configuredEvents []string, descriptor ManifestV1) error {
	compatible := false
	for _, version := range descriptor.CompatibleProtocolVersions {
		if version == ProtocolVersion {
			compatible = true
		}
	}
	if descriptor.Kind != "manifest" || descriptor.ProtocolVersion != ProtocolVersion || !compatible {
		return errors.New("connector protocolVersion 1との互換性が必要です")
	}
	if descriptor.ConnectorKey != connectorKey {
		return errors.New("connector keyがdescriptorと一致しません")
	}
	available := make(map[string]struct{}, len(descriptor.SupportedEvents))
	for _, event := range descriptor.SupportedEvents {
		available[event] = struct{}{}
	}
	if len(configuredEvents) == 0 {
		return errors.New("configured eventは1件以上必要です")
	}
	for _, event := range configuredEvents {
		if _, ok := available[event]; !ok {
			return errors.New("configured eventがdescriptorでサポートされていません")
		}
	}
	return nil
}

// MarshalManifestは別process smokeでprotocol schemaを固定する。
func MarshalManifest(manifest ManifestV1) ([]byte, error) { return json.Marshal(manifest) }
