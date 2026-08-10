package notification

import (
	"context"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

type Settings struct {
	WebhookEnabled  bool    `json:"webhookEnabled"`
	WebhookEndpoint *string `json:"webhookEndpoint"`
	IncludeBody     bool    `json:"includeBody"`
	IncludeEvidence bool    `json:"includeEvidence"`
}

type SettingsView struct {
	Settings Settings
	Version  int
}

type StoredSettings struct {
	WebhookEnabled     bool
	EndpointCiphertext []byte
	EndpointNonce      []byte
	IncludeBody        bool
	IncludeEvidence    bool
	Version            int
}

type SettingsUpdate struct {
	WebhookEnabled     bool
	EndpointCiphertext []byte
	EndpointNonce      []byte
	IncludeBody        bool
	IncludeEvidence    bool
}

type Attempt struct {
	RetryCycle     int     `json:"retryCycle"`
	Attempt        int     `json:"attempt"`
	Status         string  `json:"status"`
	ResponseStatus *int    `json:"responseStatus"`
	Error          *string `json:"error"`
	CreatedAt      string  `json:"createdAt"`
}

type Delivery struct {
	ID            string    `json:"id"`
	ConnectorID   *string   `json:"connectorId"`
	ConnectorName *string   `json:"connectorName"`
	EventType     string    `json:"eventType"`
	Status        string    `json:"status"`
	RetryCycle    int       `json:"retryCycle"`
	AttemptCount  int       `json:"attemptCount"`
	AvailableAt   string    `json:"availableAt"`
	DeliveredAt   *string   `json:"deliveredAt"`
	LastError     *string   `json:"lastError"`
	CreatedAt     string    `json:"createdAt"`
	Attempts      []Attempt `json:"attempts"`
}

type ListInput struct {
	Scope       auth.ResourceScope
	Status      *string
	Limit       int
	ConnectorID *string
}

type AdminStore interface {
	GetNotificationSettings(context.Context, auth.ResourceScope) (StoredSettings, error)
	PatchNotificationSettings(context.Context, auth.ResourceScope, int, SettingsUpdate) (StoredSettings, error)
	ListNotificationDeliveries(context.Context, ListInput) ([]Delivery, error)
	RetryNotificationDelivery(context.Context, auth.ResourceScope, string) (Delivery, error)
}

type WorkerStore interface {
	ClaimConnectorHealth(context.Context) (*connector.HealthTarget, error)
	CompleteConnectorHealth(context.Context, string, connector.HealthResult) error
	ClaimConnectorDelivery(context.Context, *cryptoutil.Cipher) (*connector.ClaimedDelivery, error)
	CompleteConnectorDelivery(context.Context, connector.ClaimedDelivery, connector.DispatchResult, int) error
}

type WorkerOptions struct {
	PollInterval time.Duration
	MaxAttempts  int
}
