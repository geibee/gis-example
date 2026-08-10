// Package config は Feedback Service の環境変数契約を型付き設定へ変換する。
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// LookupFunc はテストから環境変数参照を差し替えるための関数である。
type LookupFunc func(string) (string, bool)

// Config は API runtime が起動時に必要とする全設定である。
type Config struct {
	Service       ServiceSettings
	Database      DatabaseSettings
	OIDC          OIDCSettings
	TokenExchange *TokenExchangeSettings
	Evidence      EvidenceSettings
	Export        ExportSettings
	RateLimit     RateLimitSettings
	Notification  NotificationSettings
	Retention     RetentionSettings
}

type ServiceSettings struct {
	Port int
}

type DatabaseSettings struct {
	URL                     string
	User                    string
	Password                string
	PoolSize                int
	ConnectionTimeout       time.Duration
	StatementTimeout        time.Duration
	ConnectionTimeoutMillis int64
	StatementTimeoutMillis  int64
}

type OIDCSettings struct {
	Issuer           string
	Audience         string
	JWKSURL          string
	SubjectClaim     string
	DisplayNameClaim string
	EmailClaim       string
}

type TokenExchangeSettings struct {
	Issuer       string
	Audience     string
	JWKSURL      string
	ActorIssuers map[string]struct{}
	MaxLifetime  time.Duration
}

type StorageMode string

const (
	StorageModeLocal StorageMode = "local"
	StorageModeS3    StorageMode = "s3"
)

type StorageSettings struct {
	Mode           StorageMode
	LocalDirectory string
	Bucket         string
	Region         string
	EndpointURL    string
	KeyPrefix      string
}

type EvidenceSettings struct {
	MaxBytes             int64
	MaxCountPerWorkspace int
	Storage              StorageSettings
}

type ExportSettings struct {
	Storage           StorageSettings
	PollInterval      time.Duration
	BackupKeyPrefix   string
	BackupMaxAttempts int
}

type RateLimitSettings struct {
	PerPrincipalPerMinute int
	PerTenantPerMinute    int
	PerIPPerMinute        int
}

type NotificationSettings struct {
	EncryptionKey         []byte
	PreviousEncryptionKey []byte
	PollInterval          time.Duration
	MaxAttempts           int
	AllowLocalHTTP        bool
	AllowPrivateConnector bool
}

type RetentionSettings struct {
	PollInterval time.Duration
	OrphanGrace  time.Duration
	BatchSize    int
	BackupPrefix string
}

// ExportWorkerConfig はexport/backup workerが使う設定だけを保持する。
type ExportWorkerConfig struct {
	Database DatabaseSettings
	Evidence StorageSettings
	Export   ExportSettings
}

// NotificationWorkerConfig はnotification workerが使う設定だけを保持する。
type NotificationWorkerConfig struct {
	Database     DatabaseSettings
	Notification NotificationSettings
}

// RetentionWorkerConfig はretention workerが使うDB・object storage設定だけを保持する。
type RetentionWorkerConfig struct {
	Database  DatabaseSettings
	Evidence  StorageSettings
	Export    StorageSettings
	Retention RetentionSettings
}

// LegacyMigrationConfig はlegacy migration CLIが使う設定だけを保持する。
type LegacyMigrationConfig struct {
	Database DatabaseSettings
	Evidence StorageSettings
}

// Load は実プロセスの環境変数から設定を読み込む。
func Load() (Config, error) {
	return Parse(os.LookupEnv)
}

