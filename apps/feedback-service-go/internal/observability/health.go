// Package observability はhealth、metrics、traceの運用interfaceを提供する。
package observability

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const defaultProbeTimeout = 2 * time.Second

// DatabaseReadinessProbe は既存Database.Pingをそのまま利用する最小interfaceである。
type DatabaseReadinessProbe interface {
	Ping(context.Context) error
}

// DatabaseReadinessProbeFunc は関数をdatabase probeとして利用可能にする。
type DatabaseReadinessProbeFunc func(context.Context) error

func (probe DatabaseReadinessProbeFunc) Ping(ctx context.Context) error { return probe(ctx) }

// ReadinessProbe は必須依存のreadinessだけを確認する最小interfaceである。
type ReadinessProbe interface {
	CheckReadiness(context.Context) error
}

// ReadinessProbeFunc は関数をReadinessProbeとして利用可能にする。
type ReadinessProbeFunc func(context.Context) error

func (probe ReadinessProbeFunc) CheckReadiness(ctx context.Context) error { return probe(ctx) }

// NotificationHealth は任意依存notificationの状態とbacklogを表す。
type NotificationHealth struct {
	Status           string
	FailedDeliveries int64
	OutboxLagSeconds float64
}

// NotificationHealthProvider はnotification障害をreadiness failureと分離して取得する。
type NotificationHealthProvider interface {
	NotificationHealth(context.Context) (NotificationHealth, error)
}

// NotificationHealthProviderFunc は関数をproviderとして利用可能にする。
type NotificationHealthProviderFunc func(context.Context) (NotificationHealth, error)

func (provider NotificationHealthProviderFunc) NotificationHealth(ctx context.Context) (NotificationHealth, error) {
	return provider(ctx)
}

// ReadinessDependencies は必須3依存と任意notification依存を区別する。
type ReadinessDependencies struct {
	Database          DatabaseReadinessProbe
	EvidenceStorage   ReadinessProbe
	ExportStorage     ReadinessProbe
	Notification      NotificationHealthProvider
	DependencyTimeout time.Duration
}

type readinessResponse struct {
	Status                       string `json:"status"`
	Database                     string `json:"database"`
	EvidenceStorage              string `json:"evidenceStorage"`
	ExportStorage                string `json:"exportStorage"`
	Notification                 string `json:"notification"`
	NotificationFailedDeliveries string `json:"notificationFailedDeliveries,omitempty"`
	OutboxLagSeconds             string `json:"outboxLagSeconds,omitempty"`
}

// LivenessHandler はprocessがHTTPを処理できる限りliveを返す。
func LivenessHandler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "live"})
	})
}

// ReadinessHandler はDBを先に確認し、storage二系統だけを必須条件として判定する。
func ReadinessHandler(dependencies ReadinessDependencies) http.Handler {
	timeout := dependencies.DependencyTimeout
	if timeout <= 0 {
		timeout = defaultProbeTimeout
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if checkDatabase(request.Context(), timeout, dependencies.Database) != nil {
			writeJSON(writer, http.StatusServiceUnavailable, readinessResponse{
				Status: "unavailable", Database: "unavailable", EvidenceStorage: "unknown",
				ExportStorage: "unknown", Notification: "unknown",
			})
			return
		}

		type result struct {
			name         string
			err          error
			notification NotificationHealth
		}
		results := make(chan result, 3)
		var waitGroup sync.WaitGroup
		for name, probe := range map[string]ReadinessProbe{
			"evidence": dependencies.EvidenceStorage,
			"export":   dependencies.ExportStorage,
		} {
			waitGroup.Add(1)
			go func() {
				defer waitGroup.Done()
				results <- result{name: name, err: checkProbe(request.Context(), timeout, probe)}
			}()
		}
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			health, err := checkNotification(request.Context(), timeout, dependencies.Notification)
			results <- result{name: "notification", err: err, notification: health}
		}()
		go func() {
			waitGroup.Wait()
			close(results)
		}()

		response := readinessResponse{
			Status: "ready", Database: "available", EvidenceStorage: "unknown",
			ExportStorage: "unknown", Notification: "unknown",
		}
		for dependencyResult := range results {
			switch dependencyResult.name {
			case "evidence":
				response.EvidenceStorage = availability(dependencyResult.err)
			case "export":
				response.ExportStorage = availability(dependencyResult.err)
			case "notification":
				response.Notification = notificationStatus(dependencyResult.notification, dependencyResult.err)
				if dependencyResult.err == nil {
					response.NotificationFailedDeliveries = strconv.FormatInt(
						max(dependencyResult.notification.FailedDeliveries, 0), 10,
					)
					response.OutboxLagSeconds = formatDouble(max(dependencyResult.notification.OutboxLagSeconds, 0))
				}
			}
		}
		status := http.StatusOK
		if response.EvidenceStorage != "available" || response.ExportStorage != "available" {
			response.Status = "unavailable"
			status = http.StatusServiceUnavailable
		}
		writeJSON(writer, status, response)
	})
}

func checkDatabase(parent context.Context, timeout time.Duration, database DatabaseReadinessProbe) error {
	if database == nil {
		return errors.New("database readiness probeが未設定です")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	return database.Ping(ctx)
}

func checkProbe(parent context.Context, timeout time.Duration, probe ReadinessProbe) error {
	if probe == nil {
		return errors.New("readiness probeが未設定です")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	return probe.CheckReadiness(ctx)
}

func checkNotification(
	parent context.Context,
	timeout time.Duration,
	provider NotificationHealthProvider,
) (NotificationHealth, error) {
	if provider == nil {
		return NotificationHealth{}, errors.New("notification health providerが未設定です")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	return provider.NotificationHealth(ctx)
}

func availability(err error) string {
	if err != nil {
		return "unavailable"
	}
	return "available"
}

func notificationStatus(health NotificationHealth, err error) string {
	if err != nil {
		return "unavailable"
	}
	if health.FailedDeliveries > 0 {
		return "degraded"
	}
	if health.Status == "available" || health.Status == "degraded" || health.Status == "unavailable" {
		return health.Status
	}
	return "unavailable"
}

func formatDouble(value float64) string {
	rendered := strconv.FormatFloat(value, 'g', -1, 64)
	if !containsFloatMarker(rendered) {
		return rendered + ".0"
	}
	return rendered
}

func containsFloatMarker(value string) bool {
	for _, character := range value {
		if character == '.' || character == 'e' || character == 'E' {
			return true
		}
	}
	return false
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"status":"unavailable"}`)
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}
