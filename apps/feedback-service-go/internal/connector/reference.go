package connector

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

type ReferenceSettings struct {
	Provider             string
	Destinations         map[string]string
	AllowLocalHTTP       bool
	WebhookSigningSecret string
}

type HTTPReferenceDispatcher struct {
	Settings ReferenceSettings
	Client   *http.Client
	Now      Clock
	Policy   EndpointPolicy
}

func NewHTTPReferenceDispatcher(settings ReferenceSettings, client *http.Client, now Clock) (*HTTPReferenceDispatcher, error) {
	if settings.Provider != "webhook" && settings.Provider != "teams" && settings.Provider != "slack" {
		return nil, errors.New("HTTP reference connector providerが不正です")
	}
	if len(settings.Destinations) == 0 {
		return nil, errors.New("connector destinationは1件以上必要です")
	}
	if settings.Provider == "webhook" && javaStringLength(settings.WebhookSigningSecret) < 32 {
		return nil, errors.New("webhook signing secretは32文字以上必要です")
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	if now == nil {
		now = time.Now
	}
	return &HTTPReferenceDispatcher{
		Settings: settings, Client: client, Now: now,
		Policy: EndpointPolicy{AllowLocalHTTP: settings.AllowLocalHTTP},
	}, nil
}

func (d *HTTPReferenceDispatcher) Dispatch(ctx context.Context, delivery DeliveryRequestV1) error {
	raw, ok := d.Settings.Destinations[delivery.DestinationRef]
	if !ok {
		return errors.New("unknown destinationRef")
	}
	endpoint, err := d.Policy.Validate(ctx, raw)
	if err != nil {
		return err
	}
	body, err := renderReferencePayload(d.Settings.Provider, delivery.Event)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Feedback-Delivery-Id", delivery.DeliveryID)
	if d.Settings.Provider == "webhook" {
		timestamp := d.Now().Unix()
		request.Header.Set("X-Feedback-Timestamp", fmt.Sprintf("%d", timestamp))
		request.Header.Set("X-Feedback-Signature", cryptoutil.SignTimestamp([]byte(d.Settings.WebhookSigningSecret), timestamp, body))
	}
	response, err := secureNoRedirectClient(d.Client, d.Policy).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("destination returned HTTP %d", response.StatusCode)
	}
	return nil
}

func renderReferencePayload(provider string, event json.RawMessage) ([]byte, error) {
	if provider == "webhook" {
		// workerが禁止fieldを除去したeventのみを転送する。
		var validated any
		if err := json.Unmarshal(event, &validated); err != nil {
			return nil, err
		}
		return json.Marshal(validated)
	}
	text, err := NotificationText(event)
	if err != nil {
		return nil, err
	}
	payload := map[string]string{"text": text}
	if provider == "teams" {
		payload["type"] = "message"
		payload["summary"] = "Feedback notification"
	}
	return json.Marshal(payload)
}

func NotificationText(raw json.RawMessage) (string, error) {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(raw, &event); err != nil {
		return "", err
	}
	var eventType string
	if err := json.Unmarshal(event["eventType"], &eventType); err != nil {
		return "", err
	}
	var builder strings.Builder
	builder.WriteString(eventType)
	if rawActor, ok := event["actor"]; ok {
		var actor map[string]json.RawMessage
		if err := json.Unmarshal(rawActor, &actor); err != nil {
			return "", err
		}
		if displayName, ok := actor["displayName"]; ok {
			builder.WriteString("\nActor: ")
			builder.WriteString(jsonPrimitiveContent(displayName))
		}
	}
	if body, ok := event["body"]; ok {
		builder.WriteByte('\n')
		builder.WriteString(jsonPrimitiveContent(body))
	}
	if deepLink, ok := event["deepLink"]; ok {
		builder.WriteByte('\n')
		builder.WriteString(jsonPrimitiveContent(deepLink))
	}
	return builder.String(), nil
}