// Parse は注入された参照元から設定を読み、既知の不正値をfail-closedで拒否する。
func Parse(lookup LookupFunc) (Config, error) {
	if lookup == nil {
		return Config{}, errors.New("環境変数参照関数が未設定です")
	}

	allowInsecureHTTP := optional(lookup, "FEEDBACK_ALLOW_INSECURE_HTTP", "") == "1"
	database, err := ParseDatabase(lookup)
	if err != nil {
		return Config{}, err
	}
	oidc, err := parseOIDC(lookup, allowInsecureHTTP)
	if err != nil {
		return Config{}, err
	}
	tokenExchange, err := parseTokenExchange(lookup, allowInsecureHTTP)
	if err != nil {
		return Config{}, err
	}
	evidenceStorage, err := parseEvidenceStorage(lookup)
	if err != nil {
		return Config{}, err
	}
	exportStorage, err := parseExportStorage(lookup)
	if err != nil {
		return Config{}, err
	}
	notification, err := ParseNotification(lookup)
	if err != nil {
		return Config{}, err
	}

	port, err := integer(lookup, "FEEDBACK_PORT", 8090, 1, 65_535)
	if err != nil {
		return Config{}, err
	}
	evidenceMaxBytes, err := integer64(lookup, "FEEDBACK_EVIDENCE_MAX_BYTES", 10_485_760, 1, 1<<40)
	if err != nil {
		return Config{}, err
	}
	evidenceMaxCount, err := integer(lookup, "FEEDBACK_EVIDENCE_MAX_COUNT_PER_WORKSPACE", 1000, 1, 1_000_000)
	if err != nil {
		return Config{}, err
	}
	perPrincipal, err := integer(lookup, "FEEDBACK_WRITE_RATE_LIMIT_PER_MINUTE", 120, 1, 10_000)
	if err != nil {
		return Config{}, err
	}
	perTenant, err := integer(lookup, "FEEDBACK_WRITE_RATE_LIMIT_PER_TENANT_PER_MINUTE", 1200, 1, 100_000)
	if err != nil {
		return Config{}, err
	}
	perIP, err := integer(lookup, "FEEDBACK_WRITE_RATE_LIMIT_PER_IP_PER_MINUTE", 240, 1, 100_000)
	if err != nil {
		return Config{}, err
	}
	exportPollMillis, err := integer64(lookup, "FEEDBACK_EXPORT_POLL_MS", 2_000, 100, 3_600_000)
	if err != nil {
		return Config{}, err
	}
	backupMaxAttempts, err := integer(lookup, "FEEDBACK_BACKUP_MAX_ATTEMPTS", 5, 1, 100)
	if err != nil {
		return Config{}, err
	}
	backupKeyPrefix := optional(lookup, "FEEDBACK_BACKUP_KEY_PREFIX", "backups/")
	if !strings.HasSuffix(backupKeyPrefix, "/") {
		backupKeyPrefix += "/"
	}

	return Config{
		Service:       ServiceSettings{Port: port},
		Database:      database,
		OIDC:          oidc,
		TokenExchange: tokenExchange,
		Evidence: EvidenceSettings{
			MaxBytes:             evidenceMaxBytes,
			MaxCountPerWorkspace: evidenceMaxCount,
			Storage:              evidenceStorage,
		},
		Export: ExportSettings{
			Storage: exportStorage, PollInterval: time.Duration(exportPollMillis) * time.Millisecond,
			BackupKeyPrefix: backupKeyPrefix, BackupMaxAttempts: backupMaxAttempts,
		},
		RateLimit: RateLimitSettings{
			PerPrincipalPerMinute: perPrincipal,
			PerTenantPerMinute:    perTenant,
			PerIPPerMinute:        perIP,
		},
		Notification: notification,
		Retention: RetentionSettings{
			PollInterval: time.Hour, OrphanGrace: time.Hour, BatchSize: 100,
			BackupPrefix: backupKeyPrefix,
		},
	}, nil
}

