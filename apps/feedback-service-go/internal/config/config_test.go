package config

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestParseDefaults(t *testing.T) {
	t.Parallel()

	settings, err := Parse(mapLookup(baseEnvironment()))
	if err != nil {
		t.Fatalf("既定値を読み込めませんでした: %v", err)
	}
	if settings.Service.Port != 8090 {
		t.Fatalf("port: got %d", settings.Service.Port)
	}
	if settings.Database.URL != "jdbc:postgresql://localhost:5432/feedback" || settings.Database.User != "feedback" {
		t.Fatalf("database defaults: %+v", settings.Database)
	}
	if settings.Database.PoolSize != 10 || settings.Database.ConnectionTimeout != 10*time.Second || settings.Database.StatementTimeout != 30*time.Second {
		t.Fatalf("database ranges: %+v", settings.Database)
	}
	if settings.OIDC.JWKSURL != "https://issuer.example/.well-known/jwks.json" {
		t.Fatalf("jwks URL: %q", settings.OIDC.JWKSURL)
	}
	if settings.OIDC.SubjectClaim != "sub" || settings.OIDC.DisplayNameClaim != "name" || settings.OIDC.EmailClaim != "email" {
		t.Fatalf("OIDC claim defaults: %+v", settings.OIDC)
	}
	if settings.TokenExchange != nil {
		t.Fatal("exchange issuer未設定時は無効である必要があります")
	}
	if settings.Evidence.MaxBytes != 10_485_760 || settings.Evidence.MaxCountPerWorkspace != 1000 {
		t.Fatalf("evidence defaults: %+v", settings.Evidence)
	}
	if settings.Evidence.Storage.Mode != StorageModeLocal || settings.Evidence.Storage.KeyPrefix != "evidence/" {
		t.Fatalf("evidence storage defaults: %+v", settings.Evidence.Storage)
	}
	if settings.Export.Storage.Mode != StorageModeLocal || settings.Export.Storage.KeyPrefix != "exports/" {
		t.Fatalf("export storage defaults: %+v", settings.Export.Storage)
	}
	if settings.Export.PollInterval != 2*time.Second || settings.Export.BackupKeyPrefix != "backups/" || settings.Export.BackupMaxAttempts != 5 {
		t.Fatalf("export worker defaults: %+v", settings.Export)
	}
	if settings.RateLimit.PerPrincipalPerMinute != 120 || settings.RateLimit.PerTenantPerMinute != 1200 || settings.RateLimit.PerIPPerMinute != 240 {
		t.Fatalf("rate limit defaults: %+v", settings.RateLimit)
	}
	if len(settings.Notification.EncryptionKey) != 32 || settings.Notification.PreviousEncryptionKey != nil ||
		settings.Notification.PollInterval != 2*time.Second || settings.Notification.MaxAttempts != 5 ||
		settings.Notification.AllowLocalHTTP || settings.Notification.AllowPrivateConnector {
		t.Fatalf("notification key: %+v", settings.Notification)
	}
	if settings.Retention.PollInterval != time.Hour || settings.Retention.OrphanGrace != time.Hour ||
		settings.Retention.BatchSize != 100 || settings.Retention.BackupPrefix != "backups/" {
		t.Fatalf("retention defaults: %+v", settings.Retention)
	}
}

