package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"github.com/geibee/gis-example/apps/feedback-service-go/migrations"
	"github.com/geibee/gis-example/apps/feedback-service-go/migrations/baseline"
)

func runMigrate(arguments []string) error {
	if len(arguments) != 0 {
		return errors.New("feedback-migrateは引数を受け付けません")
	}
	settings, err := config.ParseDatabase(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("migration DB設定を読み込めません: %w", err)
	}
	definitions, err := migrations.Load()
	if err != nil {
		return err
	}
	freshBaseline, err := baseline.Load()
	if err != nil {
		return err
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	database, err := openDatabase(ctx, settings)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.Ping(ctx); err != nil {
		return err
	}
	initialized, err := database.InitializeFreshBaseline(ctx, freshBaseline)
	if err != nil {
		return fmt.Errorf("fresh baselineを初期化できません: %w", err)
	}
	if err := database.ValidateMigrationHandoff(ctx); err != nil {
		return fmt.Errorf("DB migration handoffを検証できません: %w", err)
	}
	if err := database.ApplyGoMigrations(ctx, definitions); err != nil {
		return err
	}
	processLogger().Info("Feedback Go migrationを完了しました",
		"freshBaselineInitialized", initialized, "appliedDefinitions", len(definitions))
	return nil
}
