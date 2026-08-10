package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/backup"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/bootstrap"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/command"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/contract"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	exportdomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/export"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/notification"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/observability"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/retention"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func run(invocation command.Invocation) error {
	switch invocation.Name {
	case command.Service:
		return runService()
	case command.NotificationWorker:
		return runNotificationWorker()
	case command.ExportWorker:
		return runExportWorker()
	case command.RetentionWorker:
		return runRetentionWorker()
	case command.Bootstrap:
		return runBootstrap()
	case command.ConnectorRegister:
		return runConnectorRegister()
	case command.ConnectorRuntime:
		return runConnectorRuntime()
	case command.BackupPull:
		return runBackupPull()
	case command.LegacyMigration:
		return runLegacyMigration(invocation.Args)
	case command.Migrate:
		return runMigrate(invocation.Args)
	default:
		return fmt.Errorf("%sは現在の移行phaseでは未実装です", invocation.Name)
	}
}

func runService() error {
	settings, err := config.Load()
	if err != nil {
		return fmt.Errorf("設定を読み込めません: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()

	database, err := openDatabase(ctx, settings.Database)
	if err != nil {
		return err
	}
	cleanupDatabase := true
	defer func() {
		if cleanupDatabase {
			database.Close()
		}
	}()
	if err := database.Ping(ctx); err != nil {
		return err
	}
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		return fmt.Errorf("DB migration handoffを検証できません: %w", err)
	}

	evidenceStorage, err := objectstore.NewStore(ctx, settings.Evidence.Storage)
	if err != nil {
		return fmt.Errorf("evidence storageを初期化できません: %w", err)
	}
	cleanupEvidence := true
	defer func() {
		if cleanupEvidence {
			_ = evidenceStorage.Close()
		}
	}()
	exportStorage, err := objectstore.NewStore(ctx, settings.Export.Storage)
	if err != nil {
		return fmt.Errorf("export storageを初期化できません: %w", err)
	}
	cleanupExport := true
	defer func() {
		if cleanupExport {
			_ = exportStorage.Close()
		}
	}()

	httpClient := &http.Client{Timeout: 10 * time.Second}
	directKeys, err := auth.NewRemoteKeySetSource(settings.OIDC.JWKSURL, httpClient)
	if err != nil {
		return err
	}
	directVerifier, err := auth.NewDirectVerifier(settings.OIDC, directKeys)
	if err != nil {
		return err
	}
	var exchangeVerifier *auth.ExchangeVerifier
	if settings.TokenExchange != nil {
		exchangeKeys, err := auth.NewRemoteKeySetSource(settings.TokenExchange.JWKSURL, httpClient)
		if err != nil {
			return err
		}
		exchangeVerifier, err = auth.NewExchangeVerifier(*settings.TokenExchange, exchangeKeys)
		if err != nil {
			return err
		}
	}
	authenticator, err := auth.NewAuthenticator(directVerifier, exchangeVerifier, database, database)
	if err != nil {
		return err
	}
	authorizer, err := auth.NewAuthorizer(database, database)
	if err != nil {
		return err
	}
	scopeObserver := func(ctx context.Context, scope auth.ResourceScope) {
		httpapi.WithLogFields(ctx, httpapi.LogFields{
			Tenant: scope.TenantKey, Application: scope.ApplicationKey,
			Environment: scope.EnvironmentKey, Workspace: scope.ExternalWorkspaceKey,
		})
	}
	service, err := usecase.NewService(
		database,
		authorizer,
		settings.Evidence.MaxBytes,
		settings.Evidence.MaxCountPerWorkspace,
		usecase.WithScopeObserver(scopeObserver),
	)
	if err != nil {
		return err
	}
	sessionService, err := session.NewService(database, authorizer, session.WithScopeObserver(scopeObserver))
	if err != nil {
		return err
	}
	evidenceService, err := evidence.NewService(database, evidenceStorage, authorizer, evidence.Settings{
		KeyPrefix: settings.Evidence.Storage.KeyPrefix, MaximumBytes: settings.Evidence.MaxBytes,
		StorageTimeout: 10 * time.Second, OrphanGrace: time.Hour, DeleteAttempts: 3,
	}, evidence.WithScopeObserver(scopeObserver))
	if err != nil {
		return err
	}
	discussionService, err := discussion.NewService(
		database, evidenceService, settings.Evidence.MaxCountPerWorkspace,
		discussion.WithEvidenceCleanupObserver(func(ctx context.Context, attachment evidence.Attachment, err error) {
			logger.ErrorContext(ctx, "evidence objectの回収を保留しました",
				slog.String("objectKey", attachment.ObjectKey), slog.Any("error", err))
		}),
	)
	if err != nil {
		return err
	}
	notificationCipher, err := cryptoutil.NewCipher(
		settings.Notification.EncryptionKey, settings.Notification.PreviousEncryptionKey,
	)
	if err != nil {
		return fmt.Errorf("notification encryptionを初期化できません: %w", err)
	}
	adminService, err := admin.NewService(database, authorizer, admin.WithScopeObserver(scopeObserver))
	if err != nil {
		return err
	}
	exportService, err := exportdomain.NewService(
		database, exportStorage, authorizer, exportdomain.WithScopeObserver(scopeObserver),
	)
	if err != nil {
		return err
	}
	backupService, err := backup.NewService(
		database, exportStorage, authorizer, backup.WithScopeObserver(scopeObserver),
	)
	if err != nil {
		return err
	}
	retentionService, err := retention.NewService(
		database, authorizer, retention.WithScopeObserver(scopeObserver),
	)
	if err != nil {
		return err
	}
	notificationService, err := notification.NewService(
		database, notificationCipher, settings.Notification.AllowLocalHTTP,
	)
	if err != nil {
		return err
	}
	connectorService, err := connector.NewService(
		database, notificationCipher, settings.Notification.AllowLocalHTTP,
	)
	if err != nil {
		return err
	}
	apiHandler, err := httpapi.NewAPIHandler(
		service,
		httpapi.WithSessionAPI(sessionService, database),
		httpapi.WithDiscussionAPI(discussionService, database, authorizer, database, httpapi.DiscussionAPISettings{
			EvidenceMaximumBytes:    settings.Evidence.MaxBytes,
			PrincipalLimitPerMinute: settings.RateLimit.PerPrincipalPerMinute,
			TenantLimitPerMinute:    settings.RateLimit.PerTenantPerMinute,
			IPLimitPerMinute:        settings.RateLimit.PerIPPerMinute,
		}),
		httpapi.WithEvidenceAPI(evidenceService),
		httpapi.WithExportAPI(exportService, discussionService, database),
		httpapi.WithBackupAPI(backupService, database),
		httpapi.WithRetentionAPI(retentionService, database),
		httpapi.WithAdminAPI(adminService, database),
		httpapi.WithNotificationAPI(
			notificationService, connectorService, database, authorizer, discussionService, database,
		),
	)
	if err != nil {
		return err
	}
	if err := apiHandler.ValidateComplete(); err != nil {
		return fmt.Errorf("HTTP APIの配線が不完全です: %w", err)
	}
	metrics, err := observability.NewMetrics(observability.MetricsOptions{Operational: database})
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.Handle("GET /health/live", observability.LivenessHandler())
	mux.Handle("GET /health/ready", observability.ReadinessHandler(observability.ReadinessDependencies{
		Database: database, EvidenceStorage: evidenceStorage, ExportStorage: exportStorage, Notification: database,
	}))
	mux.Handle("GET /metrics", metrics.Handler())
	contract.HandlerWithOptions(apiHandler, contract.StdHTTPServerOptions{
		BaseURL:    "/feedback/v1",
		BaseRouter: mux,
		ErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, bindErr error) {
			httpapi.WriteError(writer, request, httpapi.NewAPIError(
				http.StatusBadRequest, "/problems/request.invalid", "request.invalid", bindErr.Error(),
			))
		},
	})

	var handler http.Handler = mux
	handler = httpapi.AuthenticationMiddleware(authenticator)(handler)
	handler = httpapi.CORSMiddleware(database, logger)(handler)
	handler = httpapi.RecoveryMiddleware(logger)(handler)
	handler = metrics.Middleware(handler)
	handler = httpapi.AccessLogMiddleware(httpapi.AccessLogOptions{Logger: logger})(handler)
	handler = observability.TraceMiddleware(observability.TraceOptions{})(handler)
	handler = httpapi.RequestIDMiddleware(nil)(handler)

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(settings.Service.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	cleanupDatabase = false
	cleanupEvidence = false
	cleanupExport = false
	logger.Info("Feedback Serviceを起動します", slog.String("address", server.Addr))
	return httpapi.RunLifecycle(ctx, httpapi.Lifecycle{
		Serve:      server.ListenAndServe,
		Shutdown:   server.Shutdown,
		ForceClose: server.Close,
		Timeout:    httpapi.MaximumShutdownTimeout,
		Logger:     logger,
		Cleanup: []func(context.Context) error{
			func(context.Context) error { return evidenceStorage.Close() },
			func(context.Context) error { return exportStorage.Close() },
			func(context.Context) error { database.Close(); return nil },
		},
	})
}

func runBootstrap() error {
	databaseSettings, err := config.ParseDatabase(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("DB設定を読み込めません: %w", err)
	}
	input, err := bootstrap.FromEnv()
	if err != nil {
		return fmt.Errorf("bootstrap設定を読み込めません: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := openDatabase(ctx, databaseSettings)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.Ping(ctx); err != nil {
		return err
	}
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		return fmt.Errorf("DB migration handoffを検証できません: %w", err)
	}
	runner, err := bootstrap.NewRunner(database)
	if err != nil {
		return err
	}
	result, err := runner.Run(ctx, input)
	if err != nil {
		return fmt.Errorf("feedback resourceを登録できません: %w", err)
	}
	fmt.Printf(
		"Feedback resources provisioned: tenant=%s application=%s workspace=%s\n",
		result.TenantID, result.ApplicationID, result.WorkspaceID,
	)
	return nil
}

func openDatabase(ctx context.Context, settings config.DatabaseSettings) (*postgres.Database, error) {
	database, err := postgres.Open(ctx, postgres.Config{
		URL: settings.URL, User: settings.User, Password: settings.Password,
		PoolSize: settings.PoolSize, ConnectionTimeout: settings.ConnectionTimeout,
		StatementTimeout: settings.StatementTimeout,
	})
	if err != nil {
		return nil, err
	}
	return database, nil
}
