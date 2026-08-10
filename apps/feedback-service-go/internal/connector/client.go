package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

type HTTPDispatcher struct {
	Policy  EndpointPolicy
	Client  *http.Client
	Timeout time.Duration
	Now     Clock
}

func NewHTTPDispatcher(policy EndpointPolicy, client *http.Client, timeout time.Duration, now Clock) *HTTPDispatcher {
	if client == nil {
		client = &http.Client{}
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	if now == nil {
		now = time.Now
	}
	return &HTTPDispatcher{Policy: policy, Client: client, Timeout: timeout, Now: now}
}

func (d *HTTPDispatcher) Dispatch(ctx context.Context, delivery ClaimedDelivery) DispatchResult {
	policy := d.Policy
	policy.AllowedHosts = delivery.AllowedHosts
	endpoint, err := policy.Validate(ctx, delivery.DeliveryURL)
	if err != nil {
		return transportFailure(err)
	}
	event, occurredAt, err := sanitizeEvent(delivery.Event, delivery.IncludeBody)
	if err != nil {
		return transportFailure(err)
	}
	envelope := DeliveryRequestV1{
		Kind: "delivery-request", ProtocolVersion: ProtocolVersion,
		DeliveryID: delivery.ID, EventID: delivery.EventID,
		DestinationRef: delivery.DestinationRef, OccurredAt: occurredAt, Event: event,
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return transportFailure(err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, d.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return transportFailure(err)
	}
	timestamp := d.Now().Unix()
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Feedback-Delivery-Id", delivery.ID)
	request.Header.Set("X-Feedback-Timestamp", fmt.Sprintf("%d", timestamp))
	request.Header.Set("X-Feedback-Signature", cryptoutil.SignTimestamp([]byte(delivery.SigningSecret), timestamp, body))
	response, err := secureNoRedirectClient(d.Client, policy).Do(request)
	if err != nil {
		return transportFailure(err)
	}
	defer response.Body.Close()
	status := response.StatusCode
	if status < 200 || status > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return DispatchResult{ResponseStatus: &status, Error: fmt.Sprintf("HTTP %d", status)}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return DispatchResult{ResponseStatus: &status, Error: "connector protocol result is invalid"}
	}
	result := DeliveryResultV1{Kind: "delivery-result", ProtocolVersion: ProtocolVersion}
	if err := decodeStrict(raw, &result); err != nil || result.Kind != "delivery-result" ||
		result.ProtocolVersion != ProtocolVersion || result.DeliveryID != delivery.ID ||
		(result.Status != "accepted" && result.Status != "duplicate") || !jsonNonNullFieldPresent(raw, "receivedAt") {
		return DispatchResult{ResponseStatus: &status, Error: "connector protocol result is invalid"}
	}
	return DispatchResult{ResponseStatus: &status}
}

func jsonFieldPresent(raw []byte, field string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return false
	}
	_, ok := object[field]
	return ok
}

func jsonNonNullFieldPresent(raw []byte, field string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return false
	}
	value, ok := object[field]
	return ok && string(value) != "null"
}

func transportFailure(err error) DispatchResult {
	name := "unknown"
	if err != nil {
		name = fmt.Sprintf("%T", err)
		if index := strings.LastIndex(name, "."); index >= 0 {
			name = name[index+1:]
		}
	}
	return DispatchResult{Error: "connector transport error (" + name + ")"}
}

type HTTPHealthChecker struct {
	Policy  EndpointPolicy
	Client  *http.Client
	Timeout time.Duration
}

func NewHTTPHealthChecker(policy EndpointPolicy, client *http.Client, timeout time.Duration) *HTTPHealthChecker {
	if client == nil {
		client = &http.Client{}
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &HTTPHealthChecker{Policy: policy, Client: client, Timeout: timeout}
}

func (c *HTTPHealthChecker) Check(ctx context.Context, target HealthTarget) HealthResult {
	policy := c.Policy
	policy.AllowedHosts = target.AllowedHosts
	endpoint, err := policy.Validate(ctx, target.HealthURL)
	if err != nil {
		return HealthResult{Error: sanitizeHealthError(err)}
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return HealthResult{Error: sanitizeHealthError(err)}
	}
	response, err := secureNoRedirectClient(c.Client, policy).Do(request)
	if err != nil {
		return HealthResult{Error: sanitizeHealthError(err)}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return HealthResult{Error: fmt.Sprintf("HTTP %d", response.StatusCode)}
	}
	return HealthResult{Healthy: true}
}

func secureNoRedirectClient(source *http.Client, policy EndpointPolicy) *http.Client {
	clone := *source
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var transport *http.Transport
	if source.Transport == nil {
		transport = http.DefaultTransport.(*http.Transport).Clone()
	} else if configured, ok := source.Transport.(*http.Transport); ok {
		transport = configured.Clone()
	}
	if transport != nil {
		dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			connection, err := dialer.DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			remote, ok := connection.RemoteAddr().(*net.TCPAddr)
			if ok && unsafeIP(remote.IP) && !policy.AllowPrivateNetwork && !policy.AllowLocalHTTP {
				_ = connection.Close()
				return nil, errors.New("接続先IPがprivate/localへ変更されました")
			}
			return connection, nil
		}
		clone.Transport = transport
	}
	return &clone
}

func sanitizeHealthError(err error) string {
	reason := strings.NewReplacer("\r", " ", "\n", " ").Replace(err.Error())
	reason = endpointQueryPattern.ReplaceAllString(reason, "$1?<redacted>")
	reason = secretAssignmentPattern.ReplaceAllString(reason, "$1=********")
	reason = takeJavaCharacters(reason, 500)
	return "connector health transport error: " + reason
}

var endpointQueryPattern = regexp.MustCompile(`(https?://[^?\s"]+)\?[^\s"]+`)
var secretAssignmentPattern = regexp.MustCompile(`(?i)(password|passwd|token|secret|authorization|cookie)=[^&\s"]+`)
