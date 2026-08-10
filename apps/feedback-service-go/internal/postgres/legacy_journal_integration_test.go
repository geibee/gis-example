package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLegacyJournalHandoffFingerprintWithPostgreSQL(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w3-admin-legacy" {
		t.Fatal("legacy journal fingerprint統合testはFEEDBACK_TEST_RUN_ID=w3-admin-legacyの専用DBでのみ実行できます")
	}
	if !strings.Contains(databaseURL, "w3_admin_legacy") && !strings.Contains(databaseURL, "w3-admin-legacy") {
		t.Fatal("専用DB名にw3_admin_legacyを含めてください")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := Open(ctx, Config{
		URL: databaseURL, User: os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_USER"),
		Password: os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD"), PoolSize: 2,
		ConnectionTimeout: 5 * time.Second, StatementTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		t.Fatal(err)
	}
}
