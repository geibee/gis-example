package httpapi

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestRunLifecycleGracefulCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	serveDone := make(chan struct{})
	started := make(chan struct{})
	var eventsMu sync.Mutex
	var events []string
	record := func(value string) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		events = append(events, value)
	}
	lifecycle := Lifecycle{
		Serve: func() error {
			close(started)
			<-serveDone
			return http.ErrServerClosed
		},
		StopIntake: func() { record("stop-intake") },
		Shutdown: func(context.Context) error {
			record("shutdown")
			close(serveDone)
			return nil
		},
		Cleanup: []func(context.Context) error{
			func(context.Context) error { record("cleanup"); return nil },
		},
		Timeout: time.Second,
	}
	result := make(chan error, 1)
	go func() { result <- RunLifecycle(ctx, lifecycle) }()
	<-started
	cancel()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	if len(events) != 3 || events[0] != "stop-intake" || events[1] != "shutdown" || events[2] != "cleanup" {
		t.Fatalf("shutdown順序が不正です: %v", events)
	}
}

func TestRunLifecycleForceClosesAfterShutdownError(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	closed := make(chan struct{})
	forced := false
	lifecycle := Lifecycle{
		Serve: func() error { <-closed; return http.ErrServerClosed },
		Shutdown: func(context.Context) error {
			return errors.New("drain failed")
		},
		ForceClose: func() error {
			forced = true
			close(closed)
			return nil
		},
		Timeout: time.Second,
	}
	cancel()
	err := RunLifecycle(ctx, lifecycle)
	if err == nil || !forced || !stringsContain(err.Error(), "drain failed") {
		t.Fatalf("force close結果が不正です: forced=%t err=%v", forced, err)
	}
}

func TestRunLifecycleRejectsInvalidConfiguration(t *testing.T) {
	t.Parallel()
	validFunctions := Lifecycle{Serve: func() error { return nil }, Shutdown: func(context.Context) error { return nil }}
	tests := []Lifecycle{
		{},
		{Serve: validFunctions.Serve},
		{Serve: validFunctions.Serve, Shutdown: validFunctions.Shutdown, Timeout: MaximumShutdownTimeout + time.Nanosecond},
		{Serve: validFunctions.Serve, Shutdown: validFunctions.Shutdown, Timeout: -time.Second},
	}
	for _, lifecycle := range tests {
		if err := RunLifecycle(t.Context(), lifecycle); err == nil {
			t.Fatalf("不正lifecycleを受理しました: %+v", lifecycle)
		}
	}
}

func TestRunLifecycleRecoversStopIntakePanicAndStillShutsDown(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	serverClosed := make(chan struct{})
	lifecycle := Lifecycle{
		Serve:      func() error { <-serverClosed; return http.ErrServerClosed },
		StopIntake: func() { panic("stop failed") },
		Shutdown: func(context.Context) error {
			close(serverClosed)
			return nil
		},
		Timeout: time.Second,
	}
	cancel()
	err := RunLifecycle(ctx, lifecycle)
	if err == nil || !stringsContain(err.Error(), "stop-intake hook") {
		t.Fatalf("stop-intake panicをerror化できません: %v", err)
	}
}

func stringsContain(value, part string) bool {
	for index := 0; index+len(part) <= len(value); index++ {
		if value[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