// ParseDatabase はbootstrap/workerがOIDC等を要求せずDB設定だけを読める入口である。
func ParseDatabase(lookup LookupFunc) (DatabaseSettings, error) {
	if lookup == nil {
		return DatabaseSettings{}, errors.New("環境変数参照関数が未設定です")
	}
	password, configured := lookup("FEEDBACK_DATABASE_PASSWORD")
	if configured && strings.TrimSpace(password) == "" {
		return DatabaseSettings{}, errors.New("FEEDBACK_DATABASE_PASSWORD は空にできません")
	}
	if !configured {
		password, configured = lookup("PGPASSWORD")
		if configured && strings.TrimSpace(password) == "" {
			return DatabaseSettings{}, errors.New("PGPASSWORD は空にできません")
		}
	}
	if !configured {
		return DatabaseSettings{}, errors.New("FEEDBACK_DATABASE_PASSWORD (または PGPASSWORD) が未設定です")
	}

	poolSize, err := integer(lookup, "FEEDBACK_DATABASE_POOL_SIZE", 10, 1, 1000)
	if err != nil {
		return DatabaseSettings{}, err
	}
	connectionTimeoutMillis, err := integer64(
		lookup,
		"FEEDBACK_DATABASE_CONNECTION_TIMEOUT_MS",
		10_000,
		1,
		3_600_000,
	)
	if err != nil {
		return DatabaseSettings{}, err
	}
	statementTimeoutMillis, err := integer64(
		lookup,
		"FEEDBACK_DATABASE_STATEMENT_TIMEOUT_MS",
		30_000,
		1,
		86_400_000,
	)
	if err != nil {
		return DatabaseSettings{}, err
	}

	user, configured := lookup("FEEDBACK_DATABASE_USER")
	if !configured {
		user, configured = lookup("PGUSER")
	}
	if !configured {
		user = "feedback"
	}
	if strings.TrimSpace(user) == "" {
		return DatabaseSettings{}, errors.New("FEEDBACK_DATABASE_USER (または PGUSER) は空にできません")
	}

	return DatabaseSettings{
		URL:                     optional(lookup, "FEEDBACK_DATABASE_URL", "jdbc:postgresql://localhost:5432/feedback"),
		User:                    user,
		Password:                password,
		PoolSize:                poolSize,
		ConnectionTimeout:       time.Duration(connectionTimeoutMillis) * time.Millisecond,
		StatementTimeout:        time.Duration(statementTimeoutMillis) * time.Millisecond,
		ConnectionTimeoutMillis: connectionTimeoutMillis,
		StatementTimeoutMillis:  statementTimeoutMillis,
	}, nil
}

// ParseExportWorker はOIDCやnotification secretを要求せずworker設定だけを読む。
func ParseExportWorker(lookup LookupFunc) (ExportWorkerConfig, error) {
	database, err := ParseDatabase(lookup)
	if err != nil {
		return ExportWorkerConfig{}, err
	}
	evidence, err := parseEvidenceStorage(lookup)
	if err != nil {
		return ExportWorkerConfig{}, err
	}
	exportStorage, err := parseExportStorage(lookup)
	if err != nil {
		return ExportWorkerConfig{}, err
	}
	pollMillis, err := integer64(lookup, "FEEDBACK_EXPORT_POLL_MS", 2_000, 100, 3_600_000)
	if err != nil {
		return ExportWorkerConfig{}, err
	}
	maxAttempts, err := integer(lookup, "FEEDBACK_BACKUP_MAX_ATTEMPTS", 5, 1, 100)
	if err != nil {
		return ExportWorkerConfig{}, err
	}
	keyPrefix := optional(lookup, "FEEDBACK_BACKUP_KEY_PREFIX", "backups/")
	if !strings.HasSuffix(keyPrefix, "/") {
		keyPrefix += "/"
	}
	return ExportWorkerConfig{
		Database: database, Evidence: evidence,
		Export: ExportSettings{
			Storage: exportStorage, PollInterval: time.Duration(pollMillis) * time.Millisecond,
			BackupKeyPrefix: keyPrefix, BackupMaxAttempts: maxAttempts,
		},
	}, nil
}

// ParseNotificationWorker はOIDCやobject storageを要求せずworker設定だけを読む。
func ParseNotificationWorker(lookup LookupFunc) (NotificationWorkerConfig, error) {
	database, err := ParseDatabase(lookup)
	if err != nil {
		return NotificationWorkerConfig{}, err
	}
	notification, err := ParseNotification(lookup)
	if err != nil {
		return NotificationWorkerConfig{}, err
	}
	return NotificationWorkerConfig{Database: database, Notification: notification}, nil
}