func TestParseFallbackAndOverrides(t *testing.T) {
	t.Parallel()

	environment := baseEnvironment()
	delete(environment, "FEEDBACK_DATABASE_PASSWORD")
	environment["PGPASSWORD"] = "postgres-fallback"
	environment["PGUSER"] = "postgres-user"
	environment["FEEDBACK_PORT"] = "18090"
	environment["FEEDBACK_DATABASE_POOL_SIZE"] = "17"
	environment["FEEDBACK_DATABASE_CONNECTION_TIMEOUT_MS"] = "1200"
	environment["FEEDBACK_DATABASE_STATEMENT_TIMEOUT_MS"] = "4500"
	environment["FEEDBACK_EVIDENCE_MAX_BYTES"] = "4096"
	environment["FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE"] = "7"
	environment["FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE"] = "8"
	environment["FEEDBACK_WRITE_RATE_LIMIT_PER_TENANT_PER_MINUTE"] = "9"
	environment["FEEDBACK_WRITE_RATE_LIMIT_PER_IP_PER_MINUTE"] = "10"
	environment["FEEDBACK_S3_KEY_PREFIX"] = "tenant/evidence"
	environment["FEEDBACK_EXPORT_KEY_PREFIX"] = "tenant/exports"
	environment["FEEDBACK_EXPORT_POLL_MS"] = "1200"
	environment["FEEDBACK_BACKUP_KEY_PREFIX"] = "tenant/backups"
	environment["FEEDBACK_BACKUP_MAX_ATTEMPTS"] = "7"
	environment["FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS"] = encodedKey(2)
	environment["FEEDBACK_NOTIFICATION_POLL_MS"] = "1300"
	environment["FEEDBACK_NOTIFICATION_MAX_ATTEMPTS"] = "8"
	environment["FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP"] = "1"
	environment["FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK"] = "1"

	settings, err := Parse(mapLookup(environment))
	if err != nil {
		t.Fatalf("overrideを読み込めませんでした: %v", err)
	}
	if settings.Database.Password != "postgres-fallback" || settings.Database.User != "postgres-user" {
		t.Fatalf("database fallbackが不一致です: %+v", settings.Database)
	}
	if settings.Service.Port != 18090 || settings.Database.PoolSize != 17 {
		t.Fatalf("numeric overrideが不一致です: service=%+v database=%+v", settings.Service, settings.Database)
	}
	if settings.Database.ConnectionTimeoutMillis != 1200 || settings.Database.StatementTimeoutMillis != 4500 {
		t.Fatalf("timeout millisが不一致です: %+v", settings.Database)
	}
	if settings.Evidence.Storage.KeyPrefix != "tenant/evidence/" || settings.Export.Storage.KeyPrefix != "tenant/exports/" {
		t.Fatalf("prefix末尾slashの補完が不一致です")
	}
	if settings.Export.PollInterval != 1200*time.Millisecond || settings.Export.BackupKeyPrefix != "tenant/backups/" ||
		settings.Export.BackupMaxAttempts != 7 {
		t.Fatalf("export worker overrideが不一致です: %+v", settings.Export)
	}
	if len(settings.Notification.PreviousEncryptionKey) != 32 || settings.Notification.PollInterval != 1300*time.Millisecond ||
		settings.Notification.MaxAttempts != 8 || !settings.Notification.AllowLocalHTTP || !settings.Notification.AllowPrivateConnector {
		t.Fatalf("notification worker overrideが不一致です: %+v", settings.Notification)
	}
}

func TestRoleSpecificParsersDoNotRequireUnrelatedSecrets(t *testing.T) {
	t.Parallel()

	exportSettings, err := ParseExportWorker(mapLookup(map[string]string{
		"FEEDBACK_DATABASE_PASSWORD": "database-secret",
	}))
	if err != nil {
		t.Fatalf("export worker設定を読み込めませんでした: %v", err)
	}
	if exportSettings.Export.PollInterval != 2*time.Second || exportSettings.Evidence.Mode != StorageModeLocal {
		t.Fatalf("export worker defaults = %+v", exportSettings)
	}

	notificationSettings, err := ParseNotificationWorker(mapLookup(map[string]string{
		"FEEDBACK_DATABASE_PASSWORD":           "database-secret",
		"FEEDBACK_NOTIFICATION_ENCRYPTION_KEY": encodedKey(1),
	}))
	if err != nil {
		t.Fatalf("notification worker設定を読み込めませんでした: %v", err)
	}
	if notificationSettings.Notification.PollInterval != 2*time.Second {
		t.Fatalf("notification worker defaults = %+v", notificationSettings)
	}

	legacySettings, err := ParseLegacyMigration(mapLookup(map[string]string{
		"FEEDBACK_DATABASE_PASSWORD": "database-secret",
	}))
	if err != nil {
		t.Fatalf("legacy migration設定を読み込めませんでした: %v", err)
	}
	if legacySettings.Evidence.Mode != StorageModeLocal {
		t.Fatalf("legacy migration defaults = %+v", legacySettings)
	}

	retentionSettings, err := ParseRetentionWorker(mapLookup(map[string]string{
		"FEEDBACK_DATABASE_PASSWORD":    "database-secret",
		"FEEDBACK_RETENTION_POLL_MS":    "2500",
		"FEEDBACK_ORPHAN_GRACE_SECONDS": "600",
	}))
	if err != nil {
		t.Fatalf("retention worker設定を読み込めませんでした: %v", err)
	}
	if retentionSettings.Retention.PollInterval != 2500*time.Millisecond ||
		retentionSettings.Retention.OrphanGrace != 10*time.Minute ||
		retentionSettings.Export.Mode != StorageModeLocal {
		t.Fatalf("retention worker defaults = %+v", retentionSettings)
	}
}

