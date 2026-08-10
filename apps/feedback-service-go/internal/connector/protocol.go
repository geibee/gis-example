package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

type webhookParticipant struct {
	PrincipalID     string  `json:"principalId"`
	DisplayName     *string `json:"displayName"`
	ParticipantName *string `json:"participantName"`
}

type webhookEvent struct {
	SchemaVersion        string             `json:"schemaVersion"`
	EventID              string             `json:"eventId"`
	RequestID            string             `json:"requestId"`
	EventType            string             `json:"eventType"`
	OccurredAt           string             `json:"occurredAt"`
	TenantKey            string             `json:"tenantKey"`
	ApplicationKey       string             `json:"applicationKey"`
	EnvironmentKey       string             `json:"environmentKey"`
	ExternalWorkspaceKey string             `json:"externalWorkspaceKey"`
	SessionID            string             `json:"sessionId"`
	ThreadID             string             `json:"threadId"`
	Actor                webhookParticipant `json:"actor"`
	DeepLink             *string            `json:"deepLink"`
	Body                 *string            `json:"body"`
	EvidenceURL          *string            `json:"evidenceUrl"`
}

func decodeStrict[T any](raw []byte, target *T) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON末尾に余分な値があります")
		}
		return err
	}
	return nil
}

func ValidateDelivery(delivery DeliveryRequestV1) error {
	if delivery.Kind != "delivery-request" || delivery.ProtocolVersion != ProtocolVersion {
		return errors.New("unsupported protocol")
	}
	if _, err := uuid.Parse(delivery.DeliveryID); err != nil {
		return errors.New("deliveryIdが不正です")
	}
	if _, err := uuid.Parse(delivery.EventID); err != nil {
		return errors.New("eventIdが不正です")
	}
	if strings.TrimSpace(delivery.DestinationRef) == "" || javaStringLength(delivery.DestinationRef) > 200 {
		return errors.New("destinationRefが不正です")
	}
	if _, err := time.Parse(time.RFC3339Nano, delivery.OccurredAt); err != nil {
		return errors.New("occurredAtが不正です")
	}
	event := webhookEvent{SchemaVersion: ProtocolVersion, RequestID: "unknown"}
	if err := decodeStrict(delivery.Event, &event); err != nil {
		return fmt.Errorf("eventが不正です: %w", err)
	}
	if event.SchemaVersion != ProtocolVersion || event.EventID != delivery.EventID || event.OccurredAt != delivery.OccurredAt {
		return errors.New("event envelope mismatch")
	}
	if _, ok := supportedEventSet[event.EventType]; !ok {
		return errors.New("eventTypeが未対応です")
	}
	if event.DeepLink == nil || javaStringLength(*event.DeepLink) > 2000 {
		return errors.New("deepLinkが不正です")
	}
	deepLink, err := url.Parse(*event.DeepLink)
	if err != nil || !deepLink.IsAbs() {
		return errors.New("deepLinkが不正です")
	}
	if event.EvidenceURL != nil {
		return errors.New("evidenceUrlは禁止されています")
	}
	if _, err := uuid.Parse(event.SessionID); err != nil {
		return errors.New("sessionIdが不正です")
	}
	if _, err := uuid.Parse(event.ThreadID); err != nil {
		return errors.New("threadIdが不正です")
	}
	fields := []struct {
		name  string
		value string
		limit int
	}{
		{"requestId", event.RequestID, 200}, {"tenantKey", event.TenantKey, 100},
		{"applicationKey", event.ApplicationKey, 100}, {"environmentKey", event.EnvironmentKey, 100},
		{"externalWorkspaceKey", event.ExternalWorkspaceKey, 200}, {"principalId", event.Actor.PrincipalID, 200},
	}
	for _, field := range fields {
		if strings.TrimSpace(field.value) == "" || javaStringLength(field.value) > field.limit {
			return fmt.Errorf("%sが不正です", field.name)
		}
	}
	if event.Body != nil && javaStringLength(*event.Body) > 20_000 {
		return errors.New("bodyが長すぎます")
	}
	return nil
}

func javaStringLength(value string) int {
	length := 0
	for _, character := range value {
		if character > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func takeJavaCharacters(value string, maximum int) string {
	length := 0
	for index, character := range value {
		width := 1
		if character > 0xffff {
			width = 2
		}
		if length+width > maximum {
			return value[:index]
		}
		length += width
	}
	return value
}

func javaInstant(value time.Time) string {
	value = value.UTC()
	base := value.Format("2006-01-02T15:04:05")
	nanoseconds := value.Nanosecond()
	if nanoseconds == 0 {
		return base + "Z"
	}
	digits := 9
	if nanoseconds%1_000_000 == 0 {
		digits = 3
	} else if nanoseconds%1_000 == 0 {
		digits = 6
	}
	fraction := fmt.Sprintf("%09d", nanoseconds)[:digits]
	return base + "." + fraction + "Z"
}

func IsRetryableResponse(status *int) bool {
	if status == nil {
		return true
	}
	return *status == 408 || *status == 429 || *status >= 500 && *status <= 599
}

func sanitizeEvent(raw json.RawMessage, includeBody bool) (json.RawMessage, string, error) {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, "", fmt.Errorf("connector eventを解釈できません: %w", err)
	}
	delete(event, "evidenceUrl")
	delete(event, "evidence")
	delete(event, "objectKey")
	if !includeBody {
		delete(event, "body")
	}
	var occurredAt string
	if value, ok := event["occurredAt"]; !ok || json.Unmarshal(value, &occurredAt) != nil || occurredAt == "" {
		return nil, "", errors.New("connector eventにoccurredAtがありません")
	}
	encoded, err := json.Marshal(event)
	return encoded, occurredAt, err
}
