package connector

import (
	"context"
	"encoding/json"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

const ProtocolVersion = "1"

var SupportedEvents = []string{
	"feedback.thread.created.v1",
	"feedback.message.created.v1",
	"feedback.thread.resolved.v1",
	"feedback.thread.reopened.v1",
}

var supportedEventSet = func() map[string]struct{} {
	values := make(map[string]struct{}, len(SupportedEvents))
	for _, event := range SupportedEvents {
		values[event] = struct{}{}
	}
	return values
}()

type ManifestV1 struct {
	Kind                       string   `json:"kind"`
	ProtocolVersion            string   `json:"protocolVersion"`
	CompatibleProtocolVersions []string `json:"compatibleProtocolVersions"`
	ConnectorKey               string   `json:"connectorKey"`
	DisplayName                string   `json:"displayName"`
	SupportedEvents            []string `json:"supportedEvents"`
	HealthPath                 string   `json:"healthPath"`
}

func NewManifest(key, displayName string, events []string) ManifestV1 {
	return ManifestV1{
		Kind: "manifest", ProtocolVersion: ProtocolVersion,
		CompatibleProtocolVersions: []string{ProtocolVersion},
		ConnectorKey:               key, DisplayName: displayName,
		SupportedEvents: append([]string(nil), events...), HealthPath: "/health/ready",
	}
}

type DeliveryRequestV1 struct {
	Kind            string          `json:"kind"`
	ProtocolVersion string          `json:"protocolVersion"`
	DeliveryID      string          `json:"deliveryId"`
	EventID         string          `json:"eventId"`
	DestinationRef  string          `json:"destinationRef"`
	OccurredAt      string          `json:"occurredAt"`
	Event           json.RawMessage `json:"event"`
}

type DeliveryResultV1 struct {
	Kind            string `json:"kind"`
	ProtocolVersion string `json:"protocolVersion"`
	DeliveryID      string `json:"deliveryId"`
	Status          string `json:"status"`
	ReceivedAt      string `json:"receivedAt"`
}

type ClaimedDelivery struct {
	ID             string
	EventID        string
	Event          json.RawMessage
	Attempt        int
	RetryCycle     int
	DestinationRef string
	IncludeBody    bool
	DeliveryURL    string
	SigningSecret  string
	TenantID       string
	AllowedHosts   map[string]struct{}
}

type DispatchResult struct {
	ResponseStatus *int
	Error          string
}

type Dispatcher interface {
	Dispatch(context.Context, ClaimedDelivery) DispatchResult
}

type HealthTarget struct {
	ID           string
	HealthURL    string
	AllowedHosts map[string]struct{}
}

type HealthResult struct {
	Healthy bool
	Error   string
}

type HealthChecker interface {
	Check(context.Context, HealthTarget) HealthResult
}

type ConnectorType struct {
	Key             string   `json:"key"`
	DisplayName     string   `json:"displayName"`
	ProtocolVersion string   `json:"protocolVersion"`
	SupportedEvents []string `json:"supportedEvents"`
	Enabled         bool     `json:"enabled"`
	HealthStatus    string   `json:"healthStatus"`
	HealthCheckedAt *string  `json:"healthCheckedAt"`
	HealthError     *string  `json:"healthError"`
}

type NotificationConnector struct {
	ID              string  `json:"id"`
	ConnectorType   string  `json:"connectorType"`
	DisplayName     string  `json:"displayName"`
	Name            string  `json:"name"`
	DestinationRef  string  `json:"destinationRef"`
	Enabled         bool    `json:"enabled"`
	IncludeBody     bool    `json:"includeBody"`
	HealthStatus    string  `json:"healthStatus"`
	HealthCheckedAt *string `json:"healthCheckedAt"`
	HealthError     *string `json:"healthError"`
	Version         int     `json:"version"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

type CreateRequest struct {
	ConnectorType  string `json:"connectorType"`
	Name           string `json:"name"`
	DestinationRef string `json:"destinationRef"`
	Enabled        bool   `json:"enabled"`
	IncludeBody    bool   `json:"includeBody"`
}

func (r *CreateRequest) UnmarshalJSON(raw []byte) error {
	type wire struct {
		ConnectorType  string `json:"connectorType"`
		Name           string `json:"name"`
		DestinationRef string `json:"destinationRef"`
		Enabled        *bool  `json:"enabled"`
		IncludeBody    *bool  `json:"includeBody"`
	}
	var value wire
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	r.ConnectorType, r.Name, r.DestinationRef = value.ConnectorType, value.Name, value.DestinationRef
	r.Enabled = true
	if value.Enabled != nil {
		r.Enabled = *value.Enabled
	}
	if value.IncludeBody != nil {
		r.IncludeBody = *value.IncludeBody
	}
	return nil
}

type PatchRequest struct {
	Name           string `json:"name"`
	DestinationRef string `json:"destinationRef"`
	Enabled        bool   `json:"enabled"`
	IncludeBody    bool   `json:"includeBody"`
}

type InstallationInput struct {
	ConnectorKey          string
	DisplayName           string
	ManifestURL           string
	DeliveryURL           string
	HealthURL             string
	AllowedHosts          []string
	SigningSecret         string
	SupportedEvents       []string
	Enabled               bool
	LegacyDestinationRefs map[string]string
}

type ValidatedInstallation struct {
	ID                    string
	ConnectorKey          string
	DisplayName           string
	ManifestURL           string
	DeliveryURL           string
	HealthURL             string
	AllowedHosts          []string
	EncryptedSecret       cryptoutil.EncryptedValue
	SupportedEvents       []string
	Enabled               bool
	LegacyDestinationRefs map[string]string
}

type Store interface {
	ListConnectorTypes(context.Context) ([]ConnectorType, error)
	ListNotificationConnectors(context.Context, auth.ResourceScope) ([]NotificationConnector, error)
	CreateNotificationConnector(context.Context, auth.ResourceScope, CreateRequest) (NotificationConnector, error)
	PatchNotificationConnector(context.Context, auth.ResourceScope, string, int, PatchRequest) (NotificationConnector, error)
	DeleteNotificationConnector(context.Context, auth.ResourceScope, string, int) error
	RegisterConnectorInstallation(context.Context, ValidatedInstallation, *cryptoutil.Cipher) error
}

type Clock func() time.Time
