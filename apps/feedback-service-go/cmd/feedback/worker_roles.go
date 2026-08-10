package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backuppull"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
	workerloop "github.com/geibee/gis-example/apps/feedback-service-go/internal/worker"
)

func runExportWorker() error {
	settings, err := config.ParseExportWorker(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("export worker設定を読み込めません: %w", err)
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	logger := processLogger()
	database, err := openRoleDatabase(ctx, settings.Database)
	if err != nil {
		return err
	}
	defer database.Close()
	evidenceStorage, err := objectstore.NewStore(ctx, settings.Evidence)
	if err != nil {
		return fmt.Errorf("evidence storageを初期化できません: %w", err)
	}
	defer evidenceStorage.Close()
	exportStorage, err := objectstore.NewStore(ctx, settings.Export.Storage)
	if err != nil {
		return fmt.Errorf("export storageを初期化できません: %w", err)
	}
	defer exportStorage.Close()
	backupWorker, err := backup.NewWorker(
		database, evidenceStorage, exportStorage,
		settings.Export.BackupKeyPrefix, settings.Export.BackupMaxAttempts,
	)
	if err != nil {
		return err
	}
	exportWorker, err := exportdomain.NewWorker(database, exportStorage, settings.Export.Storage.KeyPrefix)
	if err != nil {
		return err
	}
	logger.Info("Feedback export/backup workerを起動します")
	return workerloop.Run(ctx, workerloop.Options{
		PollInterval: settings.Export.PollInterval,
		OnError: func(errorContext context.Context, cycleError error) {
			logger.ErrorContext(errorContext, "export/backup worker cycleに失敗しました", slog.Any("error", cycleError))
		},
	}, func(cycleContext context.Context) (bool, error) {
		worked, cycleErr := backupWorker.RunOnce(cycleContext, time.Now())
		if cycleErr != nil || worked {
			return worked, cycleErr
		}
		return exportWorker.RunOnce(cycleContext)
	})
}

func runNotificationWorker() error {
	settings, err := config.ParseNotificationWorker(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("notification worker設定を読み込めません: %w", err)
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	logger := processLogger()
	database, err := openRoleDatabase(ctx, settings.Database)
	if err != nil {
		return err
	}
	defer database.Close()
	cipher, err := cryptoutil.NewCipher(
		settings.Notification.EncryptionKey, settings.Notification.PreviousEncryptionKey,
	)
	if err != nil {
		return fmt.Errorf("notification encryptionを初期化できません: %w", err)
	}
	policy := connector.EndpointPolicy{
		AllowLocalHTTP:      settings.Notification.AllowLocalHTTP,
		AllowPrivateNetwork: settings.Notification.AllowPrivateConnector,
	}
	client := &http.Client{Timeout: 20 * time.Second}
	worker, err := notification.NewWorker(
		database, cipher,
		connector.NewHTTPDispatcher(policy, client, 15*time.Second, time.Now),
		connector.NewHTTPHealthChecker(policy, client, 10*time.Second),
		notification.WorkerOptions{
			PollInterval: settings.Notification.PollInterval,
			MaxAttempts:  settings.Notification.MaxAttempts,
		},
	)
	if err != nil {
		return err
	}
	logger.Info("Feedback notification workerを起動します")
	return workerloop.Run(ctx, workerloop.Options{
		PollInterval: settings.Notification.PollInterval,
		OnError: func(errorContext context.Context, cycleError error) {
			logger.ErrorContext(errorContext, "notification worker cycleに失敗しました", slog.Any("error", cycleError))
		},
	}, worker.RunOnce)
}

func runRetentionWorker() error {
	settings, err := config.ParseRetentionWorker(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("retention worker設定を読み込めません: %w", err)
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	logger := processLogger()
	database, err := openRoleDatabase(ctx, settings.Database)
	if err != nil {
		return err
	}
	defer database.Close()
	evidenceStorage, err := objectstore.NewStore(ctx, settings.Evidence)
	if err != nil {
		return fmt.Errorf("evidence storageを初期化できません: %w", err)
	}
	defer evidenceStorage.Close()
	exportStorage, err := objectstore.NewStore(ctx, settings.Export)
	if err != nil {
		return fmt.Errorf("export storageを初期化できません: %w", err)
	}
	defer exportStorage.Close()
	retentionWorker, err := retention.NewWorker(
		database, evidenceStorage, exportStorage, retention.WorkerSettings{
			EvidencePrefix: settings.Evidence.KeyPrefix,
			ExportPrefix:   settings.Export.KeyPrefix,
			BackupPrefix:   settings.Retention.BackupPrefix,
			OrphanGrace:    settings.Retention.OrphanGrace,
			BatchSize:      settings.Retention.BatchSize,
		},
	)
	if err != nil {
		return err
	}
	logger.Info("Feedback retention workerを起動します")
	return workerloop.Run(ctx, workerloop.Options{
		PollInterval: settings.Retention.PollInterval,
		OnError: func(errorContext context.Context, cycleError error) {
			logger.ErrorContext(errorContext, "retention worker cycleに失敗しました", slog.Any("error", cycleError))
		},
	}, func(cycleContext context.Context) (bool, error) {
		_, cycleErr := retentionWorker.RunOnce(cycleContext, time.Now())
		return false, cycleErr
	})
}

func runBackupPull() error {
	settings, err := backuppull.ParseSettings(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("backup pull設定を読み込めません: %w", err)
	}
	client, err := backuppull.NewClient(&http.Client{Timeout: 5 * time.Minute})
	if err != nil {
		return err
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	if err := client.Run(ctx, settings); err != nil {
		return fmt.Errorf("backup archiveを搬送できません: %w", err)
	}
	return nil
}

func openRoleDatabase(ctx context.Context, settings config.DatabaseSettings) (*postgres.Database, error) {
	database, err := openDatabase(ctx, settings)
	if err != nil {
		return nil, err
	}
	if err := database.Ping(ctx); err != nil {
		database.Close()
		return nil, err
	}
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		database.Close()
		return nil, fmt.Errorf("DB migration handoffを検証できません: %w", err)
	}
	return database, nil
}

func processLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
}