// ParseRetentionWorker はOIDCやnotification secretを要求せず回収設定だけを読む。
func ParseRetentionWorker(lookup LookupFunc) (RetentionWorkerConfig, error) {
	database, err := ParseDatabase(lookup)
	if err != nil {
		return RetentionWorkerConfig{}, err
	}
	evidenceStorage, err := parseEvidenceStorage(lookup)
	if err != nil {
		return RetentionWorkerConfig{}, err
	}
	exportStorage, err := parseExportStorage(lookup)
	if err != nil {
		return RetentionWorkerConfig{}, err
	}
	pollMillis, err := integer64(lookup, "FEEDBACK_RETENTION_POLL_MS", 3_600_000, 1_000, 86_400_000)
	if err != nil {
		return RetentionWorkerConfig{}, err
	}
	orphanGraceSeconds, err := integer64(lookup, "FEEDBACK_ORPHAN_GRACE_SECONDS", 3_600, 300, 31_536_000)
	if err != nil {
		return RetentionWorkerConfig{}, err
	}
	backupPrefix := optional(lookup, "FEEDBACK_BACKUP_KEY_PREFIX", "backups/")
	if !strings.HasSuffix(backupPrefix, "/") {
		backupPrefix += "/"
	}
	return RetentionWorkerConfig{
		Database: database,
		Evidence: evidenceStorage,
		Export:   exportStorage,
		Retention: RetentionSettings{
			PollInterval: time.Duration(pollMillis) * time.Millisecond,
			OrphanGrace:  time.Duration(orphanGraceSeconds) * time.Second,
			BatchSize:    100,
			BackupPrefix: backupPrefix,
		},
	}, nil
}

// ParseLegacyMigration はOIDCやnotification secretを要求せず移行設定だけを読む。
func ParseLegacyMigration(lookup LookupFunc) (LegacyMigrationConfig, error) {
	database, err := ParseDatabase(lookup)
	if err != nil {
		return LegacyMigrationConfig{}, err
	}
	evidence, err := parseEvidenceStorage(lookup)
	if err != nil {
		return LegacyMigrationConfig{}, err
	}
	return LegacyMigrationConfig{Database: database, Evidence: evidence}, nil
}

func parseOIDC(lookup LookupFunc, allowInsecureHTTP bool) (OIDCSettings, error) {
	issuer, err := required(lookup, "FEEDBACK_OIDC_ISSUER")
	if err != nil {
		return OIDCSettings{}, err
	}
	issuer = strings.TrimRight(issuer, "/")
	if err := validateSecureEndpoint(issuer, "FEEDBACK_OIDC_ISSUER", allowInsecureHTTP); err != nil {
		return OIDCSettings{}, err
	}
	audience, err := required(lookup, "FEEDBACK_OIDC_AUDIENCE")
	if err != nil {
		return OIDCSettings{}, err
	}
	jwksURL := optional(lookup, "FEEDBACK_OIDC_JWKS_URL", issuer+"/.well-known/jwks.json")
	if err := validateSecureEndpoint(jwksURL, "FEEDBACK_OIDC_JWKS_URL", allowInsecureHTTP); err != nil {
		return OIDCSettings{}, err
	}

	return OIDCSettings{
		Issuer:           issuer,
		Audience:         audience,
		JWKSURL:          jwksURL,
		SubjectClaim:     optional(lookup, "FEEDBACK_OIDC_SUBJECT_CLAIM", "sub"),
		DisplayNameClaim: optional(lookup, "FEEDBACK_OIDC_DISPLAY_NAME_CLAIM", "name"),
		EmailClaim:       optional(lookup, "FEEDBACK_OIDC_EMAIL_CLAIM", "email"),
	}, nil
}

func parseTokenExchange(lookup LookupFunc, allowInsecureHTTP bool) (*TokenExchangeSettings, error) {
	issuer, enabled := nonBlank(lookup, "FEEDBACK_TOKEN_EXCHANGE_ISSUER")
	if !enabled {
		return nil, nil
	}
	issuer = strings.TrimRight(issuer, "/")
	if err := validateSecureEndpoint(issuer, "FEEDBACK_TOKEN_EXCHANGE_ISSUER", allowInsecureHTTP); err != nil {
		return nil, err
	}
	audience, err := required(lookup, "FEEDBACK_TOKEN_EXCHANGE_AUDIENCE")
	if err != nil {
		return nil, err
	}
	jwksURL := optional(lookup, "FEEDBACK_TOKEN_EXCHANGE_JWKS_URL", issuer+"/.well-known/jwks.json")
	if err := validateSecureEndpoint(jwksURL, "FEEDBACK_TOKEN_EXCHANGE_JWKS_URL", allowInsecureHTTP); err != nil {
		return nil, err
	}
	rawActorIssuers, err := required(lookup, "FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS")
	if err != nil {
		return nil, err
	}
	actorIssuers := make(map[string]struct{})
	for _, raw := range strings.Split(rawActorIssuers, ",") {
		actorIssuer := strings.TrimRight(strings.TrimSpace(raw), "/")
		if actorIssuer == "" {
			continue
		}
		if err := validateSecureEndpoint(actorIssuer, "FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS", allowInsecureHTTP); err != nil {
			return nil, err
		}
		actorIssuers[actorIssuer] = struct{}{}
	}
	if len(actorIssuers) == 0 {
		return nil, errors.New("FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS は 1 件以上必要です")
	}
	maxLifetimeSeconds, err := integer64(
		lookup,
		"FEEDBACK_TOKEN_EXCHANGE_MAX_LIFETIME_SECONDS",
		300,
		30,
		900,
	)
	if err != nil {
		return nil, err
	}

	return &TokenExchangeSettings{
		Issuer:       issuer,
		Audience:     audience,
		JWKSURL:      jwksURL,
		ActorIssuers: actorIssuers,
		MaxLifetime:  time.Duration(maxLifetimeSeconds) * time.Second,
	}, nil
}

