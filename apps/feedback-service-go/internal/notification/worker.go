package notification

import (
	"context"
	"errors"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

type Worker struct {
	store         WorkerStore
	cipher        *cryptoutil.Cipher
	dispatcher    connector.Dispatcher
	healthChecker connector.HealthChecker
	options       WorkerOptions
}

func NewWorker(
	store WorkerStore,
	cipher *cryptoutil.Cipher,
	dispatcher connector.Dispatcher,
	healthChecker connector.HealthChecker,
	options WorkerOptions,
) (*Worker, error) {
	if store == nil || cipher == nil || dispatcher == nil || healthChecker == nil {
		return nil, errors.New("notification worker依存が未設定です")
	}
	if options.PollInterval < 100*time.Millisecond || options.PollInterval > time.Hour {
		return nil, errors.New("notification poll intervalは100ms..1hです")
	}
	if options.MaxAttempts < 1 || options.MaxAttempts > 100 {
		return nil, errors.New("notification max attemptsは1..100です")
	}
	return &Worker{
		store: store, cipher: cipher, dispatcher: dispatcher,
		healthChecker: healthChecker, options: options,
	}, nil
}

// RunOnce はhealthを1件確認した後、deliveryを最大1件処理する。
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	worked := false
	target, err := w.store.ClaimConnectorHealth(ctx)
	if err != nil {
		return false, err
	}
	if target != nil {
		worked = true
		result := w.healthChecker.Check(ctx, *target)
		if err := w.store.CompleteConnectorHealth(ctx, target.ID, result); err != nil {
			return true, err
		}
	}
	delivery, err := w.store.ClaimConnectorDelivery(ctx, w.cipher)
	if err != nil {
		return worked, err
	}
	if delivery == nil {
		return worked, nil
	}
	result := w.dispatcher.Dispatch(ctx, *delivery)
	if err := w.store.CompleteConnectorDelivery(ctx, *delivery, result, w.options.MaxAttempts); err != nil {
		return true, err
	}
	return true, nil
}

func (w *Worker) Run(ctx context.Context) error {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			worked, err := w.RunOnce(ctx)
			if err != nil {
				return err
			}
			if worked {
				timer.Reset(0)
			} else {
				timer.Reset(w.options.PollInterval)
			}
		}
	}
}
