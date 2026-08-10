package observability

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLivenessHandler(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	LivenessHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/live", nil))
	if recorder.Code != 200 || recorder.Body.String() != `{"status":"live"}` {
		t.Fatalf("livenessが不正です: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestReadinessDependencyMatrix(t *testing.T) {
	t.Parallel()
	databaseAvailable := DatabaseReadinessProbeFunc(func(context.Context) error { return nil })
	databaseUnavailable := DatabaseReadinessProbeFunc(func(context.Context) error { return errors.New("unavailable") })
	available := ReadinessProbeFunc(func(context.Context) error { return nil })
	unavailable := ReadinessProbeFunc(func(context.Context) error { return errors.New("unavailable") })
	availableNotification := NotificationHealthProviderFunc(func(context.Context) (NotificationHealth, error) {
		return NotificationHealth{Status: "available", OutboxLagSeconds: 0}, nil
	})
	tests := []struct {
		name         string
		dependencies ReadinessDependencies
		wantStatus   int
		want         map[string]string
	}{
		{
			name: "all available",
			dependencies: ReadinessDependencies{Database: databaseAvailable, EvidenceStorage: available, ExportStorage: available,
				Notification: availableNotification},
			wantStatus: 200,
			want: map[string]string{"status": "ready", "database": "available", "evidenceStorage": "available",
				"exportStorage": "available", "notification": "available", "notificationFailedDeliveries": "0", "outboxLagSeconds": "0.0"},
		},
		{
			name: "database required",
			dependencies: ReadinessDependencies{Database: databaseUnavailable, EvidenceStorage: available, ExportStorage: available,
				Notification: availableNotification},
			wantStatus: 503,
			want: map[string]string{"status": "unavailable", "database": "unavailable", "evidenceStorage": "unknown",
				"exportStorage": "unknown", "notification": "unknown"},
		},
		{
			name: "evidence required",
			dependencies: ReadinessDependencies{Database: databaseAvailable, EvidenceStorage: unavailable, ExportStorage: available,
				Notification: availableNotification},
			wantStatus: 503,
			want:       map[string]string{"status": "unavailable", "evidenceStorage": "unavailable", "exportStorage": "available"},
		},
		{
			name: "export required",
			dependencies: ReadinessDependencies{Database: databaseAvailable, EvidenceStorage: available, ExportStorage: unavailable,
				Notification: availableNotification},
			wantStatus: 503,
			want:       map[string]string{"status": "unavailable", "evidenceStorage": "available", "exportStorage": "unavailable"},
		},
		{
			name: "notification degraded optional",
			dependencies: ReadinessDependencies{Database: databaseAvailable, EvidenceStorage: available, ExportStorage: available,
				Notification: NotificationHealthProviderFunc(func(context.Context) (NotificationHealth, error) {
					return NotificationHealth{Status: "available", FailedDeliveries: 2, OutboxLagSeconds: 1.5}, nil
				})},
			wantStatus: 200,
			want:       map[string]string{"status": "ready", "notification": "degraded", "notificationFailedDeliveries": "2", "outboxLagSeconds": "1.5"},
		},
		{
			name: "notification unavailable optional",
			dependencies: ReadinessDependencies{Database: databaseAvailable, EvidenceStorage: available, ExportStorage: available,
				Notification: NotificationHealthProviderFunc(func(context.Context) (NotificationHealth, error) {
					return NotificationHealth{}, errors.New("query failed")
				})},
			wantStatus: 200,
			want:       map[string]string{"status": "ready", "notification": "unavailable"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			recorder := httptest.NewRecorder()
			ReadinessHandler(test.dependencies).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
			if recorder.Code != test.wantStatus {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			var response map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			for key, want := range test.want {
				if response[key] != want {
					t.Errorf("response[%s]=%q, want %q: %s", key, response[key], want, recorder.Body.String())
				}
			}
		})
	}
}

func TestReadinessProbeTimeoutFailsClosed(t *testing.T) {
	t.Parallel()
	blocking := DatabaseReadinessProbeFunc(func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	recorder := httptest.NewRecorder()
	ReadinessHandler(ReadinessDependencies{
		Database: blocking, DependencyTimeout: time.Millisecond,
	}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("timeoutをfail-closedにできません: %d", recorder.Code)
	}
}
