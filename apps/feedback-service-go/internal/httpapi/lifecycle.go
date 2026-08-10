package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	// MaximumShutdownTimeout は移行計画で固定したprocess終了上限である。
	MaximumShutdownTimeout = 30 * time.Second
)

// Lifecycle はserverと依存resourceの起動・停止境界を明示する。
type Lifecycle struct {
	Serve      func() error
	Shutdown   func(context.Context) error
	ForceClose func() error
	// StopIntakeはclaim loop等をcancelするだけの非blocking hookとする。
	StopIntake   func()
	Cleanup      []func(context.Context) error
	Timeout      time.Duration
	Logger       *slog.Logger
	ShutdownBase context.Context
}

// SignalContext はSIGINT/SIGTERMでcancelされるcontextを返す。
func SignalContext(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}

// RunLifecycle はserver終了またはcontext cancelを契機に30秒以内の停止処理を実行する。
func RunLifecycle(ctx context.Context, lifecycle Lifecycle) error {
	if ctx == nil {
		return errors.New("lifecycle contextがnilです")
	}
	if lifecycle.Serve == nil || lifecycle.Shutdown == nil {
		return errors.New("ServeとShutdownは必須です")
	}
	timeout := lifecycle.Timeout
	if timeout == 0 {
		timeout = MaximumShutdownTimeout
	}
	if timeout < 0 || timeout > MaximumShutdownTimeout {
		return fmt.Errorf("shutdown timeoutは0より大きく%s以下で指定してください", MaximumShutdownTimeout)
	}
	logger := lifecycle.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	serveResult := make(chan error, 1)
	go func() { serveResult <- lifecycle.Serve() }()

	var serveErr error
	serveCompleted := false
	select {
	case serveErr = <-serveResult:
		serveCompleted = true
		logger.ErrorContext(ctx, "HTTP serverが停止処理前に終了しました", slog.Any("error", serveErr))
	case <-ctx.Done():
		logger.InfoContext(ctx, "graceful shutdownを開始します")
	}

	stopErr := stopIntake(lifecycle.StopIntake)
	base := lifecycle.ShutdownBase
	if base == nil {
		base = context.Background()
	}
	shutdownContext, cancel := context.WithTimeout(base, timeout)
	defer cancel()

	shutdownResult := make(chan error, 1)
	go func() { shutdownResult <- lifecycle.Shutdown(shutdownContext) }()
	var shutdownErr error
	select {
	case shutdownErr = <-shutdownResult:
	case <-shutdownContext.Done():
		shutdownErr = fmt.Errorf("graceful shutdownがtimeoutしました: %w", shutdownContext.Err())
	}

	var closeErr error
	if shutdownErr != nil && lifecycle.ForceClose != nil {
		closeErr = forceClose(shutdownContext, lifecycle.ForceClose)
	}

	cleanupErr := runCleanup(shutdownContext, lifecycle.Cleanup)
	if !serveCompleted {
		select {
		case serveErr = <-serveResult:
			serveCompleted = true
		case <-shutdownContext.Done():
			if lifecycle.ForceClose != nil && shutdownErr == nil {
				closeErr = forceClose(shutdownContext, lifecycle.ForceClose)
			}
			serveErr = errors.New("server processがshutdown期限内に終了しませんでした")
		}
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	result := errors.Join(serveErr, stopErr, shutdownErr, closeErr, cleanupErr)
	if result == nil {
		logger.InfoContext(base, "graceful shutdownが完了しました")
	}
	return result
}

func stopIntake(stop func()) (err error) {
	if stop == nil {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("stop-intake hookがpanicしました: %v", recovered)
		}
	}()
	stop()
	return nil
}

func forceClose(ctx context.Context, closeFunction func() error) error {
	result := make(chan error, 1)
	go func() { result <- closeFunction() }()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return errors.New("force closeがshutdown期限内に完了しませんでした")
	}
}

func runCleanup(ctx context.Context, cleanups []func(context.Context) error) error {
	if len(cleanups) == 0 {
		return nil
	}
	errorsByIndex := make([]error, len(cleanups))
	var waitGroup sync.WaitGroup
	for index, cleanup := range cleanups {
		if cleanup == nil {
			continue
		}
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			errorsByIndex[index] = cleanup(ctx)
		}()
	}
	done := make(chan struct{})
	go func() {
		waitGroup.Wait()
		close(done)
	}()
	select {
	case <-done:
		return errors.Join(errorsByIndex...)
	case <-ctx.Done():
		return fmt.Errorf("resource cleanupがshutdown期限内に完了しませんでした: %w", ctx.Err())
	}
}
