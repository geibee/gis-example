package postgres_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/postgres"
)

func TestDatabasePoolExhaustionTimesOutAndRecovers(t *testing.T) {
	databaseURL := os.Getenv("FEEDBACK_GO_INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEEDBACK_GO_INTEGRATION_DATABASE_URLが未設定です")
	}
	if os.Getenv("FEEDBACK_TEST_RUN_ID") != "w4-pool-exhaustion" {
		t.Fatal("pool枯渇統合testはFEEDBACK_TEST_RUN_ID=w4-pool-exhaustionの専用runでのみ実行できます")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, postgres.Config{
		URL: databaseURL, User: requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_USER"),
		Password: requiredIntegrationEnvironment(t, "FEEDBACK_GO_INTEGRATION_DATABASE_PASSWORD"),
		PoolSize: 1, ConnectionTimeout: 150 * time.Millisecond, StatementTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	var databaseName string
	if err := database.QueryRow(ctx, "SELECT current_database()").Scan(&databaseName); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(databaseName, "feedback") {
		t.Fatalf("Feedback専用DB以外ではpool枯渇testを実行しません: %s", databaseName)
	}

	acquired := make(chan struct{})
	release := make(chan struct{})
	holderDone := make(chan error, 1)
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		holderDone <- database.InTransaction(ctx, func(txCtx context.Context, _ postgres.Tx) error {
			close(acquired)
			select {
			case <-release:
				return nil
			case <-txCtx.Done():
				return txCtx.Err()
			}
		})
	}()

	select {
	case <-acquired:
	case <-ctx.Done():
		t.Fatalf("poolを占有するtransactionを開始できませんでした: %v", ctx.Err())
	}

	startedAt := time.Now()
	err = database.InTransaction(context.Background(), func(context.Context, postgres.Tx) error {
		t.Fatal("pool枯渇中に2本目のtransactionが開始されました")
		return nil
	})
	elapsed := time.Since(startedAt)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("pool枯渇時のerror = %v, want context deadline exceeded", err)
	}
	if elapsed < 100*time.Millisecond || elapsed > time.Second {
		t.Fatalf("pool枯渇timeout = %s, want 100ms以上1s以下", elapsed)
	}

	close(release)
	if err := <-holderDone; err != nil {
		t.Fatalf("占有transactionを解放できませんでした: %v", err)
	}
	if err := database.InTransaction(ctx, func(context.Context, postgres.Tx) error { return nil }); err != nil {
		t.Fatalf("pool解放後にtransactionが回復しませんでした: %v", err)
	}
	if err := database.Ping(ctx); err != nil {
		t.Fatalf("pool解放後にreadinessが回復しませんでした: %v", err)
	}
}