type storageInput struct {
	modeName      string
	localDirName  string
	localDefault  string
	bucketName    string
	regionName    string
	endpointName  string
	prefixName    string
	prefixDefault string
}

func parseEvidenceStorage(lookup LookupFunc) (StorageSettings, error) {
	return parseStorage(lookup, storageInput{
		modeName:      "FEEDBACK_EVIDENCE_STORAGE",
		localDirName:  "FEEDBACK_EVIDENCE_DIR",
		localDefault:  "/data/evidence",
		bucketName:    "FEEDBACK_S3_BUCKET",
		regionName:    "FEEDBACK_S3_REGION",
		endpointName:  "FEEDBACK_S3_ENDPOINT_URL",
		prefixName:    "FEEDBACK_S3_KEY_PREFIX",
		prefixDefault: "evidence/",
	})
}

func parseExportStorage(lookup LookupFunc) (StorageSettings, error) {
	return parseStorage(lookup, storageInput{
		modeName:      "FEEDBACK_EXPORT_STORAGE",
		localDirName:  "FEEDBACK_EXPORT_DIR",
		localDefault:  "/data/exports",
		bucketName:    "FEEDBACK_EXPORT_S3_BUCKET",
		regionName:    "FEEDBACK_EXPORT_S3_REGION",
		endpointName:  "FEEDBACK_EXPORT_S3_ENDPOINT_URL",
		prefixName:    "FEEDBACK_EXPORT_KEY_PREFIX",
		prefixDefault: "exports/",
	})
}

func parseStorage(lookup LookupFunc, input storageInput) (StorageSettings, error) {
	mode := StorageMode(optional(lookup, input.modeName, string(StorageModeLocal)))
	if mode != StorageModeLocal && mode != StorageModeS3 {
		return StorageSettings{}, fmt.Errorf("%s は local または s3 を指定してください", input.modeName)
	}
	bucket := optional(lookup, input.bucketName, "")
	if mode == StorageModeS3 && strings.TrimSpace(bucket) == "" {
		return StorageSettings{}, fmt.Errorf("%s=s3 では %s が必須です", input.modeName, input.bucketName)
	}
	localDirectory := optional(lookup, input.localDirName, input.localDefault)
	if strings.TrimSpace(localDirectory) == "" {
		return StorageSettings{}, fmt.Errorf("%s は空にできません", input.localDirName)
	}
	if strings.ContainsRune(localDirectory, '\x00') {
		return StorageSettings{}, fmt.Errorf("%s にNUL文字は指定できません", input.localDirName)
	}
	if _, err := filepath.Abs(localDirectory); err != nil {
		return StorageSettings{}, fmt.Errorf("%s が不正です: %w", input.localDirName, err)
	}
	endpointURL := optional(lookup, input.endpointName, "")
	if endpointURL != "" {
		if err := validateStorageEndpoint(endpointURL, input.endpointName); err != nil {
			return StorageSettings{}, err
		}
	}
	prefix := optional(lookup, input.prefixName, input.prefixDefault)
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	return StorageSettings{
		Mode:           mode,
		LocalDirectory: localDirectory,
		Bucket:         bucket,
		Region:         optional(lookup, input.regionName, ""),
		EndpointURL:    endpointURL,
		KeyPrefix:      prefix,
	}, nil
}