func jsonPrimitiveContent(raw json.RawMessage) string {
	if string(raw) == "null" {
		return "null"
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	return string(raw)
}

type MailDelivery struct {
	From       string
	To         []string
	Subject    string
	Body       string
	DeliveryID string
}

type MailSender interface {
	Send(context.Context, MailDelivery) error
}

type SMTPSettings struct {
	Host          string
	Port          int
	Username      string
	Password      string
	SenderAddress string
	Destinations  map[string]string
}

type SMTPReferenceDispatcher struct {
	Settings SMTPSettings
	Sender   MailSender
}

func NewSMTPReferenceDispatcher(settings SMTPSettings, sender MailSender) (*SMTPReferenceDispatcher, error) {
	if strings.TrimSpace(settings.Host) == "" || settings.Port < 1 || settings.Port > 65535 {
		return nil, errors.New("SMTP endpointが不正です")
	}
	parsedSender, err := mail.ParseAddress(settings.SenderAddress)
	if err != nil {
		return nil, errors.New("SMTP sender addressが不正です")
	}
	if len(settings.Destinations) == 0 {
		return nil, errors.New("SMTP destinationは1件以上必要です")
	}
	if sender == nil {
		sender = &TLSMailSender{Settings: settings}
	}
	settings.SenderAddress = parsedSender.Address
	return &SMTPReferenceDispatcher{Settings: settings, Sender: sender}, nil
}

func (d *SMTPReferenceDispatcher) Dispatch(ctx context.Context, delivery DeliveryRequestV1) error {
	raw, ok := d.Settings.Destinations[delivery.DestinationRef]
	if !ok {
		return errors.New("unknown destinationRef")
	}
	addresses := strings.Split(raw, ",")
	to := make([]string, 0, len(addresses))
	for _, value := range addresses {
		value = strings.TrimSpace(value)
		address, err := mail.ParseAddress(value)
		if err != nil {
			return errors.New("mail destinationが不正です")
		}
		to = append(to, address.Address)
	}
	if len(to) == 0 {
		return errors.New("mail destination is empty")
	}
	var event struct {
		EventType string `json:"eventType"`
	}
	if err := json.Unmarshal(delivery.Event, &event); err != nil {
		return err
	}
	body, err := NotificationText(delivery.Event)
	if err != nil {
		return err
	}
	return d.Sender.Send(ctx, MailDelivery{
		From: d.Settings.SenderAddress, To: to, Subject: "[Feedback] " + event.EventType,
		Body: body, DeliveryID: delivery.DeliveryID,
	})
}

// TLSMailSender はSTARTTLSを必須化したSMTP senderである。
type TLSMailSender struct{ Settings SMTPSettings }

func (s *TLSMailSender) Send(ctx context.Context, delivery MailDelivery) error {
	address := net.JoinHostPort(s.Settings.Host, fmt.Sprintf("%d", s.Settings.Port))
	dialer := net.Dialer{Timeout: 10 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(15 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = connection.SetDeadline(deadline)
	client, err := smtp.NewClient(connection, s.Settings.Host)
	if err != nil {
		_ = connection.Close()
		return err
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); !ok {
		return errors.New("SMTP serverがSTARTTLSを提供していません")
	}
	if err := client.StartTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: s.Settings.Host}); err != nil {
		return err
	}
	if s.Settings.Username != "" {
		if s.Settings.Password == "" {
			return errors.New("SMTP passwordが未設定です")
		}
		if err := client.Auth(smtp.PlainAuth("", s.Settings.Username, s.Settings.Password, s.Settings.Host)); err != nil {
			return err
		}
	}
	if err := client.Mail(delivery.From); err != nil {
		return err
	}
	for _, recipient := range delivery.To {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	message := buildMailMessage(delivery)
	if _, err := writer.Write(message); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func buildMailMessage(delivery MailDelivery) []byte {
	clean := func(value string) string { return strings.NewReplacer("\r", "", "\n", "").Replace(value) }
	var builder strings.Builder
	fmt.Fprintf(&builder, "From: %s\r\n", clean(delivery.From))
	fmt.Fprintf(&builder, "To: %s\r\n", clean(strings.Join(delivery.To, ", ")))
	fmt.Fprintf(&builder, "Subject: %s\r\n", clean(delivery.Subject))
	fmt.Fprintf(&builder, "X-Feedback-Delivery-Id: %s\r\n", clean(delivery.DeliveryID))
	builder.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	builder.WriteString(delivery.Body)
	return []byte(builder.String())
}

// URLHost は登録時のallowlistを組み立てるためにhostを返す。
func URLHost(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return "", errors.New("URL hostが不正です")
	}
	return strings.ToLower(parsed.Hostname()), nil
}