func TestParseTokenExchange(t *testing.T) {
	t.Parallel()

	environment := baseEnvironment()
	environment["FEEDBACK_TOKEN_EXCHANGE_ISSUER"] = "https://broker.example/"
	environment["FEEDBACK_TOKEN_EXCHANGE_AUDIENCE"] = "feedback-service-exchange"
	environment["FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS"] = " https://issuer.example/,https://other.example,https://issuer.example "
	environment["FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS"] = "450"

	settings, err := Parse(mapLookup(environment))
	if err != nil {
		t.Fatalf("token exchange設定を読み込めませんでした: %v", err)
	}
	exchange := settings.TokenExchange
	if exchange == nil {
		t.Fatal("token exchange設定がありません")
	}
	if exchange.Issuer != "https://broker.example" || exchange.JWKSURL != "https://broker.example/.well-known/jwks.json" {
		t.Fatalf("issuer normalizationが不一致です: %+v", exchange)
	}
	if len(exchange.ActorIssuers) != 2 {
		t.Fatalf("actor issuerの重複排除が不一致です: %+v", exchange.ActorIssuers)
	}
	if exchange.MaxLifetime != 450*time.Second {
		t.Fatalf("max lifetime: %s", exchange.MaxLifetime)
	}
}

func TestParseS3Storage(t *testing.T) {
	t.Parallel()

	environment := baseEnvironment()
	environment["FEEDBACK_EVIDENCE_STORAGE"] = "s3"
	environment["FEEDBACK_S3_BUCKET"] = "evidence-bucket"
	environment["FEEDBACK_S3_ENDPOINT_URL"] = "http://minio:9000"
	environment["FEEDBACK_EXPORT_STORAGE"] = "s3"
	environment["FEEDBACK_EXPORT_S3_BUCKET"] = "export-bucket"
	environment["FEEDBACK_EXPORT_S3_ENDPOINT_URL"] = "https://objects.example/path"

	settings, err := Parse(mapLookup(environment))
	if err != nil {
		t.Fatalf("S3設定を読み込めませんでした: %v", err)
	}
	if settings.Evidence.Storage.Bucket != "evidence-bucket" || settings.Export.Storage.Bucket != "export-bucket" {
		t.Fatalf("bucketが不一致です: evidence=%+v export=%+v", settings.Evidence.Storage, settings.Export.Storage)
	}
}

func TestParseRejectsInvalidConfiguration(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		mutate   func(map[string]string)
		contains string
	}{
		{
			name: "DB password未設定",
			mutate: func(values map[string]string) {
				delete(values, "FEEDBACK_DATABASE_PASSWORD")
			},
			contains: "FEEDBACK_DATABASE_PASSWORD",
		},
		{
			name: "空の主DB passwordをfallbackで隠さない",
			mutate: func(values map[string]string) {
				values["FEEDBACK_DATABASE_PASSWORD"] = ""
				values["PGPASSWORD"] = "fallback-must-not-win"
			},
			contains: "FEEDBACK_DATABASE_PASSWORD",
		},
		{
			name: "通知暗号鍵未設定",
			mutate: func(values map[string]string) {
				delete(values, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY")
			},
			contains: "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY",
		},
		{
			name: "通知暗号鍵が短い",
			mutate: func(values map[string]string) {
				values["FEEDBACK_NOTIFICATION_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 31))
			},
			contains: "32 byte",
		},
		{
			name: "OIDC issuerがhttp",
			mutate: func(values map[string]string) {
				values["FEEDBACK_OIDC_ISSUER"] = "http://issuer.example"
			},
			contains: "FEEDBACK_OIDC_ISSUER",
		},
		{
			name: "JWKS URLにuserinfo",
			mutate: func(values map[string]string) {
				values["FEEDBACK_OIDC_JWKS_URL"] = "https://user@example.test/jwks"
			},
			contains: "FEEDBACK_OIDC_JWKS_URL",
		},
		{
			name: "port範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_PORT"] = "65536"
			},
			contains: "FEEDBACK_PORT",
		},
		{
			name: "DB poolが整数でない",
			mutate: func(values map[string]string) {
				values["FEEDBACK_DATABASE_POOL_SIZE"] = "ten"
			},
			contains: "FEEDBACK_DATABASE_POOL_SIZE",
		},
		{
			name: "principal rate limit範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE"] = "0"
			},
			contains: "FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE",
		},
		{
			name: "export poll範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_EXPORT_POLL_MS"] = "99"
			},
			contains: "FEEDBACK_EXPORT_POLL_MS",
		},
		{
			name: "backup attempts範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_BACKUP_MAX_ATTEMPTS"] = "101"
			},
			contains: "FEEDBACK_BACKUP_MAX_ATTEMPTS",
		},
		{
			name: "notification poll範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_NOTIFICATION_POLL_MS"] = "0"
			},
			contains: "FEEDBACK_NOTIFICATION_POLL_MS",
		},
		{
			name: "notification attempts範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_NOTIFICATION_MAX_ATTEMPTS"] = "0"
			},
			contains: "FEEDBACK_NOTIFICATION_MAX_ATTEMPTS",
		},
		{
			name: "evidence count範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE"] = "1000001"
			},
			contains: "FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE",
		},
		{
			name: "S3 bucket未設定",
			mutate: func(values map[string]string) {
				values["FEEDBACK_EVIDENCE_STORAGE"] = "s3"
			},
			contains: "FEEDBACK_S3_BUCKET",
		},
		{
			name: "object storage endpointが不正",
			mutate: func(values map[string]string) {
				values["FEEDBACK_S3_ENDPOINT_URL"] = "file:///tmp/storage"
			},
			contains: "FEEDBACK_S3_ENDPOINT_URL",
		},
		{
			name: "local directoryにNUL",
			mutate: func(values map[string]string) {
				values["FEEDBACK_EVIDENCE_DIR"] = "/data/\x00evidence"
			},
			contains: "FEEDBACK_EVIDENCE_DIR",
		},
		{
			name: "exchange audience未設定",
			mutate: func(values map[string]string) {
				values["FEEDBACK_TOKEN_EXCHANGE_ISSUER"] = "https://broker.example"
				values["FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS"] = "https://issuer.example"
			},
			contains: "FEEDBACK_TOKEN_EXCHANGE_AUDIENCE",
		},
		{
			name: "exchange actor issuerが空",
			mutate: func(values map[string]string) {
				values["FEEDBACK_TOKEN_EXCHANGE_ISSUER"] = "https://broker.example"
				values["FEEDBACK_TOKEN_EXCHANGE_AUDIENCE"] = "exchange"
				values["FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS"] = " , "
			},
			contains: "FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS",
		},
		{
			name: "exchange lifetime範囲外",
			mutate: func(values map[string]string) {
				values["FEEDBACK_TOKEN_EXCHANGE_ISSUER"] = "https://broker.example"
				values["FEEDBACK_TOKEN_EXCHANGE_AUDIENCE"] = "exchange"
				values["FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS"] = "https://issuer.example"
				values["FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS"] = "901"
			},
			contains: "FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := baseEnvironment()
			test.mutate(environment)
			_, err := Parse(mapLookup(environment))
			if err == nil || !strings.Contains(err.Error(), test.contains) {
				t.Fatalf("error=%v; want substring %q", err, test.contains)
			}
		})
	}
}

