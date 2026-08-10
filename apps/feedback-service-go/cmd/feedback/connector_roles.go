package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/connector"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
)

func runConnectorRegister() error {
	connectorKey, err := requiredEnvironment("FEEDBACK_CONNECTOR_KEY")
	if err != nil {
		return err
	}
	displayName, err := requiredEnvironment("FEEDBACK_CONNECTOR_DISPLAY_NAME")
	if err != nil {
		return err
	}
	descriptorURL, err := requiredEnvironment("FEEDBACK_CONNECTOR_DESCRIPTOR_URL")
	if err != nil {
		return err
	}
	deliveryURL, err := requiredEnvironment("FEEDBACK_CONNECTOR_DELIVERY_URL")
	if err != nil {
		return err
	}
	sharedSecret, err := requiredEnvironment("FEEDBACK_CONNECTOR_SHARED_SECRET")
	if err != nil {
		return err
	}
	notificationSettings, err := config.ParseNotification(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("connector暗号設定を読み込めません: %w", err)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	manifest, err := connector.FetchManifest(
		ctx, descriptorURL, client, notificationSettings.AllowLocalHTTP,
	)
	if err != nil {
		return fmt.Errorf("connector manifestを取得できません: %w", err)
	}
	events := splitEnvironmentList("FEEDBACK_CONNECTOR_SUPPORTED_EVENTS")
	if len(events) == 0 {
		events = append([]string(nil), manifest.SupportedEvents...)
	}
	if err := connector.ValidateManifest(connectorKey, events, manifest); err != nil {
		return fmt.Errorf("connector manifestを検証できません: %w", err)
	}
	healthURL, err := resolveConnectorHealthURL(descriptorURL, manifest.HealthPath)
	if err != nil {
		return err
	}
	legacyRefs := make(map[string]string)
	if raw, configured := os.LookupEnv("FEEDBACK_CONNECTOR_LEGACY_REF_MAP"); configured {
		if err := decodeStringMap(raw, &legacyRefs); err != nil {
			return fmt.Errorf("FEEDBACK_CONNECTOR_LEGACY_REF_MAP が不正です: %w", err)
		}
	}
	databaseSettings, err := config.ParseDatabase(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("DB設定を読み込めません: %w", err)
	}
	database, err := openRoleDatabase(ctx, databaseSettings)
	if err != nil {
		return err
	}
	defer database.Close()
	cipher, err := cryptoutil.NewCipher(
		notificationSettings.EncryptionKey, notificationSettings.PreviousEncryptionKey,
	)
	if err != nil {
		return fmt.Errorf("connector暗号を初期化できません: %w", err)
	}
	service, err := connector.NewService(database, cipher, notificationSettings.AllowLocalHTTP)
	if err != nil {
		return err
	}
	if err := service.Register(ctx, connector.InstallationInput{
		ConnectorKey: connectorKey, DisplayName: displayName,
		ManifestURL: descriptorURL, DeliveryURL: deliveryURL, HealthURL: healthURL,
		AllowedHosts:  splitEnvironmentList("FEEDBACK_CONNECTOR_ALLOWED_HOSTS"),
		SigningSecret: sharedSecret, SupportedEvents: events,
		Enabled:               environmentValue("FEEDBACK_CONNECTOR_ENABLED", "1") != "0",
		LegacyDestinationRefs: legacyRefs,
	}); err != nil {
		return fmt.Errorf("connector installationを登録できません: %w", err)
	}
	fmt.Printf("Feedback connector registered: key=%s\n", connectorKey)
	return nil
}

func runConnectorRuntime() error {
	provider, err := requiredEnvironment("FEEDBACK_CONNECTOR_PROVIDER")
	if err != nil {
		return err
	}
	provider = strings.ToLower(provider)
	displayName := environmentValue("FEEDBACK_CONNECTOR_DISPLAY_NAME", provider)
	sharedSecret, err := requiredEnvironment("FEEDBACK_CONNECTOR_SHARED_SECRET")
	if err != nil {
		return err
	}
	idempotencyFile, err := requiredEnvironment("FEEDBACK_CONNECTOR_IDEMPOTENCY_FILE")
	if err != nil {
		return err
	}
	destinationsRaw, err := requiredEnvironment("FEEDBACK_CONNECTOR_DESTINATIONS")
	if err != nil {
		return err
	}
	destinations := make(map[string]string)
	if err := decodeStringMap(destinationsRaw, &destinations); err != nil || len(destinations) == 0 {
		return errors.New("FEEDBACK_CONNECTOR_DESTINATIONS は1件以上のstring mapで指定してください")
	}
	port, err := integerEnvironment("FEEDBACK_CONNECTOR_PORT", 8091, 1, 65_535)
	if err != nil {
		return err
	}
	allowLocalHTTP := environmentValue("FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP", "") == "1"
	var dispatcher connector.ReferenceDispatcher
	if provider == "smtp-mail" {
		host, requiredErr := requiredEnvironment("FEEDBACK_SMTP_HOST")
		if requiredErr != nil {
			return requiredErr
		}
		sender, requiredErr := requiredEnvironment("FEEDBACK_SMTP_FROM")
		if requiredErr != nil {
			return requiredErr
		}
		smtpPort, parseErr := integerEnvironment("FEEDBACK_SMTP_PORT", 587, 1, 65_535)
		if parseErr != nil {
			return parseErr
		}
		username := environmentValue("FEEDBACK_SMTP_USERNAME", "")
		password := environmentValue("FEEDBACK_SMTP_PASSWORD", "")
		if username != "" && password == "" {
			return errors.New("FEEDBACK_SMTP_USERNAME 指定時は FEEDBACK_SMTP_PASSWORD が必須です")
		}
		dispatcher, err = connector.NewSMTPReferenceDispatcher(connector.SMTPSettings{
			Host: host, Port: smtpPort, Username: username, Password: password,
			SenderAddress: sender, Destinations: destinations,
		}, nil)
	} else {
		webhookSecret := environmentValue("FEEDBACK_WEBHOOK_SIGNING_SECRET", "")
		dispatcher, err = connector.NewHTTPReferenceDispatcher(connector.ReferenceSettings{
			Provider: provider, Destinations: destinations, AllowLocalHTTP: allowLocalHTTP,
			WebhookSigningSecret: webhookSecret,
		}, &http.Client{Timeout: 15 * time.Second}, time.Now)
	}
	if err != nil {
		return fmt.Errorf("reference connectorを初期化できません: %w", err)
	}
	received, err := connector.NewFileDeliveryIDStore(idempotencyFile, 100_000)
	if err != nil {
		return err
	}
	runtimeHandler, err := connector.NewRuntime(connector.RuntimeSettings{
		Provider: provider, DisplayName: displayName, SharedSecret: sharedSecret,
	}, dispatcher, received, time.Now)
	if err != nil {
		return err
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           runtimeHandler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	logger := processLogger()
	logger.Info("Feedback connector runtimeを起動します", "provider", provider, "address", server.Addr)
	return httpapi.RunLifecycle(ctx, httpapi.Lifecycle{
		Serve: server.ListenAndServe, Shutdown: server.Shutdown, ForceClose: server.Close,
		Timeout: httpapi.MaximumShutdownTimeout, Logger: logger,
	})
}

func resolveConnectorHealthURL(descriptorURL, healthPath string) (string, error) {
	base, err := url.Parse(descriptorURL)
	if err != nil {
		return "", fmt.Errorf("connector descriptor URLが不正です: %w", err)
	}
	reference, err := url.Parse(healthPath)
	if err != nil {
		return "", fmt.Errorf("connector healthPathが不正です: %w", err)
	}
	return base.ResolveReference(reference).String(), nil
}

func requiredEnvironment(name string) (string, error) {
	value, configured := os.LookupEnv(name)
	if !configured || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s が未設定です", name)
	}
	return value, nil
}

func environmentValue(name, fallback string) string {
	if value, configured := os.LookupEnv(name); configured {
		return value
	}
	return fallback
}

func integerEnvironment(name string, fallback, minimum, maximum int) (int, error) {
	raw := environmentValue(name, strconv.Itoa(fallback))
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s は%d..%dの整数で指定してください", name, minimum, maximum)
	}
	return value, nil
}

func splitEnvironmentList(name string) []string {
	raw, configured := os.LookupEnv(name)
	if !configured {
		return nil
	}
	result := make([]string, 0)
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func decodeStringMap(raw string, destination *map[string]string) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if *destination == nil {
		return errors.New("JSON objectが必要です")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return errors.New("JSON値が複数あります")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