// ParseNotification はAPI/notification workerで共有する暗号鍵設定を読む。
func ParseNotification(lookup LookupFunc) (NotificationSettings, error) {
	if lookup == nil {
		return NotificationSettings{}, errors.New("環境変数参照関数が未設定です")
	}
	current, err := required(lookup, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY")
	if err != nil {
		return NotificationSettings{}, err
	}
	currentKey, err := decodeEncryptionKey(current, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY")
	if err != nil {
		return NotificationSettings{}, err
	}
	var previousKey []byte
	if previous, ok := nonBlank(lookup, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS"); ok {
		previousKey, err = decodeEncryptionKey(previous, "FEEDBACK_NOTIFICATION_ENCRYPTION_KEY_PREVIOUS")
		if err != nil {
			return NotificationSettings{}, err
		}
	}
	pollMillis, err := integer64(lookup, "FEEDBACK_NOTIFICATION_POLL_MS", 2_000, 100, 3_600_000)
	if err != nil {
		return NotificationSettings{}, err
	}
	maxAttempts, err := integer(lookup, "FEEDBACK_NOTIFICATION_MAX_ATTEMPTS", 5, 1, 100)
	if err != nil {
		return NotificationSettings{}, err
	}
	return NotificationSettings{
		EncryptionKey: currentKey, PreviousEncryptionKey: previousKey,
		PollInterval: time.Duration(pollMillis) * time.Millisecond, MaxAttempts: maxAttempts,
		AllowLocalHTTP:        optional(lookup, "FEEDBACK_NOTIFICATION_ALLOW_LOCAL_HTTP", "") == "1",
		AllowPrivateConnector: optional(lookup, "FEEDBACK_CONNECTOR_ALLOW_PRIVATE_NETWORK", "") == "1",
	}, nil
}

func decodeEncryptionKey(raw, name string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		// Java Base64 decoderと同様にpaddingを省略したbasic base64も受け付ける。
		decoded, err = base64.RawStdEncoding.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("%s は base64 で指定してください", name)
		}
	}
	if len(decoded) != 32 {
		return nil, fmt.Errorf("%s は復号後 32 byte 必須です", name)
	}
	return append([]byte(nil), decoded...), nil
}

func validateSecureEndpoint(raw, name string, allowInsecureHTTP bool) error {
	endpoint, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%s は https URL で指定してください: %w", name, err)
	}
	localHTTP := endpoint.Scheme == "http" && isLoopbackHost(endpoint.Hostname())
	validScheme := endpoint.Scheme == "https" || localHTTP || (allowInsecureHTTP && endpoint.Scheme == "http")
	if !validScheme || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return fmt.Errorf(
			"%s は https URL で指定してください (ローカル開発の HTTP は FEEDBACK_ALLOW_INSECURE_HTTP=1)",
			name,
		)
	}
	return nil
}

func validateStorageEndpoint(raw, name string) error {
	endpoint, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%s は http(s) URL で指定してください: %w", name, err)
	}
	if (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return fmt.Errorf("%s はuserinfoとfragmentを含まない http(s) URLで指定してください", name)
	}
	return nil
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func required(lookup LookupFunc, name string) (string, error) {
	value, ok := nonBlank(lookup, name)
	if !ok {
		return "", fmt.Errorf("%s が未設定です", name)
	}
	return value, nil
}

func nonBlank(lookup LookupFunc, name string) (string, bool) {
	value, ok := lookup(name)
	return value, ok && strings.TrimSpace(value) != ""
}

func optional(lookup LookupFunc, name, fallback string) string {
	if value, ok := lookup(name); ok {
		return value
	}
	return fallback
}

func integer(lookup LookupFunc, name string, fallback, minimum, maximum int) (int, error) {
	raw := optional(lookup, name, strconv.Itoa(fallback))
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s は整数で指定してください: %w", name, err)
	}
	if value < minimum || value > maximum {
		return 0, fmt.Errorf("%s は %d..%d です", name, minimum, maximum)
	}
	return value, nil
}

func integer64(lookup LookupFunc, name string, fallback, minimum, maximum int64) (int64, error) {
	raw := optional(lookup, name, strconv.FormatInt(fallback, 10))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s は整数で指定してください: %w", name, err)
	}
	if value < minimum || value > maximum {
		return 0, fmt.Errorf("%s は %d..%d です", name, minimum, maximum)
	}
	return value, nil
}