func TestParseAllowsLocalAndExplicitDevelopmentHTTP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		issuer string
		allow  bool
	}{
		{name: "localhost", issuer: "http://localhost:8080/realms/dev"},
		{name: "IPv4 loopback", issuer: "http://127.0.0.1:8080/realms/dev"},
		{name: "IPv6 loopback", issuer: "http://[::1]:8080/realms/dev"},
		{name: "明示的な開発HTTP", issuer: "http://keycloak:8080/realms/dev", allow: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := baseEnvironment()
			environment["FEEDBACK_OIDC_ISSUER"] = test.issuer
			if test.allow {
				environment["FEEDBACK_ALLOW_INSECURE_HTTP"] = "1"
			}
			settings, err := Parse(mapLookup(environment))
			if err != nil {
				t.Fatalf("開発HTTPを読み込めませんでした: %v", err)
			}
			if settings.OIDC.Issuer != test.issuer {
				t.Fatalf("issuer=%q", settings.OIDC.Issuer)
			}
		})
	}
}

func TestParseDoesNotExposeSecretValue(t *testing.T) {
	t.Parallel()

	environment := baseEnvironment()
	secret := "not-base64-secret-value"
	environment["FEEDBACK_NOTIFICATION_ENCRYPTION_KEY"] = secret
	_, err := Parse(mapLookup(environment))
	if err == nil {
		t.Fatal("不正secretが拒否されませんでした")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("errorにsecretが含まれています: %v", err)
	}
}

func TestParseAcceptsJavaCompatibleUnpaddedBase64Key(t *testing.T) {
	t.Parallel()

	environment := baseEnvironment()
	environment["FEEDBACK_NOTIFICATION_ENCRYPTION_KEY"] = strings.TrimRight(encodedKey(3), "=")
	settings, err := Parse(mapLookup(environment))
	if err != nil {
		t.Fatalf("paddingなしbase64を読み込めませんでした: %v", err)
	}
	if len(settings.Notification.EncryptionKey) != 32 {
		t.Fatalf("key length=%d", len(settings.Notification.EncryptionKey))
	}
}

func baseEnvironment() map[string]string {
	return map[string]string{
		"FEEDBACK_DATABASE_PASSWORD":           "database-secret",
		"FEEDBACK_OIDC_ISSUER":                 "https://issuer.example/",
		"FEEDBACK_OIDC_AUDIENCE":               "feedback-service",
		"FEEDBACK_NOTIFICATION_ENCRYPTION_KEY": encodedKey(1),
	}
}

func encodedKey(value byte) string {
	return base64.StdEncoding.EncodeToString(bytesOf(value, 32))
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return result
}

func mapLookup(values map[string]string) LookupFunc {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
